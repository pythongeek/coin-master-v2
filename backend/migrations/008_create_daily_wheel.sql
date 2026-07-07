-- migrate:up
-- Daily login wheel spins with provably-fair seed tracking

CREATE TABLE IF NOT EXISTS daily_wheel_spins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_spin_at TIMESTAMPTZ,
  last_prize_label VARCHAR(120),
  last_prize_value DECIMAL(18, 8) NOT NULL DEFAULT 0,
  server_seed_hash VARCHAR(128),
  seed_id UUID REFERENCES server_seeds(id) ON DELETE SET NULL,
  nonce INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_wheel_spins_user ON daily_wheel_spins(user_id);

-- migrate:down
DROP TABLE IF EXISTS daily_wheel_spins;
