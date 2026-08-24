-- =============================================================
--  Migration 055: P2-19 Withdrawal-side KYC tier limits (DB-driven)
-- =============================================================
--
--  Background:
--    The withdrawal queue (backend/src/services/withdrawal-queue.ts,
--    lines 83-105 prior to P2-19) enforced per-tier per-tx and daily
--    limits with hardcoded literals:
--
--      tier 0 (unverified): 50 / 50
--      tier 1 (basic KYC): 50 / 100
--      tier 2 (ID): 1000 / 5000
--      tier 3 (full): 10000 / 50000
--
--    This made them ungovernable from /api/admin/settings (no hot
--    reload) and required a code deploy to tune — unacceptable for a
--    real-money withdrawal path.
--
--  This migration is the DB-side counterpart to the P2-19 code
--  change: it seeds 8 admin_settings rows with defaults that EXACTLY
--  match the pre-existing hardcodes, so behaviour is preserved at
--  upgrade time. Operators can subsequently edit any of these via
--  /api/admin/settings without redeploying.
--
--  The keys are bucketed by /api/admin/settings/groups into the
--  'Safety & Limits' group (k.includes('limit') → Safety & Limits).
--
--  ON CONFLICT (key) DO NOTHING:
--    Operators may have already set custom values via /api/admin/settings.
--    DO NOTHING preserves their overrides across re-runs; DO UPDATE
--    would silently reset them, which is the bug class we are fixing.
-- =============================================================

INSERT INTO admin_settings (key, value, description) VALUES
  -- Tier 0 (unverified): tight limits, identical to old hardcodes
  ('withdrawal_tier0_max_per_tx', '50',     'Tier 0 max single-tx withdrawal (USDT). Admin-editable. P2-19.'),
  ('withdrawal_tier0_max_daily',  '50',     'Tier 0 max daily cumulative withdrawal (USDT). Admin-editable. P2-19.'),
  -- Tier 1 (basic KYC)
  ('withdrawal_tier1_max_per_tx', '50',     'Tier 1 max single-tx withdrawal (USDT). Admin-editable. P2-19.'),
  ('withdrawal_tier1_max_daily',  '100',    'Tier 1 max daily cumulative withdrawal (USDT). Admin-editable. P2-19.'),
  -- Tier 2 (intermediate)
  ('withdrawal_tier2_max_per_tx', '1000',   'Tier 2 max single-tx withdrawal (USDT). Admin-editable. P2-19.'),
  ('withdrawal_tier2_max_daily',  '5000',   'Tier 2 max daily cumulative withdrawal (USDT). Admin-editable. P2-19.'),
  -- Tier 3 (full)
  ('withdrawal_tier3_max_per_tx', '10000',  'Tier 3 max single-tx withdrawal (USDT). Admin-editable. P2-19.'),
  ('withdrawal_tier3_max_daily',  '50000',  'Tier 3 max daily cumulative withdrawal (USDT). Admin-editable. P2-19.')
ON CONFLICT (key) DO NOTHING;
