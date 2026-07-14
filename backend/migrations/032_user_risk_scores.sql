-- =============================================================
--  Migration 032: User risk score storage (Phase 1.2)
-- =============================================================
--  Adds risk score columns to users + a dedicated table for the
--  score breakdown (so admin can see WHY a user is flagged) and a
--  small history (last 10 score snapshots).
--
--  Risk score (0-100):
--    0–29  SAFE
--    30–49 LOW_RISK
--    50–69 MEDIUM_RISK (extra 2FA on withdrawal)
--    70–84 HIGH_RISK (withdrawal blocked, admin alert)
--    85–100 CRITICAL (auto-suspend, immediate alert)
--
--  Tiers per v2.0 spec.

CREATE TABLE IF NOT EXISTS user_risk_scores (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_score   INTEGER NOT NULL DEFAULT 0
                  CHECK (current_score BETWEEN 0 AND 100),
  tier            VARCHAR(20) NOT NULL DEFAULT 'safe'
                  CHECK (tier IN ('safe','low_risk','medium_risk','high_risk','critical')),
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_calculated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calculated_by   VARCHAR(20) NOT NULL DEFAULT 'rule_engine'
                  CHECK (calculated_by IN ('rule_engine','ml_model')),
  history         JSONB NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0
    CHECK (risk_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS risk_tier  VARCHAR(20) NOT NULL DEFAULT 'safe'
    CHECK (risk_tier IN ('safe','low_risk','medium_risk','high_risk','critical'));

CREATE INDEX IF NOT EXISTS idx_users_risk_tier ON users(risk_tier);
CREATE INDEX IF NOT EXISTS idx_user_risk_scores_tier ON user_risk_scores(tier);

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.user_risk_scores', 'info',
        jsonb_build_object('migration','032_user_risk_scores',
                          'summary','Risk score + tier on users, history table'));