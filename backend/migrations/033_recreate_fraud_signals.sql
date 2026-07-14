-- =============================================================
--  Migration 033: Recreate fraud_signals table
-- =============================================================
--  Same broken-migration pattern as 029/030: src/db/migrations.sql
--  creates fraud_signals but it's never actually applied to fresh
--  DBs. Risk engine (Phase 1.2) reads fraud_signals for IP/device
--  signals. Without this table the signal collector silently
--  returns empty (graceful degradation) but the risk engine is
--  blind to upstream fraud events.
--
--  Schema lifted from src/db/migrations.sql lines 112-142.

CREATE TABLE IF NOT EXISTS fraud_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  signal_type     VARCHAR(30) NOT NULL,
  severity        VARCHAR(10) NOT NULL DEFAULT 'low'
                  CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  fingerprint     TEXT,
  ip_address      INET,
  related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'confirmed', 'false_positive', 'resolved')),
  resolution_notes TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_open
  ON fraud_signals(user_id, detected_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_fraud_signals_fingerprint
  ON fraud_signals(fingerprint)
  WHERE fingerprint IS NOT NULL;