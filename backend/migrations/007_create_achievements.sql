-- migrate:up
-- Achievements system: definitions and per-user progress tracking

CREATE TABLE IF NOT EXISTS achievements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  icon VARCHAR(40) NOT NULL DEFAULT 'Trophy',
  category VARCHAR(40) NOT NULL DEFAULT 'general',
  condition_type VARCHAR(40) NOT NULL CHECK (condition_type IN ('total_bets', 'total_wins', 'win_streak', 'loss_streak', 'total_wagered', 'net_pnl', 'biggest_win', 'referrals')),
  condition_value DECIMAL(18, 8) NOT NULL DEFAULT 1,
  coin_reward DECIMAL(18, 8) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress DECIMAL(18, 8) NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  UNIQUE(user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_unlocked ON user_achievements(user_id, unlocked_at);

INSERT INTO achievements (key, name, description, icon, category, condition_type, condition_value, coin_reward, sort_order) VALUES
  ('first_bet', 'First Flip', 'Place your first bet.', 'Play', 'milestone', 'total_bets', 1, 1, 10),
  ('bettor_100', '100 Flips', 'Place 100 bets.', 'Dices', 'volume', 'total_bets', 100, 5, 20),
  ('bettor_1000', '1,000 Flips', 'Place 1,000 bets.', 'Dices', 'volume', 'total_bets', 1000, 25, 30),
  ('winner_10', '10 Wins', 'Win 10 bets.', 'Coins', 'wins', 'total_wins', 10, 2, 40),
  ('winner_100', '100 Wins', 'Win 100 bets.', 'Coins', 'wins', 'total_wins', 100, 15, 50),
  ('streak_5', 'Hot Streak', 'Win 5 bets in a row.', 'Flame', 'streak', 'win_streak', 5, 10, 60),
  ('streak_10', 'Legendary Streak', 'Win 10 bets in a row.', 'Flame', 'streak', 'win_streak', 10, 50, 70),
  ('high_roller', 'High Roller', 'Wager $1,000 in total.', 'Banknote', 'volume', 'total_wagered', 1000, 20, 80),
  ('whale', 'Whale', 'Wager $50,000 in total.', 'Banknote', 'volume', 'total_wagered', 50000, 200, 90),
  ('in_the_green', 'In the Green', 'Reach $100 net profit.', 'TrendingUp', 'profit', 'net_pnl', 100, 10, 100)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category,
  condition_type = EXCLUDED.condition_type,
  condition_value = EXCLUDED.condition_value,
  coin_reward = EXCLUDED.coin_reward,
  sort_order = EXCLUDED.sort_order;

-- migrate:down
DROP TABLE IF EXISTS user_achievements;
DROP TABLE IF EXISTS achievements;
