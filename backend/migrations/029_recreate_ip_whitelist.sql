-- =============================================================
--  Migration 029: Recreate ip_whitelist table
-- =============================================================
--  The ip_whitelist table exists in code (isIpWhitelisted,
--  AdminIPWhitelist panel) but the original 013 migration dropped
--  it at the end of its `migrate:down` block, so the table never
--  materialized in production. Code referencing it crashes on every
--  signup call → blocks ALL registration.
--
--  This migration recreates the table. Idempotent.
--  No data was stored there (it was always empty), so no backfill.

CREATE TABLE IF NOT EXISTS ip_whitelist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_address VARCHAR(45) NOT NULL UNIQUE,
  reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_whitelist_ip_address ON ip_whitelist(ip_address);