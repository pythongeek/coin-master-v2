# WO-2 Server Application Runbook

> Authoritative source for applying the WO-2 (Prisma financial schema)
> migration to the cx23 production host. The automation in
> `.github/workflows/deploy.yml` follows the same sequence — this
> document is the manual counterpart for `workflow_dispatch` runs and
> for operator-driven deploys when the auto-deploy gate is paused.

The deploy script (`deploy.yml`'s "Deploy via ssh (backup → migrate → up)"
step) is the canonical path. Read this runbook when:

- You're about to dispatch a manual deploy with the new migration
- The auto-deploy is paused and you need to do it by hand
- You're recovering from a failed auto-deploy

---

## What WO-2 ships (so you know what you're applying)

| File | Effect |
|---|---|
| `049_prisma_financial_schema.sql` | 7 enums + 8 tables (currencies, exchange_rates, rate_locks, deposit_transactions, custom_rate_configs, user_balances, ledger_entries, admin_actions) |
| `050_prisma_financial_schema_seed.sql` | USDT row seeded with `id = 00000000-0000-0000-0000-000000000001` (the UUID `deposit.service.ts:17` hardcodes) |
| `051_deposit_blockchain_tx_id_unique.sql` | Partial unique index on `deposit_transactions(blockchain_tx_id) WHERE blockchain_tx_id IS NOT NULL` |

These are additive — no existing tables are modified, no rows are deleted.
A `node-pg-migrate up` against an already-migrated DB is a no-op
(verified locally: `No migrations to run!`).

---

## The sequence (matches `deploy.yml` exactly)

### 1. Backup

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && ./scripts/backup.sh dump"
```

Captures a `pg_dump` to `/backups/cryptoflip_YYYYMMDD_HHMMSS.sql`.
Retention: 7 daily / 4 weekly / 12 monthly. **Verify the dump file
exists before proceeding** — `ls -la /backups/cryptoflip_*.sql | tail -1`
should show a file with today's timestamp.

### 2. Pull the new code

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && git fetch --all && git reset --hard origin/main"
git log -1 --format='%H %s'
# Verify the SHA matches the WO-2 merge commit on main
```

### 3. Rebuild images

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose build --no-cache backend frontend"
```

This re-bakes the Docker images with the new migration files baked in.
The backend image now contains `049/050/051` in its `migrations/` dir.

### 4. Run migrations (one-shot)

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose up migrate"
```

The `migrate` service is defined in `docker-compose.yml` as a one-shot
container that runs `node dist/migrate-cli/run-migrations.js up`. It
depends on `postgres` being healthy; failures show up in the deploy
log (not silently in the backend's container). The service's
`restart: "no"` means a failed migration does NOT retry — it surfaces
the error to the operator and exits non-zero.

**What success looks like** (in the deploy log):
```
[migrate] OK (2662ms).
```

**What failure looks like** (any of these aborts the deploy):
```
[migrate] FAILED with exit code 1 after Nms.
[migrate] The backend container was NOT started — fix the migration
         and re-run this script before deploying.
```

If the migration fails, **DO NOT proceed to step 5**. The schema and
the code are now in a divergent state. Either:
- Fix the migration in a new commit and re-run from step 1, OR
- Roll back the code (step 7) and the schema is unchanged.

### 5. Start backend + frontend

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose up -d --no-deps backend frontend"
```

`--no-deps` prevents compose from also re-running the migrate service
(which already succeeded). The compose file has
`backend.depends_on.migrate: service_completed_successfully`, so even
without `--no-deps` this would be safe — the explicit flag is
belt-and-suspenders.

### 6. Smoke

```bash
sleep 8  # let backend boot
curl -fsS https://crazycoin.duckdns.org/api/health
curl -fsS https://crazycoin.duckdns.org/health
ssh root@crazycoin.duckdns.org "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

`/api/health` should return `{"status":"ok",...}` with the database
and redis checks green. If `database.status != "ok"`, the new
migration broke the connection — proceed to rollback.

### 7. 10-minute log watch

```bash
ssh root@crazycoin.duckdns.org "docker logs -f --since 10m coin-master-backend-1"
```

Watch for:
- `relation "X" does not exist` — Prisma client querying a table the
  migration didn't create (parity-gate should have caught this; if
  you see it, file an issue with the failing query)
- Repeated 5xx on the API — would indicate the schema change broke
  production code paths
- Migration `pgmigrations` entries — `psql ... -c "SELECT * FROM pgmigrations"`
  should show 049, 050, 051 all present with `run_on` within the last
  10 minutes

### 8. Verify the new tables are queryable

```bash
ssh root@crazycoin.duckdns.org "docker exec -it coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -c '\\dt currencies' "
# Expect:  public | currencies | table | cryptoflip

ssh root@crazycoin.duckdns.org "docker exec -it coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -c 'SELECT code, symbol, decimal_places, is_active FROM currencies;'"
# Expect:  USDT | ₮ | 6 | t
```

---

## Rollback

If anything in steps 4-7 fails or shows bad data, the rollback is
mirror-image:

### Database rollback (if migration 049/050/051 itself is the problem)

```bash
# 1. Stop the running backend so it stops writing to the new tables
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose stop backend"

# 2. Restore the database from the pre-deploy backup
ssh root@crazycoin.duckdns.org "cd /root/coin-master && ls -la /backups/cryptoflip_*.sql | tail -1"
# Take the most recent dump. Confirm timestamp is BEFORE the failed deploy.
ssh root@crazycoin.duckdns.org "gunzip -c /backups/cryptoflip_TIMESTAMP.sql.gz | docker exec -i coin-master-postgres-1 psql -U cryptoflip -d cryptoflip"
# (The exact restore command depends on backup.sh's dump format;
#  see scripts/test-rollback.sh for the verified procedure.)

# 3. Roll the code back to the previous image
ssh root@crazycoin.duckdns.org "cd /root/coin-master && git reset --hard HEAD~1"
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose build --no-cache backend frontend"
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose up -d --no-deps backend frontend"

# 4. Smoke
curl -fsS https://crazycoin.duckdns.org/api/health
```

### Code-only rollback (the new schema is fine, but the new code is bad)

```bash
ssh root@crazycoin.duckdns.org "cd /root/coin-master && git reset --hard HEAD~1"
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose build --no-cache backend frontend"
ssh root@crazycoin.duckdns.org "cd /root/coin-master && docker compose up -d --no-deps backend frontend"
```

The 049/050/051 migrations stay applied (the schema is additive; old
code is fine with the new tables present). The Prisma client won't
query them yet — that's WO-3's concern.

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `[migrate] FAILED with exit code 1` on step 4 | Migration SQL error or `node-pg-migrate` config | Check the migration's exact error in the deploy log; fix in a new commit, do not hand-edit applied migrations |
| `relation "currencies" does not exist` at runtime | Migration 050 was skipped or migration 049 didn't create currencies | Verify `pgmigrations` has 049, 050, 051; re-run `docker compose up migrate` if not |
| `/api/health` returns 503 with `database.status = "error"` | DB is up but schema is broken | Check backend logs for the SQL error; most likely a Prisma client query against a table that was supposed to be in 049 but isn't (parity-gate should have caught it) |
| `currencies` is empty after deploy | Migration 050 didn't run | Check `pgmigrations`; manually `psql -f migrations/050_prisma_financial_schema_seed.sql` |
| `deposit_transactions_blockchain_tx_id_uniq` already exists | Migration 051 re-ran on a DB that already has it | Idempotent DO block guard handles this — no action needed |

---

## Related documents

- `docs/DISASTER_RECOVERY.md` — full DB restore (catastrophic data loss)
- `docs/MIGRATION_ROLLBACK_RUNBOOK.md` — single-migration rollback
- `docs/MIGRATIONS_CONVENTIONS.md` — naming, lint, and authoring rules
- `scripts/backup.sh` — the backup script this runbook calls
- `scripts/test-rollback.sh` — the rollback drill, run before shipping
  a new migration
- `docs/PRODUCTION_DEPLOY_GUIDE.md` (if it exists) — broader deploy
  context