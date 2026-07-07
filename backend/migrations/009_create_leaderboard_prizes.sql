-- migrate:up
-- Leaderboard / tournament prize distribution tracking

CREATE TABLE IF NOT EXISTS leaderboard_prizes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period VARCHAR(20) NOT NULL,
  rank INTEGER NOT NULL,
  amount DECIMAL(18, 8) NOT NULL DEFAULT 0,
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, period, rank)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_prizes_period ON leaderboard_prizes(period, distributed_at);

-- migrate:down
DROP TABLE IF EXISTS leaderboard_prizes;
