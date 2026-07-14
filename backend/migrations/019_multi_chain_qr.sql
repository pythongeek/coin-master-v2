-- ================================================
-- CryptoFlip -- Migration 019: Multi-Chain QR Support
-- ================================================
-- Adds per-chain config storage + memo-supported flag
-- so the verifier can route by chain and handle TRC20
-- (which has no memo-tag on Tether's USDT contract).

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS memo_supported   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sender_address   VARCHAR(128),
  ADD COLUMN IF NOT EXISTS match_strategy   VARCHAR(20) NOT NULL DEFAULT 'memo';

-- match_strategy values:
--   'memo'       -- exact memo match (BSC BEP20 USDT, etc.)
--   'amount'     -- exact amount + time window (TRC20 USDT, no memo)
--   'sender'     -- exact sender address (rare, for hot-wallet-to-hot-wallet)

CREATE INDEX IF NOT EXISTS idx_payment_orders_chain_status
  ON payment_orders(chain, status, created_at)
  WHERE gateway = 'binance_pay_qr';

-- Index for sender-based matching (TRC20 fallback)
CREATE INDEX IF NOT EXISTS idx_payment_orders_sender
  ON payment_orders(sender_address)
  WHERE sender_address IS NOT NULL;

-- Persist enabled chains + their config so admin UI + runtime can read consistently
CREATE TABLE IF NOT EXISTS deposit_chain_config (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chain_key       VARCHAR(20) NOT NULL UNIQUE,        -- 'BSC', 'TRC20', 'ERC20'
  display_name    VARCHAR(100) NOT NULL,
  network_code    VARCHAR(30) NOT NULL,               -- matches Binance ledger 'network' field
  token_symbol    VARCHAR(20) NOT NULL DEFAULT 'USDT',
  deposit_address VARCHAR(128) NOT NULL,
  memo_supported  BOOLEAN NOT NULL DEFAULT true,
  min_confirmations INTEGER NOT NULL DEFAULT 12,
  estimated_seconds INTEGER NOT NULL DEFAULT 60,
  avg_fee_usdt    NUMERIC(10, 4) NOT NULL DEFAULT 0,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  display_order   INTEGER NOT NULL DEFAULT 100,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_chain_config_enabled
  ON deposit_chain_config(is_enabled, display_order);

-- Seed with BSC (already configured) + placeholder TRC20 (disabled until address is set)
INSERT INTO deposit_chain_config
  (chain_key, display_name, network_code, token_symbol, deposit_address, memo_supported,
   min_confirmations, estimated_seconds, avg_fee_usdt, is_enabled, display_order, notes)
VALUES
  ('BSC', 'BNB Smart Chain (BEP20)', 'BSC', 'USDT',
   '0x685c07f81938d98795c2a0fdfbf1759ed92aa61e',
   true, 12, 15, 0.50, true, 10,
   'Cheapest fees, fast confirmation, native memo-tag support.'),
  ('TRC20', 'Tron (TRC20)', 'TRX', 'USDT',
   '', false, 19, 60, 1.00, false, 20,
   'Higher fees but most popular. NO memo-tag on Tether contract -- verifier matches by amount + window.')
ON CONFLICT (chain_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  network_code = EXCLUDED.network_code,
  token_symbol = EXCLUDED.token_symbol,
  memo_supported = EXCLUDED.memo_supported,
  min_confirmations = EXCLUDED.min_confirmations,
  estimated_seconds = EXCLUDED.estimated_seconds,
  avg_fee_usdt = EXCLUDED.avg_fee_usdt,
  display_order = EXCLUDED.display_order,
  notes = EXCLUDED.notes,
  updated_at = NOW();
