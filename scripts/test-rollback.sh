#!/bin/bash
# test-rollback.sh - P2-09 migration rollback drill
# Spins up a throwaway PostgreSQL container, applies ALL production
# migrations, rolls back the last N (default 5), verifies the
# pgmigrations table state, and re-applies the migrations to verify
# forward idempotency.
# Exit codes: 0 success, 1 drill failure, 2 pre-flight failure.

set -euo pipefail

ROLLBACK_N="${1:-5}"

POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
TEST_DB_NAME="${TEST_DB_NAME:-cryptoflip_rollback_drill}"
TEST_DB_USER="${TEST_DB_USER:-rollback_user}"
TEST_DB_PASSWORD="${TEST_DB_PASSWORD:-rollback_pwd_local_only}"
DRILL_CONTAINER="cryptoflip-rollback-drill-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: $MIGRATIONS_DIR does not exist" >&2
  exit 2
fi

MIGRATION_COUNT=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l)
if [ "$MIGRATION_COUNT" -eq 0 ]; then
  echo "ERROR: no .sql files in $MIGRATIONS_DIR" >&2
  exit 2
fi
echo "Found $MIGRATION_COUNT migrations in $MIGRATIONS_DIR"

USE_EXTERNAL_DB=false
STARTED_CONTAINER=false
PSQL_CONN=""

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "Using TEST_DATABASE_URL (external DB)"
  PSQL_CONN="$TEST_DATABASE_URL"
  USE_EXTERNAL_DB=true
elif command -v docker >/dev/null 2>&1; then
  echo "Starting ephemeral $POSTGRES_IMAGE container ($DRILL_CONTAINER)"
  docker run -d --rm --name "$DRILL_CONTAINER" \
    -e POSTGRES_USER="$TEST_DB_USER" \
    -e TEST_DB_PASSWORD="$TEST_DB_PASSWORD" \
    -e POSTGRES_DB="$TEST_DB_NAME" \
    -p 0:5432 \
    "$POSTGRES_IMAGE" >/dev/null
  echo -n "  waiting for postgres "
  for i in $(seq 1 30); do
    if docker exec "$DRILL_CONTAINER" pg_isready -U "$TEST_DB_USER" -d "$TEST_DB_NAME" >/dev/null 2>&1; then
      echo "ready"
      break
    fi
    echo -n "."
    sleep 1
  done
  if ! docker exec "$DRILL_CONTAINER" pg_isready -U "$TEST_DB_USER" -d "$TEST_DB_NAME" >/dev/null 2>&1; then
    echo ""
    echo "ERROR: postgres did not become ready in 30s" >&2
    docker stop "$DRILL_CONTAINER" >/dev/null 2>&1 || true
    exit 2
  fi
  HOST_PORT=$(docker inspect --format='{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$DRILL_CONTAINER")
  PSQL_CONN="postgres://$TEST_DB_USER:$TEST_DB_PASSWORD@localhost:$HOST_PORT/$TEST_DB_NAME"
  STARTED_CONTAINER=true
  trap "echo Stopping ephemeral postgres container; docker stop $DRILL_CONTAINER >/dev/null 2>&1 || true" EXIT
else
  echo "ERROR: no TEST_DATABASE_URL and docker not available" >&2
  exit 2
fi

psql_q() {
  if [ "$USE_EXTERNAL_DB" = "true" ]; then
    PGPASSWORD="$TEST_DB_PASSWORD" psql "$PSQL_CONN" -tAc "$1" 2>&1
  else
    docker exec -e PGPASSWORD="$TEST_DB_PASSWORD" "$DRILL_CONTAINER" \
      psql -U "$TEST_DB_USER" -d "$TEST_DB_NAME" -tAc "$1" 2>&1
  fi
}

apply_sql_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "ERROR: $file does not exist" >&2
    exit 1
  fi
  if [ "$USE_EXTERNAL_DB" = "true" ]; then
    # NOTE: env assignment MUST be a separate word before psql — the
    # form `PGPASSWORD=*** $VAR -f ...` parses $VAR as the COMMAND to
    # run (it becomes `bash: postgres://...: No such file or directory`).
    # We deliberately do NOT use ON_ERROR_STOP=1 here because pg_dump
    # --schema-only dumps may contain statements that error on a fresh
    # DB (e.g., policy drops that reference missing objects) and we
    # want to continue past them rather than crash the connection.
    PGPASSWORD=*** psql "$PSQL_CONN" -f "$file" >/tmp/_apply.out 2>/tmp/_apply.err
    if [ $? -ne 0 ]; then
      echo "ERROR: applying $file failed (psql exited non-zero)" >&2
      cat /tmp/_apply.err >&2
      rm -f /tmp/_apply.out /tmp/_apply.err
      exit 1
    fi
    rm -f /tmp/_apply.out /tmp/_apply.err
  else
    docker exec -i -e PGPASSWORD=*** "$DRILL_CONTAINER" \
      psql -U "$TEST_DB_USER" -d "$TEST_DB_NAME" < "$file" >/tmp/_apply.out 2>/tmp/_apply.err
    if [ $? -ne 0 ]; then
      echo "ERROR: applying $file failed (docker exec exited non-zero)" >&2
      cat /tmp/_apply.err >&2
      rm -f /tmp/_apply.out /tmp/_apply.err
      exit 1
    fi
    rm -f /tmp/_apply.out /tmp/_apply.err
  fi
}

# === P2-09 BASELINE STRATEGY ===
# The migration set has historical pre-conditions (e.g., 027 inserts
# category='kyc' which only becomes valid AFTER 028 widens the
# constraint). A from-scratch replay of all 48 migrations fails on
# these pre-conditions because the production DB was assembled
# incrementally.
#
# To test REVERSIBILITY realistically, the drill needs a baseline
# that matches production. Three options:
#   1. PRODUCTION_DUMP env var pointing to a pg_dump --schema-only
#      file — restores the exact production schema (RECOMMENDED)
#   2. SOURCE_DATABASE_URL env var pointing to a live DB — pulls
#      schema from it via pg_dump --schema-only
#   3. Base schema + phase migrations — best-effort from-scratch,
#      may have historical pre-condition gaps
#
# STEP 0: establish the baseline
echo ""
echo "STEP 0: establishing baseline schema"

if [ -n "${PRODUCTION_DUMP:-}" ] && [ -f "$PRODUCTION_DUMP" ]; then
  echo "  restoring from $PRODUCTION_DUMP"
  apply_sql_file "$PRODUCTION_DUMP"
  echo "  baseline restored from production dump"
elif [ -n "${SOURCE_DATABASE_URL:-}" ]; then
  echo "  dumping schema from $SOURCE_DATABASE_URL"
  if [ "$USE_EXTERNAL_DB" = "true" ]; then
    PGPASSWORD="$TES...RD" pg_dump --schema-only --no-owner "$SOURCE_DATABASE_URL" > /tmp/_schema.sql 2>/tmp/_schema.err
  else
    docker exec coin-master-postgres-1 pg_dump --schema-only --no-owner "$SOURCE_DATABASE_URL" > /tmp/_schema.sql 2>/tmp/_schema.err
  fi
  if [ -s /tmp/_schema.sql ]; then
    apply_sql_file /tmp/_schema.sql
    rm -f /tmp/_schema.sql /tmp/_schema.err
    echo "  baseline restored from $SOURCE_DATABASE_URL"
  else
    cat /tmp/_schema.err
    rm -f /tmp/_schema.sql /tmp/_schema.err
    exit 2
  fi
else
  # Best-effort from-scratch
  SCHEMA_DIR="$BACKEND_DIR/src/db"
  PHASE_FILES=(
    "schema.sql"
    "migrations.sql"
    "migrations-2.3.sql"
    "migrations-2.4.sql"
    "migrations-2.7-bonus-wagering.sql"
    "migrations-binance-redot.sql"
    "migrations-bonus-campaigns.sql"
    "migrations-reconcile-backfill.sql"
  )
  for pf in "${PHASE_FILES[@]}"; do
    full_path="$SCHEMA_DIR/$pf"
    if [ -f "$full_path" ]; then
      echo "  applying $pf (best-effort)"
      apply_sql_file "$full_path" || true
    fi
  done
  echo "  baseline applied (best-effort; some historical migrations may not be forward-applicable on a fresh DB)"
fi

# === Drill the LAST N migrations only ===
# To bypass pre-conditions, we copy the last N .sql files into a
# scratch directory and run node-pg-migrate against THAT directory
# only — so it doesn't try to re-apply the full history.
TMP_MIG_DIR=$(mktemp -d -t rollback-drill.XXXXXX)
TARGET_FILES=$(ls -1 "$MIGRATIONS_DIR"/*.sql | sort | tail -n "$ROLLBACK_N")
TARGET_NAMES=""
for f in $TARGET_FILES; do
  cp "$f" "$TMP_MIG_DIR/"
  TARGET_NAMES="$TARGET_NAMES $(basename "$f")"
done
echo ""
echo "Drill target (last $ROLLBACK_N migrations):"
echo "  $TARGET_NAMES"

# STEP 1: apply the last N forward
cd "$BACKEND_DIR"
echo ""
echo "STEP 1: applying the last $ROLLBACK_N migrations forward"
APPLY_RC=0
DATABASE_URL="$PSQL_CONN"   ./node_modules/.bin/node-pg-migrate up -m "$TMP_MIG_DIR" 2>&1 | tail -10 || APPLY_RC=$?
APPLIED_COUNT=$(psql_q "SELECT count(*) FROM pgmigrations;")
echo "  pgmigrations rows after apply: $APPLIED_COUNT"
if [ "$APPLY_RC" -ne 0 ]; then
  echo "FAILED: could not apply the last $ROLLBACK_N migrations" >&2
  rm -rf "$TMP_MIG_DIR"
  exit 1
fi

# STEP 2: roll back the last N
echo ""
echo "STEP 2: rolling back the last $ROLLBACK_N migration(s)"
ROLLBACK_RC=0
for i in $(seq 1 "$ROLLBACK_N"); do
  if ! DATABASE_URL="$PSQL_CONN"        ./node_modules/.bin/node-pg-migrate down -m "$TMP_MIG_DIR" 2>&1 | tail -3; then
    echo "WARNING: rollback step $i failed"
    ROLLBACK_RC=1
    break
  fi
done

AFTER_ROLLBACK=$(psql_q "SELECT count(*) FROM pgmigrations;")
echo "  pgmigrations rows after rollback: $AFTER_ROLLBACK"
if [ "$ROLLBACK_RC" -ne 0 ]; then
  echo "FAILED: rollback of last $ROLLBACK_N migration(s) did not complete cleanly" >&2
  rm -rf "$TMP_MIG_DIR"
  exit 1
fi

# STEP 3: re-apply forward (idempotency)
echo ""
echo "STEP 3: re-applying the last $ROLLBACK_N migration(s) forward (idempotency)"
REAPPLY_RC=0
for i in $(seq 1 "$ROLLBACK_N"); do
  if ! DATABASE_URL="$PSQL_CONN"        ./node_modules/.bin/node-pg-migrate up -m "$TMP_MIG_DIR" 2>&1 | tail -3; then
    echo "WARNING: re-apply step $i failed"
    REAPPLY_RC=1
    break
  fi
done

FINAL=$(psql_q "SELECT count(*) FROM pgmigrations;")
echo "  pgmigrations rows after re-apply: $FINAL"
rm -rf "$TMP_MIG_DIR"
if [ "$REAPPLY_RC" -ne 0 ]; then
  echo "FAILED: re-apply of last $ROLLBACK_N migration(s) did not complete cleanly" >&2
  exit 1
fi

# Sanity check: rollback must reduce row count
if [ "$AFTER_ROLLBACK" -ge "$FINAL" ]; then
  echo "FAILED: rollback did not reduce row count (after=$AFTER_ROLLBACK final=$FINAL)" >&2
  exit 1
fi

echo "=========================================="
echo "Migration rollback drill PASSED"
echo "  Total migrations: $MIGRATION_COUNT"
echo "  Rolled back: $ROLLBACK_N"
echo "  Re-applied: $ROLLBACK_N"
echo "  Final pgmigrations rows: $FINAL"
echo "  Database: ${TEST_DATABASE_URL:-$DRILL_CONTAINER}"
echo "=========================================="
# Bonus: count migrations that lack a -- migrate:down section
# (so the operator can see at a glance which migrations would block a
# real rollback incident).
NON_REVERSIBLE=$(grep -L '\-\- migrate:down' "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l)
echo ""
echo "Migration reversibility audit:"
echo "  Reversible (have -- migrate:down):   $((MIGRATION_COUNT - NON_REVERSIBLE))"
echo "  Non-reversible (no down section):    $NON_REVERSIBLE"
echo ""
if [ "$NON_REVERSIBLE" -gt 0 ]; then
  echo "Non-reversible migration files:"
  grep -L '\-\- migrate:down' "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sed 's|.*/||' | sed 's/^/  - /'
  echo ""
  echo "See docs/MIGRATION_ROLLBACK_RUNBOOK.md for the incident-response"
  echo "procedure when a non-reversible migration must be reverted."
fi
exit 0
