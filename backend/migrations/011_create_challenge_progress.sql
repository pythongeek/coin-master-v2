-- migrate:up
-- Challenge / mission progress tracking

CREATE TABLE IF NOT EXISTS challenge_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id VARCHAR(64) NOT NULL,
  reward DECIMAL(18, 8) NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  progress_date DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(user_id, challenge_id, progress_date)
);

CREATE INDEX IF NOT EXISTS idx_challenge_progress_user ON challenge_progress(user_id, progress_date);

-- migrate:down
DROP TABLE IF EXISTS challenge_progress;
