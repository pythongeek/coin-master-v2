-- ================================================
-- CryptoFlip — Phase 2.3 Schema Migrations
-- ================================================
-- 2.3 changes: add multiplier column to bets, create server_seeds
-- table for proper seed rotation (separate from per-user game_seeds).
--
-- Apply to live DB:
--   docker exec -i coin-master-postgres-1 \
--     env PGPASSWORD=*** \
--     psql -U cryptoflip -d cryptoflip < 03-migrations-2.3.sql

-- ════════════════════════════════════════════════════════════════
-- ALTER bets: add multiplier column
-- User-chosen risk multiplier (1.01x to 1000x).
-- Higher multiplier = lower win chance = higher payout.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS multiplier DECIMAL(8, 2)
    NOT NULL DEFAULT 1.96
    CHECK (multiplier >= 1.01 AND multiplier <= 1000);

-- Add an index for "high-multiplier games" stats queries
CREATE INDEX IF NOT EXISTS idx_bets_multiplier
  ON bets(multiplier)
  WHERE multiplier >= 10;

-- ════════════════════════════════════════════════════════════════
-- TABLE: server_seeds (for global seed rotation)
-- Separate from `game_seeds` (per-user seeds) — this tracks the
-- GLOBAL server seed that gets rotated every N games.
-- Old seeds stay queryable forever for verification of past games.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS server_seeds (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- the active server seed (revealed once rotation happens)
  server_seed     TEXT NOT NULL,
  -- the hash committed BEFORE the seed was used (provably-fair)
  server_seed_hash TEXT NOT NULL UNIQUE,

  -- bet counter for THIS seed (when active_bets reaches rotation_threshold,
  -- the next bet triggers rotation)
  active_bets     BIGINT NOT NULL DEFAULT 0,
  -- after this many bets with this seed, rotate (e.g. 1000)
  rotation_threshold BIGINT NOT NULL DEFAULT 1000,

  -- lifecycle
  is_active       BOOLEAN NOT NULL DEFAULT true,
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at      TIMESTAMPTZ,    -- when the NEXT seed was created (this one became inactive)
  revealed_at     TIMESTAMPTZ,    -- when the seed value was first exposed publicly

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast "current active seed" lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_seeds_active
  ON server_seeds(is_active)
  WHERE is_active = true;

-- Index for audit/history queries
CREATE INDEX IF NOT EXISTS idx_server_seeds_activated
  ON server_seeds(activated_at DESC);

-- ════════════════════════════════════════════════════════════════
-- CONSTRAINT: at most one active server seed at a time
-- (enforced via the partial unique index above)
-- ════════════════════════════════════════════════════════════════

-- Seed the very first server seed (so the system has one ready immediately)
INSERT INTO server_seeds (server_seed, server_seed_hash, rotation_threshold, is_active)
SELECT
  encode(gen_random_bytes(32), 'hex') AS server_seed,
  encode(digest(encode(gen_random_bytes(32), 'hex'), 'sha256'), 'hex') AS server_seed_hash,
  1000 AS rotation_threshold,
  true AS is_active
WHERE NOT EXISTS (SELECT 1 FROM server_seeds WHERE is_active = true);

-- ✅ Phase 2.3 schema migrations complete
-- (no RAISE NOTICE — see schema.sql)