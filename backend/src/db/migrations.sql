-- ================================================
-- CryptoFlip — Phase 2.2 Schema Migrations
-- ================================================
-- এই ফাইলটি Phase 2.2 এ যোগ হওয়া নতুন টেবিল ও ইনডেক্স।
-- Existing schema.sql এ ডাটা ইতিমধ্যে লোড হয়ে গেছে (2026-06-24),
-- তাই এই ফাইলটি docker-entrypoint-initdb.d এ মাউন্ট করা আছে
-- (02-migrations.sql) — যাতে fresh DB-তেও এই টেবিলগুলো তৈরি হয়।
-- বিদ্যমান running DB-তে apply করতে:
--   docker exec -i coin-master-postgres-1 psql -U cryptoflip_user -d cryptoflip_db < migrations.sql

-- ════════════════════════════════════════════════════════════════
-- TABLE: transactions
-- All money movements: deposits, withdrawals, affiliate payouts,
-- rain distributions, refunds. Separate from bets because bets are
-- the gameplay event; transactions are the money-side ledger.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  -- type determines which fields are required:
  --   'deposit'   → from_external_address, external_tx_hash
  --   'withdrawal'→ to_external_address, external_tx_hash
  --   'bet'       → related_bet_id (money moved INTO bet)
  --   'payout'    → related_bet_id (money moved OUT as win)
  --   'rain'      → related_rain_id (Crypto Rain claim)
  --   'affiliate' → related_user_id (who referred)
  --   'refund'    → related_bet_id
  --   'adjustment'→ admin note required
  type            VARCHAR(20) NOT NULL
                  CHECK (type IN ('deposit', 'withdrawal', 'bet', 'payout', 'rain', 'affiliate', 'refund', 'adjustment')),
  amount          DECIMAL(18, 8) NOT NULL,  -- always positive; sign comes from direction
  currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  -- direction is implicit:
  --   type='bet'     → money LEAVES user wallet (negative impact on balance)
  --   type='payout'  → money ENTERS user wallet (positive impact)
  --   type='deposit' → positive
  --   type='withdrawal' → negative
  -- For audit clarity we still record explicit direction:
  direction       VARCHAR(10) NOT NULL CHECK (direction IN ('credit', 'debit')),

  -- status lifecycle: pending → confirmed | failed | cancelled
  -- 'confirmed' is the only state where balance is officially updated.
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),

  -- optional refs — at least one is set per row
  related_bet_id  UUID REFERENCES bets(id) ON DELETE SET NULL,
  related_rain_id UUID REFERENCES crypto_rain_events(id) ON DELETE SET NULL,
  related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- blockchain fields (for real-money future)
  from_external_address VARCHAR(42),
  to_external_address   VARCHAR(42),
  external_tx_hash      TEXT,
  external_chain        VARCHAR(20),  -- 'ethereum', 'solana', 'tron', etc.

  -- metadata (admin note, IP, etc.)
  metadata        JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,

  -- Constraint: at least one of the related IDs should be set for traceability
  CONSTRAINT chk_related CHECK (
    related_bet_id IS NOT NULL OR
    related_rain_id IS NOT NULL OR
    related_user_id IS NOT NULL OR
    type IN ('deposit', 'withdrawal', 'adjustment')
  )
);

-- ════════════════════════════════════════════════════════════════
-- TABLE: audit_log
-- Append-only log of sensitive actions: admin config changes,
-- admin user promotions, JWT issuance (suspicious patterns),
-- rate-limit triggers, security events.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- who (NULL for system/anonymous events)
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

  -- action category + specific event
  -- categories: 'admin', 'auth', 'security', 'config', 'system'
  category        VARCHAR(20) NOT NULL
                  CHECK (category IN ('admin', 'auth', 'security', 'config', 'system')),
  action          VARCHAR(100) NOT NULL,  -- e.g. 'config.update', 'auth.login', 'security.rate_limit'

  -- request context
  ip_address      INET,
  user_agent      TEXT,

  -- the actual change (if any)
  -- for 'config.update': { key: 'houseEdgePercent', old: 2.0, new: 3.0 }
  -- for 'admin.promote': { username: 'alice' }
  -- for 'security.rate_limit': { route: '/api/auth/login', count: 12 }
  details         JSONB DEFAULT '{}',

  -- severity for log filtering
  severity        VARCHAR(10) NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('debug', 'info', 'warn', 'error', 'critical')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════
-- TABLE: fraud_signals
-- Persistent record of suspicious patterns: multiple accounts from
-- same IP, device fingerprint collisions, bet timing anomalies,
-- bonus abuse signals. Used by fraud-detection middleware.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fraud_signals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- the user this signal is about (NULL = system-wide)
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,

  -- signal type:
  --   'multi_account' → same fingerprint/IP across many accounts
  --   'velocity'       → too many bets in too little time
  --   'bonus_abuse'    → signup → withdraw pattern with no gameplay
  --   'match_fixing'    → suspicious win/loss correlation
  --   'device_shared'  → multiple users on same device fingerprint
  --   'geo_anomaly'    → bet from unexpected country/IP
  --   'manual'         → admin-flagged
  signal_type     VARCHAR(30) NOT NULL,
  severity        VARCHAR(10) NOT NULL DEFAULT 'low'
                  CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- the evidence: depends on signal_type
  fingerprint     TEXT,  -- browser/device fingerprint (hashed)
  ip_address      INET,
  related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- 'open' = not yet reviewed, 'confirmed' = real fraud, 'false_positive' = reviewed + cleared
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'confirmed', 'false_positive', 'resolved')),
  resolution_notes TEXT,

  metadata        JSONB DEFAULT '{}',
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════════
-- INDEXES — Phase 2.2 additions
-- ════════════════════════════════════════════════════════════════

-- transactions: (user_id, created_at DESC) for "my recent activity" feeds
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON transactions(user_id, created_at DESC);

-- transactions: partial index for pending withdrawals (small set, hot path)
CREATE INDEX IF NOT EXISTS idx_transactions_pending_withdrawals
  ON transactions(created_at)
  WHERE status = 'pending' AND type = 'withdrawal';

-- transactions: status + type for admin dashboards
CREATE INDEX IF NOT EXISTS idx_transactions_status_type
  ON transactions(status, type, created_at DESC);

-- audit_log: (user_id, created_at DESC) for "user activity history"
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created
  ON audit_log(user_id, created_at DESC);

-- audit_log: (category, severity, created_at DESC) for admin filters
CREATE INDEX IF NOT EXISTS idx_audit_log_category_severity
  ON audit_log(category, severity, created_at DESC);

-- fraud_signals: (user_id, status) where status='open' for the active queue
CREATE INDEX IF NOT EXISTS idx_fraud_signals_open
  ON fraud_signals(user_id, detected_at DESC)
  WHERE status = 'open';

-- fraud_signals: fingerprint lookups (catches multi-account abuse)
CREATE INDEX IF NOT EXISTS idx_fraud_signals_fingerprint
  ON fraud_signals(fingerprint)
  WHERE fingerprint IS NOT NULL;

-- fraud_signals: IP lookups (catches geo-velocity abuse)
CREATE INDEX IF NOT EXISTS idx_fraud_signals_ip
  ON fraud_signals(ip_address)
  WHERE ip_address IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- FOREIGN-KEY BRIDGES — connect existing tables to new audit/transaction
-- infrastructure (for future code, not for this migration)
-- ════════════════════════════════════════════════════════════════

-- Add an `is_suspicious` flag to users (set when a fraud_signal becomes
-- 'confirmed') — useful for blocking withdrawals automatically
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN NOT NULL DEFAULT false;

-- Add an `affiliate_code` to users (for the future affiliate program)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS affiliate_code VARCHAR(20) UNIQUE;

-- Add a `referred_by` to users (FK to users.id, who referred them)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ════════════════════════════════════════════════════════════════
-- TRIGGER: auto-confirm transactions on bet resolution
-- (Future; the bets → transactions pipeline is wired in Phase 2.3)
-- ════════════════════════════════════════════════════════════════
-- (intentionally empty here — added in Phase 2.3 when the game
-- engine emits transactions alongside bet resolution)

-- ✅ Phase 2.2 schema migrations complete
-- (no RAISE NOTICE — PL/pgSQL syntax outside DO block, see schema.sql)