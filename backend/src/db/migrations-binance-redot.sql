-- ================================================
-- CryptoFlip — Phase B.1 Payment Provider Schema
-- ================================================
-- Adds real-money deposit infrastructure (Binance Pay + Redot Pay).
-- All deposits are USDT → internal Coin (1 Coin = 1 USDT, per Phase 2.4).
--
-- Apply to live DB:
--   docker exec -i coin-master-postgres-1 \
--     psql -U cryptoflip -d cryptoflip < migrations-binance-redot.sql

-- ════════════════════════════════════════════════════════════════
-- TABLE: payment_provider_config
-- Per-gateway config (credentials status, enabled/disabled, health)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_provider_config (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gateway           VARCHAR(30) NOT NULL UNIQUE
                    CHECK (gateway IN ('binance_pay', 'redot_pay')),
  is_enabled        BOOLEAN NOT NULL DEFAULT true,
  environment       VARCHAR(10) NOT NULL DEFAULT 'sandbox'
                    CHECK (environment IN ('sandbox', 'live')),
  api_key_last4     VARCHAR(10),       -- last 4 chars of API key (sanitized)
  has_secret        BOOLEAN NOT NULL DEFAULT false,  -- whether secret is configured
  last_webhook_at   TIMESTAMPTZ,
  last_error        TEXT,
  last_error_at     TIMESTAMPTZ,
  daily_deposit_cap_usdt DECIMAL(18, 2) NOT NULL DEFAULT 1000.00,
  min_deposit_usdt       DECIMAL(18, 2) NOT NULL DEFAULT 10.00,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payment_provider_config (gateway, is_enabled, environment, daily_deposit_cap_usdt, min_deposit_usdt)
VALUES
  ('binance_pay', true, 'sandbox', 1000.00, 10.00),
  ('redot_pay',   true, 'sandbox', 1000.00, 10.00)
ON CONFLICT (gateway) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- TABLE: payment_orders
-- One row per deposit attempt. Links user → gateway → wallet credit.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway             VARCHAR(30) NOT NULL
                      CHECK (gateway IN ('binance_pay', 'redot_pay')),
  gateway_order_id    VARCHAR(255),       -- returned by gateway (Binance: prepayId, Redot: tradeNo)
  gateway_trade_id    VARCHAR(255),       -- final trade ID from gateway after payment
  merchant_order_id   VARCHAR(64) NOT NULL UNIQUE,  -- OUR unique order ID (idempotency key)

  -- amounts
  crypto_currency     VARCHAR(10) NOT NULL DEFAULT 'USDT' CHECK (crypto_currency = 'USDT'),
  amount_crypto       DECIMAL(18, 8) NOT NULL CHECK (amount_crypto > 0),
  fx_rate_snapshot    DECIMAL(20, 8) NOT NULL,  -- USDT/USDT rate at time of order (for audit)
  amount_coins        DECIMAL(18, 8) NOT NULL,  -- amount_crypto × fx_rate = Coin amount

  -- payment details
  receive_address     VARCHAR(255),        -- user's deposit address (if applicable)
  checkout_url        TEXT,                 -- gateway's hosted payment page URL
  qr_code_url         TEXT,                 -- QR code image URL (if gateway provides one)
  expires_at          TIMESTAMPTZ NOT NULL, -- when the payment expires (gateway-imposed)

  -- lifecycle
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
  status_message      TEXT,
  webhook_payload     JSONB DEFAULT '{}',   -- raw payload from gateway webhook (audit)
  webhook_received_at TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,

  -- meta
  ip_address          INET,
  user_agent          TEXT,
  metadata            JSONB DEFAULT '{}',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One order per (user, gateway, merchant_order_id) for fast lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_merchant
  ON payment_orders(merchant_order_id);

-- Pending orders: fast lookup for reconciliation job
CREATE INDEX IF NOT EXISTS idx_payment_orders_pending
  ON payment_orders(status, expires_at)
  WHERE status = 'pending';

-- Per-user history queries
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_created
  ON payment_orders(user_id, created_at DESC);

-- Gateway-side order ID lookup (for webhook → merchant_order_id resolution)
CREATE INDEX IF NOT EXISTS idx_payment_orders_gateway_order
  ON payment_orders(gateway, gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- TABLE: payment_reconciliation_log
-- Audit trail of every reconciliation job run
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_reconciliation_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gateway             VARCHAR(30) NOT NULL,
  checked_count       INTEGER NOT NULL DEFAULT 0,
  confirmed_count     INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  expired_count       INTEGER NOT NULL DEFAULT 0,
  errors              JSONB DEFAULT '[]',
  duration_ms         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payment_recon_log_run_at
  ON payment_reconciliation_log(run_at DESC);

-- ════════════════════════════════════════════════════════════════
-- ALTER payment_orders: add columns for reconciliation job tracking
-- ════════════════════════════════════════════════════════════════
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;

-- ✅ Phase B.1 schema migrations complete