# CryptoFlip — Disaster Recovery Playbook

This document is the **authoritative** recovery procedure for the
CryptoFlip backend. It complements the on-call runbook and the
`scripts/backup.sh` automation. Keep it close to the
`BACKEND_PROD_READINESS.md` and review quarterly.

> **Authoritative source**: this file is the contract. The
> automation in `scripts/backup.sh` is built to honor it; deviations
> must update both this file AND the script together.

---

## 1. Backup contract (P2-06)

`scripts/backup.sh` produces a single PostgreSQL dump per day plus
optional WAL base backups. The contract for the dump:

- **Format**: `pg_dump -Fc -Z9` (custom format, max compression).
- **Content**: every table in the public schema, including
  `pgmigrations` (which node-pg-migrate uses to track applied
  migrations). The dump is verified with `pg_restore -l | grep
  pgmigrations` immediately after `pg_dump` finishes; the script
  exits 1 if the table is missing.
- **Retention**: daily dumps kept for 7 days, weekly (Sunday) for
  28 days, monthly (1st) for 365 days. WAL base backups kept 2 days.
- **Location**: `/backups` (Docker volume in production).

### ⚠️ The `pgmigrations` rule — **read this first**

The `pgmigrations` table is the single source of truth for which
migrations have been applied. **It must be present in every backup.**

If a restored database is missing the `pgmigrations` table:

1. The next `npm run migrate` (run from a separate container /
   K8s Job in production) re-applies **all 48 historical migrations**.
2. Several migrations are NOT idempotent — they use `ALTER TABLE
   ... ADD CONSTRAINT` without `IF NOT EXISTS`, `CREATE INDEX` with
   no guard, etc. Re-applying them on a database that already has
   the schema causes **silent data corruption** (e.g., adding a
   `NOT NULL` column without a `DEFAULT` to a populated table fails
   with `23502 — not_null_violation`).
3. The only way to recover is to restore from a known-good backup
   taken BEFORE the bad re-apply. The bad re-apply is not always
   caught by `npm run migrate` because the migration runner only
   logs `error TS` style errors and continues; it doesn't always
   abort on individual SQL errors.

**This is why `pgmigrations` is non-negotiable.** The
verification step in `scripts/backup.sh` is the single point of
detection for a missing-`pgmigrations` bug.

### If `pgmigrations` is missing from a backup

1. **Stop all new backups** (set the cron job to skip until fixed).
2. Investigate `pg_dump` flags. The most common cause is a recent
   addition of `-t table1 -t table2` (selective dump) that didn't
   include `-t pgmigrations`. Per the contract above, **every
   selective-dump mode MUST also pass `-t pgmigrations`**.
3. Manually re-create `pgmigrations` from a known-good backup if
   one is available:

   ```sql
   CREATE TABLE IF NOT EXISTS pgmigrations (
       id SERIAL PRIMARY KEY,
       name varchar(255) NOT NULL UNIQUE,
       run_on timestamp NOT NULL DEFAULT NOW()
   );
   ```

   ...then populate the rows by hand from the migration
   `run_on` timestamps in your log. This is error-prone; prefer
   restoring from a clean backup.

---

## 2. Restoring a database

> **Prerequisites**: you have (1) a known-good `cryptoflip_*.dump`
> file and (2) the operator's `DATABASE_URL` from `.env`.

```bash
# 1. Find the latest good backup
ls -lh /backups/cryptoflip_*.dump | head

# 2. Confirm pgmigrations is in the dump
pg_restore -l /backups/cryptoflip_20260101_120000.dump | grep pgmigrations
# Expected output: line containing "TABLE public pgmigrations"
# If this returns nothing: STOP. The backup is unsafe (see Section 1).

# 3. Stop the backend (so no live connections race the restore)
docker stop coin-master-backend-1

# 4. Drop + recreate the schema (in a separate transient DB if you
#    have one; otherwise use the maintenance DB):
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -u postgres     coin-master-postgres-1     psql -d postgres -c "DROP DATABASE "$POSTGRES_DB";"
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -u postgres     coin-master-postgres-1     psql -d postgres -c "CREATE DATABASE "$POSTGRES_DB" OWNER $POSTGRES_USER;"

# 5. Restore the dump
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -u postgres     coin-master-postgres-1     pg_restore -Fc -d "$POSTGRES_DB" -U "$POSTGRES_USER"     < /backups/cryptoflip_20260101_120000.dump

# 6. Verify pgmigrations is back
docker exec -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -u postgres     coin-master-postgres-1     psql -d "$POSTGRES_DB" -c "SELECT name, run_on FROM pgmigrations ORDER BY id;"
# Expected: 48 rows, one per migration file.

# 7. Run migrations to confirm the schema is consistent
docker exec coin-master-backend-1 npm run migrate
# Expected: 0 migrations applied (pgmigrations already lists all 48).

# 8. Start the backend
docker start coin-master-backend-1
curl -sS http://46.62.247.167:4000/api/health
# Expected: {"status":"ok", ...}
```

If step 6 shows missing migrations OR step 7 applies new
migrations, the dump is incomplete — STOP, restore an earlier
backup, and open an incident.

---

## 3. Recovery time objective (RTO) and recovery point objective (RPO)

| Tier | RPO (max data loss) | RTO (max downtime) | Source |
|---|---|---|---|
| Daily dump | up to 24h | ~30 min (DB restore + backend restart) | `scripts/backup.sh` daily cron |
| Weekly dump | up to 7 days | ~30 min | Sunday copy |
| Monthly dump | up to 30 days | ~30 min | 1st-of-month copy |
| WAL base backup | minutes (with replay) | ~60 min | `pg_basebackup` |

The standard production recovery path is **daily dump**, which
gives a 24h RPO. Operators who need tighter RPO can run
`./scripts/backup.sh full` more frequently (e.g., hourly via a
separate cron) — but at that point a hot-standby replica is
usually the right answer, not a backup cadence.

---

## 4. Runbook: quarterly backup drill

Every 90 days, perform a **disaster recovery drill**:

1. Pick a recent daily dump from `/backups`.
2. Spin up a throwaway postgres container (`docker run --rm -d
   --name drill-postgres -e POSTGRES_PASSWORD=drill
   postgres:16-alpine`).
3. Restore the dump into the drill container.
4. Run `node-pg-migrate up` and confirm 0 migrations apply.
5. Run a smoke-test of the backend against the drill DB.
6. Document the drill in the runbook log; flag any anomalies.

This is the only way to catch a silent backup corruption before a
real incident forces you to use the backup.

---

## 5. Backup and the migration runner (P0-03)

Migration files in `backend/migrations/` are applied by
`backend/src/migrate-cli/run-migrations.ts`, invoked by:

- The `migrate` one-shot service in `docker-compose.yml` (production).
- `npm run migrate` (manual / CI).
- `RUN_MIGRATIONS_ON_BOOT=true` (dev-only, logs a deprecation
  warning).

**The migration runner uses `node-pg-migrate`** which keys on
`pgmigrations.name` (the full filename string). Migrations are
applied in alphabetical order. Duplicate prefixes (e.g. two
`024_*.sql` files) work because the full filename is the key,
but the P2-01 linter (`scripts/lint-migrations.js`) prevents new
duplicates from landing in main.

See `BACKEND_PROD_READINESS.md` P0-03 for the full migration
boot-path rationale.

---

## 6. P2-06 acceptance criteria

A backup script change is **safe to ship** if and only if:

1. The full-database dump includes every table in the public schema
   (verified by `pg_restore -l | wc -l` before vs after).
2. `pgmigrations` is in every dump (verified by the post-dump
   check in `scripts/backup.sh`).
3. The script exits non-zero if the verification step fails
   (rather than continuing to a known-bad backup).
4. The retention policy is unchanged (or any change is documented
   in this file and in the CI runbook).
