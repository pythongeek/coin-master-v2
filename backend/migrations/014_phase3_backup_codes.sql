-- migrate:up
-- Phase 3 — Engineering Excellence sample migration
-- Documents the existing 2FA backup-codes table so we have one canonical
-- new migration added during Phase 3 work. Idempotent so it is safe to run.

CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    VARCHAR(255) NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_two_factor_backup_codes_user_id
  ON two_factor_backup_codes(user_id);

-- migrate:down
DROP TABLE IF EXISTS two_factor_backup_codes;