-- Migration 017: Create payment gateway and reconciliation tables

-- Wallet balance in coins (used for payment gateway auto-credit)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_balance_coins DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;

-- Payment gateway configuration (caps, limits, enabled flags)
CREATE TABLE IF NOT EXISTS payment_provider_config (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gateway         VARCHAR(50) NOT NULL UNIQUE,
  display_name    VARCHAR(100) NOT NULL,
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  daily_deposit_cap_usdt DECIMAL(18, 8) NOT NULL DEFAULT 10000.00000000,
  min_deposit_usdt DECIMAL(18, 8) NOT NULL DEFAULT 10.00000000,
  max_deposit_usdt DECIMAL(18, 8) NOT NULL DEFAULT 100000.00000000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payment_provider_config (gateway, display_name, is_enabled, daily_deposit_cap_usdt, min_deposit_usdt, max_deposit_usdt)
VALUES
  ('binance_pay', 'Binance Pay', false, 10000, 10, 100000),
  ('redot_pay', 'Redot Pay', false, 10000, 10, 100000)
ON CONFLICT (gateway) DO NOTHING;

-- Payment orders (fiat-gateway deposits)
CREATE TABLE IF NOT EXISTS payment_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  gateway             VARCHAR(50) NOT NULL,
  gateway_order_id    VARCHAR(255),
  merchant_order_id   VARCHAR(255) UNIQUE NOT NULL,
  gateway_trade_id    VARCHAR(255),
  crypto_currency     VARCHAR(20) NOT NULL DEFAULT 'USDT',
  amount_crypto       DECIMAL(18, 8) NOT NULL,
  fx_rate_snapshot    DECIMAL(18, 8) NOT NULL DEFAULT 1.00000000,
  amount_coins        DECIMAL(18, 8) NOT NULL,
  checkout_url        TEXT,
  qr_code_url         TEXT,
  expires_at          TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
  status_message      TEXT,
  ip_address          INET,
  user_agent          TEXT,
  webhook_payload     JSONB,
  webhook_received_at TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_merchant ON payment_orders(merchant_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created_at ON payment_orders(created_at DESC);

CREATE TRIGGER payment_orders_updated_at
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Wallet transactions (topups, purchases, etc.)
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(20) NOT NULL CHECK (type IN ('topup', 'withdrawal', 'purchase', 'refund', 'bonus')),
  amount_coins    DECIMAL(18, 8) NOT NULL,
  currency        VARCHAR(20) NOT NULL DEFAULT 'COIN',
  source          VARCHAR(50),
  note            TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);

-- Reconciliation log
CREATE TABLE IF NOT EXISTS payment_reconciliation_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gateway             VARCHAR(50) NOT NULL DEFAULT 'all',
  checked_count       INTEGER NOT NULL DEFAULT 0,
  confirmed_count     INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  expired_count       INTEGER NOT NULL DEFAULT 0,
  errors              JSONB DEFAULT '[]',
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_run_at ON payment_reconciliation_log(run_at DESC);
