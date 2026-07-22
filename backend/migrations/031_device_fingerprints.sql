-- =============================================================
--  Migration 031: Device fingerprint registry (Phase 1.1)
-- =============================================================
--  Tracks every device that has ever touched the platform and
--  which user accounts it has touched. Enables:
--    - L04: Multi-account via device detection
--    - L11: Graph fraud (device as an edge type)
--    - L13: Ring detection (clustering)
--
--  Schema:
--    fingerprint_hash   PK; SHA-256 of raw fingerprint from frontend
--    user_ids[]         array of UUIDs that have used this device
--    account_count      denormalized counter (faster queries)
--    trust_level        'trusted' | 'new' | 'suspicious' | 'untrusted'
--    browser_info       jsonb (UA, screen, tz, lang)
--    first_seen_at / last_seen_at
--    suspicious_reason  TEXT (why we marked this device)
--
--  Performance: lookup-by-hash is the hot path; PK is enough.
--  account_count > 2 triggers review per spec.

CREATE TABLE IF NOT EXISTS device_fingerprints (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_hash  VARCHAR(64) NOT NULL UNIQUE,
  user_ids          UUID[] NOT NULL DEFAULT '{}',
  account_count     INTEGER NOT NULL DEFAULT 0,
  trust_level       VARCHAR(20) NOT NULL DEFAULT 'new'
                    CHECK (trust_level IN ('trusted','new','suspicious','untrusted')),
  browser_info      JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspicious_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_fingerprints_trust
  ON device_fingerprints(trust_level);

-- GIN index for "which devices has user X used" lookups (array contains).
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_user_ids_gin
  ON device_fingerprints USING GIN(user_ids);

-- Hot path: count of accounts per device for threshold checks.
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_count
  ON device_fingerprints(account_count DESC);

-- Add per-user device_count denormalized counter (faster than array_size()).
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_count INTEGER NOT NULL DEFAULT 0;

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.device_fingerprints', 'info',
        jsonb_build_object('migration','031_device_fingerprints',
                          'summary','Device fingerprint registry + per-user device_count'));