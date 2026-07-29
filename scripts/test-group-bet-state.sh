#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  test-group-bet-state.sh — runner for gp-1-01 (live DB)
#  ═══════════════════════════════════════════════════════════════
#
#  Day-1 integration test for the group-bet state machine.
#  Requires the live `coin-master-postgres-1` DB to be reachable.
#  Forwards host:55432 → postgres:5432 via the `gp-pg-fwd` socat
#  container if not already running.
#
#  Usage:
#    ./scripts/test-group-bet-state.sh
#
#  Exit codes:
#    0 — all assertions passed
#    1 — one or more assertions failed
#    2 — prerequisite missing (DB forward, env vars)
#  ═══════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── 1. Ensure host→postgres port-forward ─────────────────────────
if ! nc -z 127.0.0.1 55432 2>/dev/null; then
  echo "[setup] starting socat forward 127.0.0.1:55432 → postgres:5432 …"
  NETWORK=$(docker inspect coin-master-postgres-1 \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' \
    | head -1)
  docker run -d --rm --name gp-pg-fwd \
    --network "$NETWORK" \
    -p 55432:5432 \
    alpine/socat TCP-LISTEN:5432,fork TCP:postgres:5432 \
    > /dev/null
  for i in 1 2 3 4 5; do
    if nc -z 127.0.0.1 55432 2>/dev/null; then break; fi
    sleep 1
  done
fi

# ── 2. Export DATABASE_URL ───────────────────────────────────────
if [ -f "$ROOT/.env" ]; then
  PW=$(grep "^POSTGRES_PASSWORD" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
  USER_=$(grep "^POSTGRES_USER" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
  DB=$(grep "^POSTGRES_DB" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
  export DATABASE_URL="postgresql://$USER_:$PW@127.0.0.1:55432/$DB"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL not set."
  exit 2
fi

# ── 3. Pick two real users for CREATOR + ACTOR ───────────────────
CREATOR_ID=$(docker exec coin-master-postgres-1 \
  psql -U "${USER_:-cryptoflip}" -d "${DB:-cryptoflip}" \
  -tA -c "SELECT id FROM users WHERE is_active=true LIMIT 1 OFFSET 0")
ACTOR_ID=$(docker exec coin-master-postgres-1 \
  psql -U "${USER_:-cryptoflip}" -d "${DB:-cryptoflip}" \
  -tA -c "SELECT id FROM users WHERE is_active=true LIMIT 1 OFFSET 1")

if [ -z "$CREATOR_ID" ] || [ -z "$ACTOR_ID" ]; then
  echo "FATAL: no two active users found in DB for test fixtures."
  exit 2
fi

export TEST_CREATOR_ID="$CREATOR_ID"
export TEST_ACTOR_ID="$ACTOR_ID"

echo "[run] DATABASE_URL=$DATABASE_URL"
echo "[run] CREATOR_ID=$CREATOR_ID  ACTOR_ID=$ACTOR_ID"
echo

# ── 4. Run the test (NO --require setup.ts) ─────────────────────
cd "$ROOT/backend"
exec npx ts-node ./src/test/gp-1-01-group-bet-state.test.ts
