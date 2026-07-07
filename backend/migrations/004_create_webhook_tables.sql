-- migrate:up
-- Webhook subscription and log tables for event-driven integrations

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

-- migrate:down
DROP TABLE IF EXISTS webhook_logs;
DROP TABLE IF EXISTS webhook_subscriptions;
