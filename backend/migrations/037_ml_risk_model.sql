-- =============================================================
--  Migration 037: ML risk model registry (Phase 3 / P3-1)
-- =============================================================
--  Three tables:
--
--    ml_models         — versioned model registry (multiple versions
--                         kept, one "active" at a time). Stores the
--                         on-disk path, feature_importance JSON, the
--                         training metrics JSON, and provider (onnx /
--                         mock). Admin uploads via the panel.
--
--    ml_training_jobs  — audit trail of every train/activate/rollback/
--                         upload event. status='requested' is recorded
--                         when admin POSTs /admin/ml/train; admin can
--                         later POST /admin/ml/models/upload with the
--                         ONNX file. Auto-train (cron) is intentionally
--                         OFF by default.
--
--    ml_predictions    — sampled live predictions. Each row stores the
--                         feature vector + the ML prob + the rule engine
--                         score + the blended score (so admin can audit
--                         model behavior over time). Indexes on user_id,
--                         created_at, and source ('a'|'b') for A/B mode.

CREATE TABLE IF NOT EXISTS ml_models (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(80) NOT NULL,                -- 'xgboost_v1'
  version           VARCHAR(40) NOT NULL,                -- '0.1.0' semver
  provider          VARCHAR(40) NOT NULL,                -- 'onnx' | 'mock'
  file_path         TEXT,                                -- /app/ml/models/<id>.onnx
  feature_importance JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ name, gain }]
  training_metrics  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { auc, recall, ... }
  feature_columns   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered list of feature names
  status            VARCHAR(20) NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('training','uploaded','active','retired','failed')),
  notes             TEXT,
  activated_at      TIMESTAMPTZ,
  activated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(name, version)
);

CREATE INDEX IF NOT EXISTS idx_ml_models_status ON ml_models(status);
CREATE INDEX IF NOT EXISTS idx_ml_models_name ON ml_models(name);

CREATE TABLE IF NOT EXISTS ml_training_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      UUID REFERENCES ml_models(id) ON DELETE SET NULL,
  event         VARCHAR(40) NOT NULL
                CHECK (event IN ('train_requested','upload_completed','activated','retired','rolled_back','deleted','ab_test_started','ab_test_stopped')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_jobs_model ON ml_training_jobs(model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_jobs_event ON ml_training_jobs(event, created_at DESC);

CREATE TABLE IF NOT EXISTS ml_predictions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  model_id         UUID REFERENCES ml_models(id) ON DELETE SET NULL,
  source           VARCHAR(4) NOT NULL DEFAULT 'a' CHECK (source IN ('a','b')),
  feature_vector   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ml_prob          REAL NOT NULL,                       -- 0..1 from the model
  rule_score       INTEGER NOT NULL,                    -- existing risk-engine score
  blended_score    INTEGER NOT NULL,                    -- 0.6*ml + 0.4*rule
  threshold        REAL NOT NULL,
  predicted_fraud  BOOLEAN NOT NULL,
  flag_action      VARCHAR(10) NOT NULL DEFAULT 'observe'
                   CHECK (flag_action IN ('observe','flag','block')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_pred_user ON ml_predictions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_pred_model ON ml_predictions(model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_pred_recent ON ml_predictions(created_at DESC);

-- Seed a "mock" model so the system can be exercised end-to-end
-- without uploading a real ONNX file. ML is OFF by default; admin
-- turns it on with admin_settings.ml_enabled=true.
INSERT INTO ml_models (name, version, provider, status, training_metrics, feature_columns, notes)
VALUES (
  'xgboost_mock',
  '0.1.0',
  'mock',
  'retired',                       -- not 'active' until admin enables ML
  jsonb_build_object(
    'model','mock',
    'note','fallback model; admin must upload a trained ONNX to use real predictions',
    'auc',0.5, 'precision',0.5, 'recall',0.5, 'f1',0.5
  ),
  jsonb_build_array('placeholder_feature'),
  'Mock fallback. Admin can replace via /api/admin/ml/models/upload.'
)
ON CONFLICT (name, version) DO NOTHING;

-- Default admin_settings (admin can change via /admin/settings).
-- ALL keys default to off/safe — admin must explicitly turn on ML.
INSERT INTO admin_settings (key, value, description) VALUES
  ('ml_enabled',                'false', 'Master switch. When false, rule engine is the only signal. Recommended to keep OFF until a trained model is uploaded and reviewed.'),
  ('ml_active_model_id',        '',      'UUID of the active ml_models row. Set automatically by the activate endpoint.'),
  ('ml_min_score_to_flag',      '0.65',  'Probability threshold above which a prediction fires ml_high_risk alert.'),
  ('ml_ab_traffic_pct',         '100',   'Percent of recalculateRisk calls that also run ML inference. 100 = all calls, 0 = disabled even if ml_enabled.'),
  ('ml_provider',               'mock',  'Inference provider: mock (safe default) or onnx (real model, requires ml Active row).'),
  ('ml_auto_retrain_enabled',   'false', 'Reserved for future cron. Disabled by default; admins upload models manually.'),
  ('ml_auto_retrain_cron',      '0 3 * * 1', 'Reserved cron schedule for future auto-retrain.'),
  ('ml_blend_weight',           '0.6',   'Weight for ML probability in the blended score: blended = ml_weight*ml + (1-ml_weight)*rule_norm. Range 0..1.'),
  ('ml_feature_logging_enabled','false', 'Record every prediction to ml_predictions for audit. NOT recommended in prod (PII) but useful during evaluation.')
ON CONFLICT (key) DO NOTHING;

-- Audit row so this migration is visible in audit_log.
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.ml_risk_model', 'info',
        jsonb_build_object('migration','037_ml_risk_model',
                          'tables_created', ARRAY['ml_models','ml_training_jobs','ml_predictions'],
                          'seeded_model','xgboost_mock (retired fallback)'));
