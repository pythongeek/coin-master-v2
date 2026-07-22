-- =============================================================
--  Migration 035: Fraud alert log (Phase 1.5)
-- =============================================================
--  Persistent record of every alert the fraud system emitted:
--    - severity (critical | high | medium | info)
--    - alert_type (CRIT_001..DAILY_003 per v2.0 spec)
--    - title + body (human-readable)
--    - affected_user_ids[] (array, supports multi-user rings)
--    - channels_sent[] (which channels the alert went out on:
--        'slack', 'discord', 'email', 'db')
--    - delivery JSONB (per-channel status, error, http_code)
--  Admin can see a full history of every fraud alert sent and
--  which channels actually delivered it (audit-of-audits).

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type        VARCHAR(40) NOT NULL,
  severity          VARCHAR(10) NOT NULL
                    CHECK (severity IN ('critical','high','medium','info')),
  title             VARCHAR(200) NOT NULL,
  body              TEXT NOT NULL,
  affected_user_ids UUID[] NOT NULL DEFAULT '{}',
  risk_score        INTEGER,
  signals           TEXT[] NOT NULL DEFAULT '{}',
  channels_sent     VARCHAR(20)[] NOT NULL DEFAULT '{}',
  delivery          JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action TEXT,
  admin_link        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_created_at ON fraud_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_severity ON fraud_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_type ON fraud_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_affected_gin
  ON fraud_alerts USING GIN(affected_user_ids);

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.fraud_alerts', 'info',
        jsonb_build_object('migration','035_fraud_alerts',
                          'summary','Fraud alert persistence (audit-of-audits)'))