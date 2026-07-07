-- migrate:up
-- Add KYC, role, 2FA, wagering, rakeback, and referral columns to users table
-- Also add chain_hash column to audit_logs for immutable audit chains

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_applicant_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS two_factor_secret TEXT,
  ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_temp_secret TEXT,
  ADD COLUMN IF NOT EXISTS total_wagered DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
  ADD COLUMN IF NOT EXISTS pending_rakeback DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pending_affiliate_balance DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
  ADD COLUMN IF NOT EXISTS total_affiliate_earned DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS chain_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_audit_logs_chain_hash ON audit_logs(chain_hash);

-- migrate:down
-- We intentionally do NOT drop columns in down migrations for production safety.
-- Dropping columns destroys data.  If you need to revert, do it manually.
