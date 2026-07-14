-- =============================================================
--  FX RATE CACHE - storage for USDT/USD/BDT rates from Binance P2P
-- =============================================================
--
--  Populated by services/rate-fetcher.ts via fetchBinanceP2PRate()
--  Used to power /api/public/fx-rates (public, no auth required)
--  Used to display fiat equivalents alongside USDT amounts
--
--  Refresh: 5-min TTL; rate-fetcher queries Binance P2P on cache miss
--  Storage: keep ~1 hour of history per (base, quote) for debugging
--  No auth needed: rates are public market data

CREATE TABLE IF NOT EXISTS rate_cache (
  id           BIGSERIAL PRIMARY KEY,
  base         VARCHAR(8)  NOT NULL,
  quote        VARCHAR(8)  NOT NULL,
  rate         NUMERIC(20,8) NOT NULL,
  source       VARCHAR(64) NOT NULL DEFAULT 'binance_p2p',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_cache_base_quote
  ON rate_cache(base, quote, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_rate_cache_expires
  ON rate_cache(expires_at);
