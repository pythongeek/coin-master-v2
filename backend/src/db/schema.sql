-- ================================================
-- CryptoFlip — PostgreSQL Database Schema
-- ================================================
-- এই ফাইলটি Docker চালু হলে স্বয়ংক্রিয়ভাবে রান হয়

-- UUID এক্সটেনশন এনাবল
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── TABLE: users ──────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      VARCHAR(30)  UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE,
  wallet_address VARCHAR(42) UNIQUE,         -- MetaMask/Phantom wallet
  password_hash  TEXT,                        -- Email login এর জন্য
  balance        DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000, -- ক্রিপ্টো ব্যালেন্স
  is_active      BOOLEAN NOT NULL DEFAULT true,
  is_admin       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── TABLE: game_seeds ─────────────────────────────
-- Provably Fair এর জন্য সিড স্টোরেজ
CREATE TABLE IF NOT EXISTS game_seeds (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  server_seed    TEXT NOT NULL,              -- হ্যাশ করা সার্ভার সিড
  server_seed_hash TEXT NOT NULL,           -- ইউজারকে দেখানো হ্যাশ
  client_seed    TEXT NOT NULL,              -- ইউজারের সিড
  nonce          INTEGER NOT NULL DEFAULT 0, -- প্রতি গেমে বাড়বে
  is_revealed    BOOLEAN NOT NULL DEFAULT false, -- গেম শেষে সত্যিকার সিড দেখানো
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── TABLE: bets ───────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  squad_id       UUID,                       -- Squad Flip এর জন্য (nullable)
  seed_id        UUID REFERENCES game_seeds(id),
  choice         VARCHAR(5) NOT NULL CHECK (choice IN ('heads', 'tails')),
  amount         DECIMAL(18, 8) NOT NULL CHECK (amount > 0),
  result         VARCHAR(5) CHECK (result IN ('heads', 'tails')),
  won            BOOLEAN,
  payout         DECIMAL(18, 8) DEFAULT 0,
  house_edge     DECIMAL(5, 2) NOT NULL DEFAULT 2.00,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'resolved', 'cancelled')),
  flip_hash      TEXT,                       -- ভেরিফিকেশনের জন্য
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);

-- ── TABLE: squads ─────────────────────────────────
-- Squad Flip ফিচারের জন্য
CREATE TABLE IF NOT EXISTS squads (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  creator_id     UUID REFERENCES users(id),
  name           VARCHAR(50),
  max_members    INTEGER NOT NULL DEFAULT 5,
  bet_amount_each DECIMAL(18, 8) NOT NULL,   -- প্রত্যেকের অংশ
  total_pool     DECIMAL(18, 8) NOT NULL,    -- মোট পুল
  choice         VARCHAR(5) CHECK (choice IN ('heads', 'tails')),
  status         VARCHAR(20) NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting', 'ready', 'playing', 'finished')),
  result         VARCHAR(5),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

-- ── TABLE: squad_members ──────────────────────────
CREATE TABLE IF NOT EXISTS squad_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  squad_id  UUID REFERENCES squads(id) ON DELETE CASCADE,
  user_id   UUID REFERENCES users(id),
  payout    DECIMAL(18, 8) DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(squad_id, user_id)
);

-- ── TABLE: crypto_rain_events ─────────────────────
-- Crypto Rain ফিচারের জন্য
CREATE TABLE IF NOT EXISTS crypto_rain_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  triggered_by  UUID REFERENCES users(id),   -- কার win streak থেকে ট্রিগার হলো
  trigger_type  VARCHAR(30) NOT NULL DEFAULT 'win_streak',
  total_amount  DECIMAL(18, 8) NOT NULL,     -- মোট রেইন অ্যামাউন্ট
  claimed_amount DECIMAL(18, 8) DEFAULT 0,
  max_claims    INTEGER NOT NULL DEFAULT 20,  -- কতজন ক্লেইম করতে পারবে
  claim_count   INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'exhausted', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 seconds'
);

-- ── TABLE: rain_claims ────────────────────────────
CREATE TABLE IF NOT EXISTS rain_claims (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rain_id     UUID REFERENCES crypto_rain_events(id),
  user_id     UUID REFERENCES users(id),
  amount      DECIMAL(18, 8) NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rain_id, user_id)               -- একজন একবারই ক্লেইম করতে পারবে
);

-- ── TABLE: admin_settings ─────────────────────────
CREATE TABLE IF NOT EXISTS admin_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── DEFAULT ADMIN SETTINGS ────────────────────────
INSERT INTO admin_settings (key, value, description) VALUES
  ('house_edge_percent', '2.00', 'হাউজ এজ পার্সেন্টেজ'),
  ('max_bet_amount', '1000', 'সর্বোচ্চ বেট সীমা'),
  ('min_bet_amount', '0.01', 'সর্বনিম্ন বেট সীমা'),
  ('rain_trigger_streak', '5', 'কতবার জিতলে Crypto Rain ট্রিগার হবে'),
  ('rain_budget_daily', '50', 'প্রতিদিনের Crypto Rain বাজেট'),
  ('rain_claim_per_user', '0.10', 'প্রতি ইউজার সর্বোচ্চ কত ক্লেইম করতে পারবে'),
  ('max_squad_size', '5', 'Squad এ সর্বোচ্চ সদস্য সংখ্যা')
ON CONFLICT (key) DO NOTHING;

-- ── INDEXES ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bets_user_id    ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_status     ON bets(status);
CREATE INDEX IF NOT EXISTS idx_users_wallet    ON users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_rain_status     ON crypto_rain_events(status, expires_at);

-- ── TRIGGER: updated_at auto-update ───────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ✅ স্কিমা তৈরি সম্পন্ন
-- NOTE: Upstream had a stray `RAISE NOTICE` here which is PL/pgSQL syntax
-- and only valid inside a DO $$ ... $$ block or function body, not as
-- top-level SQL. The schema above is already complete; this was just a
-- confirmation print. Commented out so the init script doesn't fail.
-- RAISE NOTICE 'CryptoFlip Database Schema Successfully Created! ✅';
