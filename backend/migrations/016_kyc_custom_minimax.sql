-- KYC sessions table for custom MiniMax-powered KYC
CREATE TABLE IF NOT EXISTS kyc_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'review', 'rejected')),
  provider VARCHAR(20) NOT NULL DEFAULT 'minimax',
  external_session_id VARCHAR(100),
  risk_score INTEGER,
  risk_tier VARCHAR(20),
  final_decision VARCHAR(20),
  document_valid BOOLEAN,
  face_match BOOLEAN,
  face_similarity DECIMAL(5,4),
  liveness_passed BOOLEAN,
  sanctions_clear BOOLEAN,
  extracted_fields JSONB,
  fraud_signals JSONB,
  compliance_reasoning TEXT,
  raw_result JSONB,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kyc_sessions_user_id ON kyc_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_sessions_status ON kyc_sessions(status);
CREATE INDEX IF NOT EXISTS idx_kyc_sessions_created_at ON kyc_sessions(created_at DESC);

-- Default KYC settings in admin_settings
INSERT INTO admin_settings (key, value, description) VALUES
  ('kyc_provider', 'manual', 'KYC provider: minimax or manual'),
  ('kyc_minimax_api_key_encrypted', '', 'Encrypted MiniMax API key for KYC verification'),
  ('kyc_minimax_model', 'MiniMax-M3', 'MiniMax model name for KYC'),
  ('kyc_minimax_base_url', 'https://api.minimax.io/v1', 'MiniMax API base URL'),
  ('kyc_required_for_withdrawal', 'true', 'Require KYC before withdrawal'),
  ('kyc_required_for_bet_above', '500', 'Require KYC for bets above this amount'),
  ('kyc_auto_approve_threshold', '30', 'Risk score below this is auto-approved'),
  ('kyc_auto_reject_threshold', '70', 'Risk score above this is auto-rejected'),
  ('kyc_max_file_size_bytes', '10485760', 'Max KYC image upload size in bytes'),
  ('kyc_allowed_extensions', 'jpg,jpeg,png', 'Allowed KYC image extensions')
ON CONFLICT (key) DO NOTHING;

-- Ensure users table has kyc_status if not already present
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'unverified';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ;

-- Audit log helper function (if not exists) — used for KYC events
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID,
  action VARCHAR(100) NOT NULL,
  service VARCHAR(100) NOT NULL,
  payload JSONB,
  result JSONB,
  ip_address VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
