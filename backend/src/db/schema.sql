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
  kyc_status     VARCHAR(20) NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
  kyc_applicant_id VARCHAR(100),
  kyc_verified_at TIMESTAMPTZ,
  role           VARCHAR(20) NOT NULL DEFAULT 'user',
  two_factor_secret TEXT,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  two_factor_temp_secret TEXT,
  self_excluded_until TIMESTAMPTZ,
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
  target_multiplier DECIMAL(12, 4) NOT NULL DEFAULT 2.0000,
  actual_multiplier DECIMAL(12, 4) NOT NULL DEFAULT 1.9600,
  win_chance     DECIMAL(8, 4) NOT NULL DEFAULT 49.0000,
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
  ('max_squad_size', '5', 'Squad এ সর্বোচ্চ সদস্য সংখ্যা'),
  ('max_win_amount', '50000', 'সর্বোচ্চ জয়ের সীমা প্রতি বেট')
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

-- ── TABLE: wallets ─────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  chain          VARCHAR(50) NOT NULL,                       -- 'ethereum', 'solana', 'bitcoin', etc.
  token_address  VARCHAR(255),                               -- Null for native tokens
  token_symbol   VARCHAR(20) NOT NULL,
  token_decimals INTEGER DEFAULT 18,
  balance        DECIMAL(36, 18) NOT NULL DEFAULT 0.000000000000000000,
  locked_balance DECIMAL(36, 18) NOT NULL DEFAULT 0.000000000000000000,
  deposit_address VARCHAR(255) UNIQUE,
  deposit_address_index INTEGER,                             -- BIP44 index
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, chain, token_address)
);

CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── TABLE: transactions ────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  wallet_id      UUID REFERENCES wallets(id) ON DELETE SET NULL,
  type           VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'rakeback', 'rain', 'bonus', 'fee')),
  amount         DECIMAL(36, 18) NOT NULL CHECK (amount > 0),
  fee            DECIMAL(36, 18) DEFAULT 0.000000000000000000,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'completed', 'failed', 'cancelled')),
  tx_hash        VARCHAR(255),
  block_number   BIGINT,
  confirmations  INTEGER DEFAULT 0,
  required_confirmations INTEGER DEFAULT 6,
  reference_id   UUID,                                       -- Links to bets, etc.
  reference_type VARCHAR(50),                                -- e.g., 'bets', 'rain'
  from_address   VARCHAR(255),
  to_address     VARCHAR(255),
  ip_address     VARCHAR(45),
  user_agent     TEXT,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- ── INDEXES FOR NEW TABLES ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_deposit ON wallets(deposit_address);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);

-- ── TABLE: ledger_alerts ──────────────────────────
CREATE TABLE IF NOT EXISTS ledger_alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  alert_type      VARCHAR(50) NOT NULL, -- 'user_balance_mismatch', 'wallet_balance_mismatch'
  expected_balance DECIMAL(36, 18) NOT NULL,
  actual_balance   DECIMAL(36, 18) NOT NULL,
  mismatch_amount  DECIMAL(36, 18) NOT NULL,
  currency        VARCHAR(20) NOT NULL,
  wallet_id       UUID REFERENCES wallets(id) ON DELETE SET NULL,
  details         JSONB DEFAULT '{}',
  resolved        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_alerts_user_id ON ledger_alerts(user_id);

-- ── TABLE: audit_logs ─────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  table_name VARCHAR(50) NOT NULL,
  record_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data JSONB,
  new_data JSONB,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Trigger for audit logging
CREATE OR REPLACE FUNCTION audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
    v_changed_by UUID;
    v_ip INET;
    v_user_agent TEXT;
BEGIN
    BEGIN
        v_changed_by := NULLIF(current_setting('audit.user_id', true), '')::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_changed_by := NULL;
    END;

    BEGIN
        v_ip := NULLIF(current_setting('audit.ip_address', true), '')::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip := NULL;
    END;

    BEGIN
        v_user_agent := NULLIF(current_setting('audit.user_agent', true), '');
    EXCEPTION WHEN OTHERS THEN
        v_user_agent := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO audit_logs (table_name, record_id, action, old_data, changed_by, ip_address, user_agent)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD), v_changed_by, v_ip, v_user_agent);
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data, changed_by, ip_address, user_agent)
        VALUES (TG_TABLE_NAME, OLD.id, 'UPDATE', row_to_json(OLD), row_to_json(NEW), v_changed_by, v_ip, v_user_agent);
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_logs (table_name, record_id, action, new_data, changed_by, ip_address, user_agent)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW), v_changed_by, v_ip, v_user_agent);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_audit ON users;
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

DROP TRIGGER IF EXISTS wallets_audit ON wallets;
CREATE TRIGGER wallets_audit AFTER INSERT OR UPDATE OR DELETE ON wallets
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

DROP TRIGGER IF EXISTS bets_audit ON bets;
CREATE TRIGGER bets_audit AFTER INSERT OR UPDATE OR DELETE ON bets
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

DROP TRIGGER IF EXISTS transactions_audit ON transactions;
CREATE TRIGGER transactions_audit AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();

-- ✅ স্কিমা তৈরি সম্পন্ন
-- Use DO block for notices in normal client sessions
DO $$
BEGIN
  RAISE NOTICE 'CryptoFlip Database Schema Successfully Created! ✅';
END
$$;


