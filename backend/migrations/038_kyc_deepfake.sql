-- =============================================================
--  Migration 038: KYC Deepfake Risk Signal (Phase 3 / P3-2a)
-- =============================================================
--
--  This migration adds ONLY the schema + admin_settings defaults.
--  No service code reads from this yet — the admin flag stays
--  OFF. P3-2b/c will add the deepfake-detector service and wire it
--  into kyc-uniqueness.ts. The provider-agnostic contract is:
--  POST {image_url} to kyc_deepfake_endpoint → returns {score}.
--
--  Two new columns on users (nullable, no behavior change yet).
--  One new kyc_deepfake_audit table (logs every check, status='ok'
--  or 'error' or 'skipped' so we have a complete evidence chain
--  the moment the master switch flips).
--
--  Stays a risk-signal only. score_threshold exists but the
--  implementation NEVER auto-blocks — when score >= threshold,
--  it only opens a fraud_signals row status='open' for admin review.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deepfake_score          REAL,
  ADD COLUMN IF NOT EXISTS deepfake_checked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deepfake_check_status  VARCHAR(20)
    -- 'ok' | 'error' | 'skipped' | 'not_run' (default 'not_run')
    -- CHECK CHECK constraint added via separate DO block below
    -- so migration is idempotent if rerun.
;

CREATE TABLE IF NOT EXISTS kyc_deepfake_audit (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
  kyc_submission_id        UUID REFERENCES kyc_submissions(id) ON DELETE SET NULL,
  source_url               TEXT,
  status                   VARCHAR(20) NOT NULL DEFAULT 'not_run'
                           CHECK (status IN ('not_run','ok','error','skipped','timeout')),
  score                    REAL,
  endpoint_url             TEXT,
  duration_ms              INTEGER,
  response_body            JSONB,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_kyc_deepfake_audit_user ON kyc_deepfake_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_deepfake_audit_kyc ON kyc_deepfake_audit(kyc_submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_deepfake_audit_score
  ON kyc_deepfake_audit(created_at DESC) WHERE score IS NOT NULL;

-- Default admin_settings (all OFF / safe).
INSERT INTO admin_settings (key, value, description) VALUES
  ('kyc_deepfake_enabled',         'false', 'Master switch for the deepfake risk-signal pipeline. When false, no calls leave this server. Turn ON only after pointing kyc_deepfake_endpoint at a verified deepfake HTTP service (P3-2c).'),
  ('kyc_deepfake_endpoint',         '',      'Full URL the backend POSTs selfie/image to. e.g. http://deepfake-svc:5001/check. Leave empty to keep the master switch inert. P3-2c reads this.'),
  ('kyc_deepfake_timeout_ms',      '2000',  'HTTP timeout when calling the deepfake endpoint. 2 seconds matches the average KYC upload wall-clock budget.'),
  ('kyc_deepfake_score_threshold', '0.70',  'Probability threshold (0..1). When deepfake_score ≥ threshold AND kyc_deepfake_enabled=true AND kyc_deepfake_block_above=false, the system OPENS a fraud_signals row status=open for admin review. NEVER blocks the user automatically.'),
  ('kyc_deepfake_block_above',     'false', 'Experimental hard-block gate. Stays false for now. When true + score ≥ threshold, the user is flagged is_flagged=true (auto-rejected on bonus attempts) AND a fraud_signals row is opened. Keep false in production until you trust the detector.'),
  ('kyc_deepfake_log_image',       'false', 'When true, the kyc_deepfake_audit row response_body includes a base64 thumbnail of the selfie (PII). Turn ON only for debugging — never in production for compliance reasons.')
ON CONFLICT (key) DO NOTHING;

-- Idempotent CHECK constraint on users.deepfake_check_status.
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_deepfake_check_status_check;
  ALTER TABLE users ADD CONSTRAINT users_deepfake_check_status_check
    CHECK (deepfake_check_status IS NULL OR deepfake_check_status IN ('not_run','ok','error','skipped','timeout'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.kyc_deepfake', 'info',
        jsonb_build_object('migration','038_kyc_deepfake',
                          'new_columns', ARRAY['deepfake_score','deepfake_checked_at','deepfake_check_status'],
                          'new_table','kyc_deepfake_audit',
                          'admin_settings_seeded', 6,
                          'note','P3-2a. Pure schema + settings. No service code touches these yet.'));
