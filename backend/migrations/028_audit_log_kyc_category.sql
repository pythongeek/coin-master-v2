-- =============================================================
--  Migration 028: Extend audit_log.category CHECK to include 'kyc'
-- =============================================================
--  Required by migration 027 (kyc-uniqueness) which writes audit
--  rows with category='kyc'. Without this, 027 rolls back AND
--  the runtime kyc-uniqueness.ts service would crash on dup.
--
--  Safe & additive: only widens an existing CHECK constraint.
--  No data touched.

BEGIN;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_category_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_category_check
  CHECK (category IN (
    'admin', 'auth', 'security', 'config', 'system', 'bonus',
    'withdrawal', 'wagering', 'rain', 'payment', 'affiliate',
    'fraud', 'support', 'kyc'
  ));

-- P2-19: Audit row for the 027 migration was moved here from
-- 027_kyc_id_uniqueness.sql because 027 runs BEFORE this constraint
-- is widened. Live prod had this constraint widened earlier
-- (so the live INSERT in 027 succeeded historically), but a fresh
-- DB would fail. Documenting both migrations in one audit row
-- keeps the trail accurate.
INSERT INTO audit_log (category, action, severity, details)
VALUES ('kyc', 'migration.kyc_id_uniqueness+kyc_category', 'info',
        jsonb_build_object(
          'migrations', ARRAY['027_kyc_id_uniqueness', '028_audit_log_kyc_category'],
          'summary', 'Added SHA-256 ID hashing + unique partial indexes; widened audit_log.category CHECK to include kyc',
          'applied_at', NOW()
        ));

COMMIT;