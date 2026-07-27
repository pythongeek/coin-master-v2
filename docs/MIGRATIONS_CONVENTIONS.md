# Backend Migrations — Conventions & Phase Guide

This document describes the conventions and phases for the SQL
migration files in `backend/migrations/`. The migration runner is
[`node-pg-migrate`](https://github.com/salsita/node-pg-migrate),
invoked by:

- The `migrate` one-shot service in `docker-compose.yml` (production).
- `npm run migrate` (manual / CI).
- `RUN_MIGRATIONS_ON_BOOT=true` (dev-only, logs a deprecation warning).

> **P2-08** — this README was added in 2026-07-24 as the canonical
> reference for the numbering convention, the duplicate-prefix guard,
> and the phase grouping. Future contributors should add new
> migrations at the bottom of this file's phase table and update
> the "currently 48 migrations" count.

---


> **File location note (P2-08 history)**: this document originally
> lived at `backend/migrations/README.md`, but `node-pg-migrate`
> loads every file in the migrations directory and crashed when it
> tried to read a `.md` file as JavaScript. The file was moved to
> `docs/MIGRATIONS_CONVENTIONS.md` on the same day it was created.
> Migration files remain in `backend/migrations/`.

## 1. Naming convention

Every file MUST follow this pattern:

```
NNN_descriptive_snake_case_name.sql
```

| Component | Rule |
|---|---|
| `NNN` | A 3-digit numeric prefix, **zero-padded** (`001`, `012`, `048`, NOT `1` or `12`). |
| `descriptive_snake_case_name` | A short identifier, lowercase, underscores, no spaces. Keep it short — `add_user_risk_scores` not `add_user_risk_score_table_for_fraud_detection_v2`. |
| `.sql` extension | Required. |

The numeric prefix is the **logical-order key** for the migration
runner. Files are applied in alphabetical order. **Duplicate prefixes
are forbidden** (see §3) — even though node-pg-migrate keys on the
full filename (so duplicates don't break the runner today), they
introduce ordering ambiguity and have caused real bugs in this repo
(see `BACKEND_PROD_READINESS.md` P1-01 for the original incident).

---

## 2. Authoring rules

1. **Every migration is its own transaction.** node-pg-migrate wraps
   each migration in a `BEGIN` / `COMMIT` pair by default. Do NOT
   include manual `BEGIN` / `COMMIT` inside the file.
2. **Idempotent where possible.** Use `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`. For
   NOT-NULL columns, prefer adding them in a `DEFAULT`-providing
   step (e.g., backfill the column with `NULL` first, populate, then
   `SET NOT NULL`).
3. **No data-only migrations.** Use `migrations/seed/*.sql` for that
   (the production build excludes that directory from `dist/`).
4. **No DROP TABLE without a confirmed backup.** The migration
   runner does not back up the DB. If a migration drops a column or
   table, the operator must run `scripts/backup.sh` immediately
   before applying it.
5. **Long migrations**: add a `-- P2-08 estimated-rows: N` comment
   at the top so operators can plan a maintenance window. For
   backfills of >1M rows, prefer chunking (`LIMIT 10000` per
   transaction) over a single UPDATE.

---

## 3. The duplicate-prefix guard

`scripts/lint-migrations.js` (also wired into `npm run lint:migrations`
and the CI workflow per P2-01) fails the build if any two `.sql` files
in this directory share a numeric prefix.

```bash
# Run the linter locally:
cd backend && npm run lint:migrations
# Sample output (clean state):
# ✅ lint-migrations: 48 migration file(s), all unique prefixes (48 distinct: 1..48).
#
# Sample output (duplicate):
# ❌ lint-migrations: 1 duplicate prefix(es) detected:
#      prefix 050:
#        - 050_a.sql
#        - 050_b.sql
```

The linter also flags **malformed filenames** (anything not matching
`^\d{3}_`) and **gap prefixes** (e.g., `049` is missing) as warnings
but does not exit non-zero. Gaps are reserved for future renumbering
(e.g., `015` was reserved for a planned migration that was later
renumbered to `025_2fa_stepup.sql`).

---

## 4. Phase grouping

The 48 historical migrations are grouped below by their logical
feature area. **The numeric prefix determines application order, NOT
the phase.** Phases are purely a documentation aid.

### Phase 0 — Core Schema (Bootstrap)

| Prefix | Title | Purpose |
|---|---|---|
| `001` | add_user_kyc_and_audit_columns | Initial KYC + audit column layout on `users` |
| `002` | update_transactions_constraint | Add NOT NULL + CHECK on `transactions` table |
| `003` | seed_jackpot_settings | Insert default jackpot config rows |

### Phase 1 — Game Engine

| Prefix | Title | Purpose |
|---|---|---|
| `004` | create_webhook_tables | Webhook subscription + delivery log |
| `005` | create_promo_tables | Promo codes + redemption log |

### Phase 2 — Anti-Fraud & Risk Signals

| Prefix | Title | Purpose |
|---|---|---|
| `006` | add_fraud_detection | Initial fraud detection columns |
| `007` | create_achievements | Achievement unlock events |
| `008` | create_daily_wheel | Daily wheel reward schema |
| `009` | create_leaderboard_prizes | Leaderboard prize payouts |
| `010` | create_rakeback_claims | Rakeback claim records |
| `011` | create_challenge_progress | Challenge progress log |
| `012` | create_bonus_campaigns | Bonus campaign + wagering requirement tracking |

### Phase 3 — Operator Tooling

| Prefix | Title | Purpose |
|---|---|---|
| `013` | create_ip_whitelist | Operator IP whitelist (later recreated by `029`) |
| `014` | phase3_backup_codes | TOTP backup codes for admin accounts |

### Phase 4 — KYC & Compliance

| Prefix | Title | Purpose |
|---|---|---|
| `015` | add_cancelled_status | Add `cancelled` enum value to KYC status |
| `016` | kyc_custom_minimax | Custom Sumsub flow for risk tier overrides |
| `020` | add_kyc_tier_country | KYC tier + country enforcement columns |
| `024` | deposit_kyc | Per-deposit KYC override flow |
| `027` | kyc_id_uniqueness | Unique index on KYC submission external IDs |
| `028` | audit_log_kyc_category | Add `kyc` category to audit log |
| `038` | kyc_deepfake | Sumsub deepfake-detection flow |

### Phase 5 — Payments & Providers

| Prefix | Title | Purpose |
|---|---|---|
| `017` | create_payment_tables | Generic payment order + ledger tables |
| `018` | binance_pay_qr | Binance Pay QR deposit flow |
| `019` | multi_chain_qr | Multi-chain QR (BSC / TRC20 / ERC20) |

### Phase 6 — Notifications & Audit

| Prefix | Title | Purpose |
|---|---|---|
| `021` | rate_cache | FX rate cache table |
| `022` | email_notifications | Email queue + delivery log |
| `023` | audit_notes | Free-text notes attached to audit log entries |
| `026` | admin_balance_adjustments | Admin balance adjustment history |
| `044` | webhook_subscriptions | Outbound webhook subscription schema |
| `045` | audit_log_archived_at | Add `archived_at` column for retention |

### Phase 7 — Security (2FA + Auth)

| Prefix | Title | Purpose |
|---|---|---|
| `025` | 2fa_stepup | 2FA step-up middleware for large withdrawals |
| `046` | bilingual_email_templates | EN + BN email template storage |

### Phase 8 — IP & Geo Risk

| Prefix | Title | Purpose |
|---|---|---|
| `029` | recreate_ip_whitelist | Recreate `ip_whitelist` (fix from `013`) |
| `030` | recreate_fraud_logs | Recreate `fraud_logs` with corrected schema |
| `039` | geoip_maxmind_cache | MaxMind GeoIP2 lookup cache |
| `043` | ip_whitelist_self_loopback | Allow `127.0.0.1` in the IP whitelist for local dev |

### Phase 9 — Device & Behavior Risk

| Prefix | Title | Purpose |
|---|---|---|
| `031` | device_fingerprints | Device-fingerprint hash table (P1-12 cap) |
| `032` | user_risk_scores | Per-user rolling risk score |
| `033` | recreate_fraud_signals | Recreate `fraud_signals` with corrected schema |
| `034` | account_resource_links | Account-resource cross-reference table |
| `035` | fraud_alerts | Real-time fraud alert queue |
| `036` | ip_reputation | IP reputation history |
| `037` | ml_risk_model | ML model output cache |
| `040` | daily_fraud_reports | Daily fraud digest rows |
| `041` | behavioral_cohorts | User behavioral cohort assignments |

### Phase 10 — Wallet Indexes (Cleanup)

| Prefix | Title | Purpose |
|---|---|---|
| `042` | add_streak_lightning_columns | Streak + lightning reward columns |
| `047` | align_pgmigrations_after_p1_01_renumber | Re-sync `pgmigrations` rows after P1-01 renumbering |
| `048` | wallet_address_index_postgres_sequence | Replace MySQL-style AUTO_INCREMENT with `pg` sequence for `users.wallet_address_idx` |

---

## 5. How to add a new migration

```bash
# 1. Pick the next prefix (check the current max):
ls backend/migrations/ | tail -3
# 2. Create the file:
touch backend/migrations/049_my_new_feature.sql
# 3. Write the SQL — follow §2 rules above.
# 4. Run the linter locally:
cd backend && npm run lint:migrations
# 5. Run the migration against your local DB:
npm run migrate up
# 6. Verify the schema is what you expect:
psql -U cryptoflip -d cryptoflip -c "\d my_new_table"
# 7. Run the rollback drill (P2-09):
./scripts/test-rollback.sh
# 8. Add an entry to §4 above (this file) and commit.
```

---

## 6. How to renumber or merge existing migrations

> **WARNING** — renumbering a migration that has already been
> applied to production is a **breaking change**. node-pg-migrate
> tracks applied migrations by their full filename (not just the
> prefix). Renaming a file that has been applied will cause the
> next `npm run migrate` to think the migration is un-applied and
> re-run it, which usually fails with a "duplicate column" error.

If you absolutely must renumber a historical migration:

1. Update the `pgmigrations.name` row in the live DB (only on
   maintenance):
   ```sql
   UPDATE pgmigrations SET name = '049_my_new_name.sql' WHERE name = 'NN_old_name.sql';
   ```
2. Update the filename in `backend/migrations/`.
3. Update the phase table in §4 above.
4. Update the migration linter count in this README's §4 header.

For the **post-P1-01** renumbering of the original `024_*, 025_*,
042_*` duplicates, see `047_align_pgmigrations_after_p1_01_renumber.sql`
and `BACKEND_PROD_READINESS.md` P1-01.

---

## 7. Related documents

- `backend/scripts/lint-migrations.js` — the duplicate-prefix linter.
- `scripts/backup.sh` — daily + weekly + monthly backups
  (verifies `pgmigrations` is in each dump per P2-06).
- `scripts/test-rollback.sh` — rollback drill (P2-09).
- `docs/MIGRATION_ROLLBACK_RUNBOOK.md` — incident-response runbook
  for safely reverting a migration in production (P2-09).
- `docs/DISASTER_RECOVERY.md` — full DR procedure, including the
  `pgmigrations` rule (P2-06).
- `BACKEND_PROD_READINESS.md` P0-03 — why migrations run outside the
  backend boot path.

---

## 8. P2-08 acceptance criteria

This README is **current** if and only if:

1. Every migration in `backend/migrations/` is listed in §4 above.
2. The "currently 48 migrations" count matches `ls backend/migrations/*.sql | wc -l`.
3. The duplicate-prefix guard (§3) is wired into the CI workflow
   (see `.github/workflows/ci.yml` → `Migration prefix lint` step).
4. Any new migration added in the future updates §4 in the same
   commit (no "I'll add the doc later" PRs).
