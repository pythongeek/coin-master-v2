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

COMMIT;