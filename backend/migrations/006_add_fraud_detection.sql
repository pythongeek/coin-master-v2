-- migrate:up
-- Fraud detection columns on users + dedicated fraud_logs table

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_ip VARCHAR(45),
  ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS fraud_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  fingerprint VARCHAR(255),
  details TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_logs_user_id ON fraud_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_logs_created_at ON fraud_logs(created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS fraud_logs;
ALTER TABLE users DROP COLUMN IF EXISTS fingerprint, DROP COLUMN IF EXISTS registration_ip, DROP COLUMN IF EXISTS is_flagged;
