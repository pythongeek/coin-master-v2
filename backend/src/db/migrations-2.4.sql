-- ================================================
-- CryptoFlip — Phase 2.4 Schema Migrations
-- ================================================
-- 2.4 changes: add Coin wallet architecture (play-money, no real
-- crypto backing, displayed in BDT/USDT/USD via Binance P2P rates).
--
-- Apply to live DB:
--   docker exec -i coin-master-postgres-1 \
--     env PGPASSWORD=*** \
--     psql -U cryptoflip -d cryptoflip < migrations-2.4.sql

-- ════════════════════════════════════════════════════════════════
-- TABLE: wallet_settings
-- Single-row config table for wallet-related settings
-- (rate provider, refresh interval, etc.)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wallet_settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rate_provider       VARCHAR(50) NOT NULL DEFAULT 'binance_p2p',
  rate_refresh_secs   INTEGER NOT NULL DEFAULT 60,
  default_currency    VARCHAR(10) NOT NULL DEFAULT 'USD' CHECK (default_currency IN ('BDT', 'USDT', 'USD')),
  play_money_disclaimer TEXT NOT NULL DEFAULT
    '⚠️ Coins are PLAY MONEY. They have no real-world value. No deposits or withdrawals to real currency are supported.',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO wallet_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- TABLE: rate_cache
-- Cached FX rates for the Coin → BDT/USDT/USD conversions.
-- Fresh rows added by the rate-fetcher; old rows are pruned.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rate_cache (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  base         VARCHAR(10) NOT NULL DEFAULT 'COIN',
  quote        VARCHAR(10) NOT NULL,
  rate         DECIMAL(20, 8) NOT NULL,
  source       VARCHAR(50) NOT NULL DEFAULT 'binance_p2p',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

CREATE INDEX IF NOT EXISTS idx_rate_cache_lookup
  ON rate_cache(base, quote, fetched_at DESC);
-- Note: partial index on `expires_at > NOW()` rejected by Postgres
-- (NOW() is volatile, not immutable). Plain composite index above
-- is good enough — the rate-fetcher will filter `expires_at > NOW()` in
-- the query and the index lets it scan the (base, quote) most-recent-first.

-- ════════════════════════════════════════════════════════════════
-- TABLE: wallet_transactions
-- Play-money wallet activity log (deposits-stub, adjustments, etc.)
-- Different from `transactions` (gameplay money-side ledger from Phase 2.2).
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(20) NOT NULL
                  CHECK (type IN ('topup', 'adjustment', 'bonus')),
  amount_coins    DECIMAL(18, 8) NOT NULL,
  currency        VARCHAR(10) CHECK (currency IN ('BDT', 'USDT', 'USD', 'COIN')),
  amount_display  DECIMAL(18, 8),
  rate_snapshot   DECIMAL(20, 8),
  source          VARCHAR(50) NOT NULL DEFAULT 'system',
  note            TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created
  ON wallet_transactions(user_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- ALTER users: add wallet-level columns (separate from gameplay balance)
-- ════════════════════════════════════════════════════════════════
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_balance_coins DECIMAL(18, 8) NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10) NOT NULL DEFAULT 'USD'
    CHECK (preferred_currency IN ('BDT', 'USDT', 'USD')),
  ADD COLUMN IF NOT EXISTS last_topup_currency VARCHAR(10)
    CHECK (last_topup_currency IS NULL OR last_topup_currency IN ('BDT', 'USDT', 'USD')),
  ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ;

-- Migrate existing users.balance into wallet_balance_coins (one-time backfill)
UPDATE users SET wallet_balance_coins = balance WHERE wallet_balance_coins = 0.0 AND balance > 0.0;

-- ✅ Phase 2.4 schema migrations complete