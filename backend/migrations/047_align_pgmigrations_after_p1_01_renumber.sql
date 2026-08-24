-- Migration tracking update: P1-01 backward-compat for renumbered files
-- + backfill missing pgmigrations rows for migrations that were applied
-- manually (not via node-pg-migrate).
--
-- This is NOT a regular migration that alters the schema. It is a
-- one-shot alignment script for the `pgmigrations` table to match
-- the on-disk renumbering in P1-01 and to register migrations that
-- were applied directly via psql/docker exec. node-pg-migrate tracks
-- applied migrations by the full filename string in `pgmigrations.name`,
-- so renumbering a file on disk would otherwise make the runner
-- believe the new filename is a fresh, never-applied migration.
--
-- Operator instructions:
--   1. Run this SQL against your live DB BEFORE the next node-pg-migrate
--      invocation (e.g. before the next backend deploy).
--   2. Confirm with: SELECT name FROM pgmigrations ORDER BY name;
--      All expected rows must be present and unique.
--
-- This script is idempotent: if the rows already exist, the UPDATE /
-- INSERT statements match 0 rows.

BEGIN;

-- ── P1-01: rename four pgmigrations rows after the on-disk renumbering ──
UPDATE pgmigrations SET name = '015_add_cancelled_status'
  WHERE name = '024_add_cancelled_status';
UPDATE pgmigrations SET name = '046_bilingual_email_templates'
  WHERE name = '025_bilingual_email_templates';
UPDATE pgmigrations SET name = '043_ip_whitelist_self_loopback'
  WHERE name = '042_ip_whitelist_self_loopback';
UPDATE pgmigrations SET name = '044_webhook_subscriptions'
  WHERE name = '043_webhook_subscriptions';

-- ── Backfill: P0-04 (audit_log.archived_at) was applied via psql, not via
--    node-pg-migrate. Register it so the runner does not re-apply
--    (the SQL is IF NOT EXISTS, so re-applying is harmless, but recording
--    it here keeps the row count consistent with reality).
INSERT INTO pgmigrations (name, run_on)
  SELECT '045_audit_log_archived_at', NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM pgmigrations WHERE name = '045_audit_log_archived_at'
  );

-- ── Self-record: REMOVED ────────────────────────────────────
-- Originally this script ended with an INSERT for its own name:
--   INSERT INTO pgmigrations (name, run_on)
--     SELECT '047_align_pgmigrations_after_p1_01_renumber', NOW()
--     WHERE NOT EXISTS (...);
-- That INSERT is now redundant AND counter-productive. node-pg-migrate
-- records the migration row automatically after the SQL above completes
-- (see node-pg-migrate/dist/bundle/index.js line 3016:
-- `INSERT INTO "${migrationsTable}" (name, run_on) VALUES ($1, NOW())`).
-- Before WO-2.1 added the `pgmigrations_name_key` UNIQUE INDEX to the
-- baseline, the two INSERTs coexisted silently (no constraint). With
-- the UNIQUE INDEX in place, the runner's INSERT would fail with
-- `Key (name)=(047_...) is duplicated.` on a fresh DB because this
-- migration's INSERT and the runner's INSERT both target the same
-- name with no ON CONFLICT. Removing the explicit INSERT lets the
-- runner's automatic INSERT succeed, and node-pg-migrate's
-- `getMigrationsToRun` ensures the migration is not re-applied on
-- subsequent runs (because the row exists).

DO $$
BEGIN
  RAISE NOTICE 'P1-01 pgmigrations alignment applied:';
  RAISE NOTICE '  015_add_cancelled_status (was 024_add_cancelled_status)';
  RAISE NOTICE '  046_bilingual_email_templates (was 025_bilingual_email_templates)';
  RAISE NOTICE '  043_ip_whitelist_self_loopback (was 042_ip_whitelist_self_loopback)';
  RAISE NOTICE '  044_webhook_subscriptions (was 043_webhook_subscriptions)';
  RAISE NOTICE '  045_audit_log_archived_at backfilled (P0-04 was applied manually)';
  RAISE NOTICE '  047_align_pgmigrations_after_p1_01_renumber (recorded by node-pg-migrate runner)';
END $$;

COMMIT;
