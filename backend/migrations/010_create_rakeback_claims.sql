-- migrate:up
-- Rakeback / cashback claims tracking

CREATE TABLE IF NOT EXISTS rakeback_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(18, 8) NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, claimed_at)
);

CREATE INDEX IF NOT EXISTS idx_rakeback_claims_user ON rakeback_claims(user_id, claimed_at);

-- migrate:down
DROP TABLE IF EXISTS rakeback_claims;
