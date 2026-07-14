-- Date of birth (for age verification - 18+ requirement)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS date_of_birth date;

-- =============================================================
--  Migration 024: P3 Deposit-side KYC
-- =============================================================
--  Adds:
--    1. users.preferred_language (en | bn, default 'en')
--    2. users.kyc_deposit_override_until (timestamptz)
--    3. users.kyc_deposit_override_reason (text)
--    4. users.kyc_deposit_override_by (uuid REFERENCES users(id))
--    5. users.kyc_country_exception_until (per-user sanctions override)
--    6. users.kyc_country_exception_reason
--    7. users.kyc_country_exception_by
--    8. kyc_override_log (audit trail for all KYC-related admin actions)
--    9. admin_settings defaults (all tier thresholds + sanctions + expiry policy)

-- Per-user language preference
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_language varchar(5) NOT NULL DEFAULT 'en';

-- Per-user deposit KYC override (super_admin can grant temporary bypass)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_until timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_reason text,
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_by    uuid REFERENCES users(id);

-- Per-user sanctions-country exception (for VIPs in sanctioned regions)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_country_exception_until timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_country_exception_reason text,
  ADD COLUMN IF NOT EXISTS kyc_country_exception_by    uuid REFERENCES users(id);

-- Audit log for all KYC-related admin actions
CREATE TABLE IF NOT EXISTS kyc_override_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  admin_user_id uuid NOT NULL REFERENCES users(id),
  action varchar(50) NOT NULL,  -- 'override_grant' | 'override_revoke' | 'sanctions_exception_grant' | 'sanctions_list_add' | 'sanctions_list_remove' | 'threshold_change' | 'self_exclusion_reverse' | 'self_exclusion_extend' | 'expiry_policy_change'
  details jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kyc_override_log_user ON kyc_override_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_override_log_action ON kyc_override_log(action, created_at DESC);

-- Admin settings defaults (all editable via /api/admin/kyc/thresholds)
INSERT INTO admin_settings (key, value, description) VALUES
  -- Tier 0 (unverified): small deposits only
  ('deposit_tier0_max_per_tx', '100',     'Tier 0 max single-tx deposit (USDT). Admin-editable.'),
  ('deposit_tier0_max_daily',  '100',     'Tier 0 max daily cumulative deposit (USDT). Admin-editable.'),
  -- Tier 1 (basic KYC)
  ('deposit_tier1_max_per_tx', '500',     'Tier 1 max single-tx deposit (USDT). Admin-editable.'),
  ('deposit_tier1_max_daily',  '500',     'Tier 1 max daily cumulative deposit (USDT). Admin-editable.'),
  -- Tier 2 (intermediate)
  ('deposit_tier2_max_per_tx', '5000',    'Tier 2 max single-tx deposit (USDT). Admin-editable.'),
  ('deposit_tier2_max_daily',  '10000',   'Tier 2 max daily cumulative deposit (USDT). Admin-editable.'),
  -- Tier 3 (full)
  ('deposit_tier3_max_per_tx', '50000',   'Tier 3 max single-tx deposit (USDT). Admin-editable.'),
  ('deposit_tier3_max_daily',  '100000',  'Tier 3 max daily cumulative deposit (USDT). Admin-editable.'),
  -- Sanctioned country list (JSON array of ISO codes)
  ('kyc_sanctioned_countries', '["IR","KP","SY","CU","AF"]',
   'ISO country codes blocked from deposits. Admin-editable as JSON array.'),
  -- KYC expiry policy
  ('kyc_expiry_check_enabled', 'false',
   'If true, KYC ages out per tier_max_age_days. Admin-toggleable.'),
  ('kyc_expiry_grace_days', '90',
   'Days after expiry before auto-action kicks in.'),
  ('kyc_expiry_auto_action', 'warn_only',
   'warn_only | downgrade_to_tier0 | downgrade_to_tier1'),
  ('kyc_tier1_max_age_days', '1825', '5 years - Tier 1 KYC max age before expiry'),
  ('kyc_tier2_max_age_days', '1095', '3 years - Tier 2 KYC max age'),
  ('kyc_tier3_max_age_days', '365',  '1 year  - Tier 3 KYC max age'),
  -- Self-exclusion reversal
  ('self_exclusion_reversal_cooling_hours', '24',
   'Hours between admin reversing self-exclusion and it taking effect (0 = instant, 24 = standard).'),
  -- Bilingual notifications
  ('email_default_language', 'en', 'Default language for new users (en | bn)'),
  -- Rollout
  ('deposit_kyc_enforcement_mode', 'warn',
   'off | warn | strict. Default: warn for safe rollout.'),
  ('deposit_kyc_strict_after',  '2026-08-15',
   'Date to auto-flip warn → strict if enforcement_mode=warn.')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
