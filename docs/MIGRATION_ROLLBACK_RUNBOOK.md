# Migration Rollback Runbook

> **Authoritative source**: this runbook is the contract for safely
> reverting a migration in production. The automation in
> `scripts/test-rollback.sh` is built to verify migrations against
> this procedure; any new migration must pass the drill before
> shipping.

This document is the incident-response companion to:

- `docs/DISASTER_RECOVERY.md` — full DB restore procedure
  (use this only when you need to roll back the entire database to
  a known-good snapshot).
- `scripts/test-rollback.sh` — the drill you should run **before**
  authoring any new migration.
- `docs/MIGRATIONS_CONVENTIONS.md` — naming conventions and the
  duplicate-prefix guard.

---

## 1. When to use this runbook

You should follow this runbook when:

1. A migration was applied to production and is causing **active
   harm** (data corruption, outage, security vulnerability).
2. A migration **cannot** be reverted by simply deploying the prior
   backend version (because the new migration has changed the schema
   in a way that the prior code cannot tolerate).
3. The migration has a `-- migrate:down` section in its file (i.e.,
   it is **reversible** — see §3 below).

You should **NOT** use this runbook when:

- The migration is fine and you just want to roll back the **backend
  code** — that's a normal `docker compose up -d --build backend`,
  not a DB rollback. The new schema stays; the old code resumes
  using it.
- The DB itself is corrupt — that's `docs/DISASTER_RECOVERY.md`.

---

## 2. Pre-flight checklist

Before touching production, complete every item:

- [ ] You have the exact migration filename to roll back
      (e.g., `048_wallet_address_index_postgres_sequence.sql`).
- [ ] You have the migration's `-- migrate:down` section in front of
      you. Read it. Understand what it drops.
- [ ] You have a recent `pg_dump` backup that includes the
      `pgmigrations` row for this migration. Verify with
      `pg_restore -l <dump> | grep pgmigrations`.
- [ ] You have run `scripts/test-rollback.sh` on a copy of the
      production schema (use `PRODUCTION_DUMP=<dump>`). The drill
      MUST pass exit code 0.
- [ ] You have a maintenance window scheduled with the on-call
      team. Rolling back a migration is **almost always downtime**.
- [ ] You have a backout plan if the rollback itself fails (usually:
      restore from the most recent `pg_dump`).

If any item is missing, **stop** and resolve it before proceeding.

---

## 3. The reversibility problem

> **P2-09 finding (2026-07-24)**: as of this commit, **33 of 48
> migrations in `backend/migrations/` lack a `-- migrate:down`
> section**. Only 15 migrations are reversible via
> `node-pg-migrate down`.

This means most migrations, once applied to production, **cannot be
rolled back via the standard procedure below**. For non-reversible
migrations, you must restore the database from a backup taken
**before** the bad migration ran.

The list of non-reversible migrations is printed at the end of
`scripts/test-rollback.sh`'s run:

```
Migration reversibility audit:
  Reversible (have -- migrate:down):   15
  Non-reversible (no down section):    33
```

### Which migrations lack `-- migrate:down`?

Run:

```bash
grep -L '\-\- migrate:down' backend/migrations/*.sql
```

The migration list updates as new migrations land. Track new
non-reversible migrations in the quarterly DR drill (§6) — they are
the **highest-risk** artifacts in the codebase.

---

## 4. Step-by-step rollback procedure (reversible migration)

> Pre-flight: §2 is complete. You have the migration filename and
> the `-- migrate:down` section in front of you.

### 4.1 Stop the backend

```bash
# In a separate terminal: stop the backend so no live connections
# race the rollback. Keep the postgres + redis containers up.
docker stop coin-master-backend-1
docker stop coin-master-frontend-1
```

### 4.2 Take a fresh backup (the belt-and-suspenders step)

```bash
cd /root/coin-master
./scripts/backup.sh
# Output: a fresh .dump in /backups/cryptoflip_<DATE>.dump
# This is your fallback if the rollback fails.
```

Verify the backup contains `pgmigrations`:

```bash
pg_restore -l /backups/cryptoflip_<DATE>.dump | grep pgmigrations
# Expected: a line containing "TABLE public pgmigrations".
# If this returns nothing: STOP. The backup is unsafe (see P2-06).
```

### 4.3 Identify the migration to roll back

```bash
# In production
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" coin-master-postgres-1   psql -U cryptoflip -d cryptoflip   -c "SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 5;"
```

Confirm the migration you want to roll back is the LAST one applied
(or Nth from last, if rolling back more than one).

### 4.4 Run the rollback

```bash
docker exec -e DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB   -e POSTGRES_HOST=postgres   coin-master-backend-1   npx ts-node src/migrate-cli/run-migrations.ts down
```

The output should be:

```
[migrate] direction=down dir=/root/coin-master/backend/migrations
Migrations complete!
```

If the rollback fails:

1. The script exits non-zero and prints the underlying PostgreSQL
   error.
2. **STOP** — do not retry blindly. Read the error, decide whether
   it's safe to retry, or whether you need to restore from backup.
3. If the migration's `-- migrate:down` has an error (e.g., it tries
   to DROP a column that other code depends on), you may need to
   restore from the backup taken in §4.2.

### 4.5 Verify the rollback

```bash
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" coin-master-postgres-1   psql -U cryptoflip -d cryptoflip   -c "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 5;"
```

The rolled-back migration should no longer appear. If it does, the
rollback didn't take effect.

Also verify the schema is what you expect:

```bash
# Example for a migration that ADDED a column
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" coin-master-postgres-1   psql -U cryptoflip -d cryptoflip   -c "\d <table_name>"
```

### 4.6 Re-apply (if the rollback was the wrong call)

If you realize after rolling back that you needed the migration
after all (e.g., a downstream migration now fails because its
predecessor is gone), re-apply:

```bash
docker exec -e DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB   -e POSTGRES_HOST=postgres   coin-master-backend-1   npx ts-node src/migrate-cli/run-migrations.ts up
```

### 4.7 Restart the backend

```bash
docker start coin-master-backend-1
docker start coin-master-frontend-1
# Wait for backend health
for i in 1 2 3 4 5 6 7 8 9 10; do
  H=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://46.62.247.167:4000/api/health)
  if [ "$H" = "200" ]; then echo "healthy"; break; fi
  sleep 3
done
```

### 4.8 Communicate and document

1. Post in the on-call channel: "Rolled back migration X at HH:MM UTC.
   Service is healthy."
2. Update `BACKEND_PROD_READINESS.md` if the rollback exposed a
   real issue (e.g., add a P0/P1 task).
3. File an incident report if the rollback caused user-facing
   disruption.

---

## 5. Step-by-step rollback procedure (non-reversible migration)

> **This is a restore-from-backup, not a migration rollback.**

1. **STOP all writes** to the affected tables. The fastest way:
   put the backend in maintenance mode via `admin_settings` or stop
   the backend entirely.
2. **Find a clean backup** — one taken **before** the bad migration
   ran. The daily cron keeps 7 days; weekly keeps 28 days. Use
   `ls -lt /backups/cryptoflip_*.dump | head`.
3. **Verify the backup** with `pg_restore -l | grep pgmigrations` and
   confirm it does NOT contain the bad migration's `pgmigrations` row.
4. **Restore** per `docs/DISASTER_RECOVERY.md` § 2 (the 7-step
   restoration procedure).
5. **Verify** the rolled-back schema is correct.
6. **Restart** the backend with the **prior** backend image (the one
   that was deployed before the bad migration).
7. **Investigate** why the migration wasn't reversible. File a
   follow-up ticket to add `-- migrate:down` to similar migrations.

---

## 6. Quarterly rollback drill

`scripts/test-rollback.sh` is the operator drill. Run it
**quarterly** (every 90 days):

```bash
cd /root/coin-master
# 1. Dump the current production schema
docker exec coin-master-postgres-1 pg_dump --schema-only --no-owner   -U cryptoflip cryptoflip > /tmp/prod_schema.sql

# 2. Run the drill against a throwaway DB
CNAME="cryptoflip-rollback-drill-$$"
docker run -d --rm --name "$CNAME"   -e POSTGRES_USER=rollback_user   -e POSTGRES_PASSWORD=***  -e POSTGRES_DB=cryptoflip_rollback_drill   -p 0:5432   postgres:16-alpine
sleep 4
HOST_PORT=$(docker inspect --format='{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$CNAME")

PRODUCTION_DUMP=/tmp/prod_schema.sql \
  TEST_DATABASE_URL="postgres://rollback_user:***@localhost:$HOST_PORT/cryptoflip_rollback_drill" \
  ./scripts/test-rollback.sh 5

RC=$?
docker stop "$CNAME"
rm /tmp/prod_schema.sql

# 3. File the result in the runbook log
if [ "$RC" -ne 0 ]; then
  echo "$(date -Iseconds): drill FAILED, open an incident" >> docs/MIGRATION_ROLLBACK_DRILL.log
fi
```

Drill failures are **always** significant. They indicate either:

- A new migration lacks `-- migrate:down` (fix: add it).
- A pre-existing non-reversible migration was hit during a real
  incident (the drill is doing its job — file a P0/P1 follow-up).
- The `node-pg-migrate` runner has a bug (rare; file upstream).

---

## 7. Roll forward after a failed rollback

If §4 failed and you restored from backup (§5), the rollback is
**complete** — the bad migration's effects are gone. Now you have
two options for moving forward:

1. **Fix forward**: author a NEW migration that corrects the bug.
   Test it via `scripts/test-rollback.sh` before applying. Apply
   via `npm run migrate`. Document the corrective migration in
   `docs/MIGRATIONS_CONVENTIONS.md`.
2. **Skip forward**: leave the bad migration's effects out of the
   new schema. Add a comment in `docs/MIGRATIONS_CONVENTIONS.md`
   documenting the skipped migration.

Option 1 is preferred. Option 2 only when the migration's effects are
intentionally abandoned (rare).

---

## 8. Related documents

- `docs/DISASTER_RECOVERY.md` — full DB restore (use for §5).
- `docs/MIGRATIONS_CONVENTIONS.md` — naming convention, phase grouping.
- `scripts/test-rollback.sh` — the drill this runbook describes.
- `scripts/backup.sh` — daily + weekly + monthly backups (P2-06).
- `BACKEND_PROD_READINESS.md` — the master task tracker; P2-09 is
  the entry for this runbook.

---

## 9. P2-09 acceptance criteria

This runbook is **complete** if and only if:

1. It exists at `docs/MIGRATION_ROLLBACK_RUNBOOK.md`.
2. The drill (`scripts/test-rollback.sh`) runs cleanly against the
   most recent production schema (operator runs this quarterly).
3. Every newly authored migration has a `-- migrate:down` section
   (enforced by code review; the drill will catch any regression).
4. The reversibility audit count at the bottom of the drill output
   matches the count of `-- migrate:down` strings in
   `backend/migrations/*.sql`.
