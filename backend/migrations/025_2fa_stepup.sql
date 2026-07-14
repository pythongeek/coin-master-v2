-- Migration 025: 2FA step-up support
-- Required for: large withdrawals (configurable threshold), sensitive admin actions
-- Adds TOTP secret storage (encrypted at rest) + per-user enabled flag + last-2fa timestamp

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS totp_verified_at timestamptz;

-- Audit trail: track each successful 2FA verification (helps with investigation)
CREATE TABLE IF NOT EXISTS two_factor_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action varchar(50) NOT NULL,  -- 'login' | 'withdraw' | 'admin_action'
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_two_factor_log_user
  ON two_factor_log(user_id, created_at DESC);

-- Admin-configurable threshold: above this USDT amount, withdrawals require 2FA.
-- Default 1000 USDT. Set to a very high number (e.g. 999999) to disable.
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES ('withdrawal_2fa_threshold_usdt', '1000', 'Withdrawals above this amount require 2FA verification. Set to 999999 to disable.', NOW())
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO admin_settings (key, value, description, updated_at)
VALUES ('withdrawal_2fa_grace_minutes', '5', 'A successful 2FA on a withdrawal covers this many minutes for subsequent withdrawals.', NOW())
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
