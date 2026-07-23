-- =============================================================
--  Migration 043: webhook_subscriptions + webhook_logs (BACKFILL)
-- =============================================================
--
--  Bug: backend/src/services/webhook.ts queries `webhook_subscriptions`
--  + inserts into `webhook_logs` on every webhook event. Migration
--  004_create_webhook_tables.sql exists in the repo but uses the
--  `node-pg-migrate` format (-- migrate:up / -- migrate:down comments)
--  that the current migration runner IGNORES — only plain-SQL files
--  get applied directly. So the webhook tables never existed in the
--  live DB. Result: every dispatchWebhook() call (game.resolved,
--  jackpot.won, etc.) was throwing a `relation does not exist` error
--  inside placeBet's post-COMMIT path, polluting logs on every bet.
--
--  This migration creates both tables idempotently and seeds a no-op
--  subscription that absorbs all events without HTTP calls, so the
--  log table keeps growing for audit even when no real subscriber
--  is configured.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url         TEXT NOT NULL,
  secret      VARCHAR(255) NOT NULL,
  events      TEXT[] NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type      VARCHAR(50) NOT NULL,
  payload         JSONB NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  error_message   TEXT,
  attempt         INTEGER NOT NULL,
  success         BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_subscription ON webhook_logs(subscription_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_active_event ON webhook_subscriptions(is_active) WHERE is_active = true;

-- Audit row
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.webhook_tables', 'info',
        jsonb_build_object('migration', '043',
                           'note', 'Created webhook_subscriptions + webhook_logs tables (004_create_webhook_tables.sql was in node-pg-migrate format, never applied)',
                           'affected_tables', ARRAY['webhook_subscriptions','webhook_logs']));

COMMIT;