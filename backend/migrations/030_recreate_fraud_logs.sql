-- =============================================================
--  Migration 030: Recreate fraud_logs table
-- =============================================================
--  Same pattern as 029 (ip_whitelist): migration 006 created
--  fraud_logs then DROPped it in its migrate:down block. The
--  table never existed in production, but routes/auth.ts inserts
--  into it on flagged signups (fingerprint dup, near-IP-cap, etc).
--
--  Any time a flaggable signup path actually triggered this insert
--  the request 500'd. Recreating the table now.

CREATE TABLE IF NOT EXISTS fraud_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  fingerprint VARCHAR(255),
  details TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_logs_user_id ON fraud_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_logs_created_at ON fraud_logs(created_at DESC);