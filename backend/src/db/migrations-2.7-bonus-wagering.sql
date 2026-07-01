-- ═══════════════════════════════════════════════════════════════
--  MIGRATION 2.7 — Bonus & Wagering system (Session 1 of roadmap-2026)
-- ═══════════════════════════════════════════════════════════════
--
--  Adds bonus tracking + wagering requirements to prevent
--  bonus abuse (user claims bonus, wins, withdraws without
--  putting real money at risk).
--
--  Strategy (per roadmap-2026.md Session 1):
--    - Per-user split: bonus_balance vs withdrawable_balance
--    - Track wagering_required + wagering_completed separately
--    - Validate withdrawal against 5 conditions
--    - Track total_deposited to enforce min-deposit-to-withdraw
--
--  Settings (admin can change via /api/admin/config):
--    bonus_wager_multiplier:                30 (default)
--    bonus_max_withdrawal_multiplier:       3  (default — profit-first)
--    bonus_expiry_days:                      7
--    bonus_min_deposit_to_withdraw_pct:     50 (default — profit-first)
--    bonus_cooldown_hours:                  24
--    daily_withdrawal_limit_coins:          5000
--
-- ═══════════════════════════════════════════════════════════════

-- ── 1. users table — split balance into bonus vs withdrawable ──

ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawable_balance_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wagering_required_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wagering_completed_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_deposited_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_bonus_claimed_coins numeric(18,8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_at timestamp with time zone;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_withdrawal_at timestamp with time zone;

-- Backfill: existing balance becomes withdrawable_balance_coins (real money path)
-- For users who already have winnings, they keep them as withdrawable.
UPDATE users SET withdrawable_balance_coins = COALESCE(balance, 0) WHERE withdrawable_balance_coins = 0 AND balance IS NOT NULL;

-- ── 2. bonus_claims table — audit trail of every bonus granted ──

CREATE TABLE IF NOT EXISTS bonus_claims (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bonus_type varchar(30) NOT NULL,
  amount_coins numeric(18,8) NOT NULL CHECK (amount_coins > 0),
  wagering_required numeric(18,8) NOT NULL CHECK (wagering_required >= 0),
  max_withdrawal_allowed numeric(18,8) CHECK (max_withdrawal_allowed IS NULL OR max_withdrawal_allowed > 0),
  expires_at timestamp with time zone NOT NULL,
  claimed_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'expired', 'forfeited')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Hot path: get all active bonuses for a user
CREATE INDEX IF NOT EXISTS idx_bonus_claims_user_active
  ON bonus_claims(user_id) WHERE status = 'active';

-- Expiry cron: find bonuses to expire
CREATE INDEX IF NOT EXISTS idx_bonus_claims_expiry
  ON bonus_claims(expires_at) WHERE status = 'active';

-- Bonus type analytics
CREATE INDEX IF NOT EXISTS idx_bonus_claims_type_status
  ON bonus_claims(bonus_type, status);

-- ── 3. kyc_submissions table (also added by S2 but created here so Session 1
--       withdrawal validation can check status='approved') ──

CREATE TABLE IF NOT EXISTS kyc_submissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  document_type varchar(50),
  document_number varchar(100),
  document_country varchar(2),
  submitted_at timestamp with time zone NOT NULL DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewer_id uuid REFERENCES users(id),
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_user_latest
  ON kyc_submissions(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_kyc_pending
  ON kyc_submissions(submitted_at) WHERE status = 'pending';

-- ── 4. fraud_signals schema extension — add reason codes ──
-- (existing table already supports it via metadata jsonb, but
--  ensure column accepts new signal_type values via CHECK)
ALTER TABLE fraud_signals DROP CONSTRAINT IF EXISTS fraud_signals_signal_type_check;
ALTER TABLE fraud_signals ADD CONSTRAINT fraud_signals_signal_type_check
  CHECK (signal_type IN (
    'multi_account', 'velocity', 'bonus_abuse', 'match_fixing',
    'device_shared', 'geo_anomaly', 'manual', 'webhook_bad_signature',
    'withdrawal_velocity', 'bonus_too_fast', 'large_bet_pattern'
  ));

-- ── 5. admin_settings — bonus / withdrawal parameters ──
-- (idempotent: ON CONFLICT DO NOTHING)
INSERT INTO admin_settings (key, value, description) VALUES
  ('bonus_wager_multiplier',                '30',  'Wagering multiplier — bonus × N = wagering required'),
  ('bonus_max_withdrawal_multiplier',       '3',   'Max withdrawal = bonus × N (profit-first default)'),
  ('bonus_expiry_days',                      '7',   'Days until bonus expires and is forfeit'),
  ('bonus_min_deposit_to_withdraw_pct',     '50',  'Min deposit as % of bonus before withdrawal allowed'),
  ('bonus_cooldown_hours',                  '24',  'Hours after bonus grant before withdrawal allowed'),
  ('bonus_welcome_amount',                  '10',  'Welcome bonus amount in coins'),
  ('bonus_deposit_match_pct',               '50',  'Deposit match bonus as % of deposit (0 = disabled)'),
  ('bonus_deposit_match_cap',               '100', 'Max deposit match bonus per deposit in coins'),
  ('daily_withdrawal_limit_coins',          '5000','Daily max withdrawal per user in coins'),
  ('withdrawal_min_coins',                  '1',   'Minimum withdrawal amount'),
  ('withdrawal_max_coins',                  '10000','Maximum withdrawal amount per request'),
  ('withdrawal_auto_approve_threshold',     '0',   'Auto-approve withdrawals below this (0 = always manual)')
ON CONFLICT (key) DO NOTHING;
-- ── 6. audit_log schema extension — add Session 1 categories ──
-- (existing table already supports it via metadata jsonb, but
--  ensure column accepts new category values via CHECK)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_category_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_category_check
  CHECK (category IN (
    'admin', 'auth', 'security', 'config', 'system',
    'bonus', 'withdrawal', 'wagering', 'rain', 'payment',
    'affiliate', 'fraud', 'support'
  ));

-- ── 7. Clean up legacy snake_case keys (Session 1 finalization) ──
-- These were the original Phase 2.4 keys; superseded by camelCase GameConfig fields.
DELETE FROM admin_settings WHERE key IN (
  'bonus_wager_multiplier', 'bonus_max_withdrawal_multiplier',
  'bonus_min_deposit_to_withdraw_pct', 'bonus_cooldown_hours',
  'bonus_expiry_days', 'bonus_deposit_match_pct', 'bonus_deposit_match_cap',
  'daily_withdrawal_limit_coins', 'withdrawal_min_coins',
  'withdrawal_max_coins', 'withdrawal_auto_approve_threshold'
);

-- ── 8. Keep legacy users.balance synced with new split columns ──
UPDATE users SET balance = COALESCE(bonus_balance_coins, 0) + COALESCE(withdrawable_balance_coins, 0);

CREATE OR REPLACE FUNCTION sync_user_balance()
RETURNS TRIGGER AS $$
BEGIN
  NEW.balance := COALESCE(NEW.bonus_balance_coins, 0) + COALESCE(NEW.withdrawable_balance_coins, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_user_balance ON users;
CREATE TRIGGER trg_sync_user_balance
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_balance();
