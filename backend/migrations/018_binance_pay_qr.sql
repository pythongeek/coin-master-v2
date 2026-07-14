-- ================================================
-- CryptoFlip — Migration 018: Binance Pay QR Deposits
-- ================================================
-- Adds the schema needed for the Binance Pay "Receive in any
-- cryptocurrency" QR deposit flow. No merchant account required —
-- we use the personal-app QR + per-order memo tag + Binance Spot API
-- to poll the deposit ledger for authoritative verification.
--
-- Apply:
--   docker exec -i coin-master-postgres-1 \
--     psql -U cryptoflip -d cryptoflip < migrations/018_binance_pay_qr.sql

-- ── Expand the gateway CHECK constraint to allow the new gateway value ──
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_gateway_check;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_gateway_check
  CHECK (gateway IN ('binance_pay', 'redot_pay', 'binance_pay_qr'));

-- ── Expand the status CHECK constraint to allow the QR lifecycle states ──
-- pending → awaiting_payment → detected → verifying → paid | failed | expired
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN (
    'pending',         -- legacy
    'awaiting_payment',-- QR created, waiting for user to send
    'detected',        -- ledger entry found, AI scoring in progress
    'verifying',       -- human review (manual hold)
    'paid',            -- credited to wallet (terminal)
    'failed',          -- rejected (terminal)
    'expired',         -- 30-min timer elapsed (terminal)
    'refunded'         -- legacy
  ));

-- ── QR-specific columns ────────────────────────────────────────────────
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS qr_payload      TEXT,
  ADD COLUMN IF NOT EXISTS qr_memo         VARCHAR(32),
  ADD COLUMN IF NOT EXISTS qr_png_data_url TEXT,
  ADD COLUMN IF NOT EXISTS chain           VARCHAR(20) NOT NULL DEFAULT 'BSC',
  ADD COLUMN IF NOT EXISTS receive_address VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receipt_url     TEXT,
  ADD COLUMN IF NOT EXISTS receipt_sha256  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS receipt_ocr     JSONB,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detected_tx_hash  VARCHAR(128),
  ADD COLUMN IF NOT EXISTS detected_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS binance_ledger_entry JSONB,
  ADD COLUMN IF NOT EXISTS llm_verdict       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS llm_confidence    NUMERIC(4, 3),
  ADD COLUMN IF NOT EXISTS llm_reason        TEXT,
  ADD COLUMN IF NOT EXISTS llm_model_version VARCHAR(50),
  ADD COLUMN IF NOT EXISTS llm_scored_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rule_verdict      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS rule_disagreement BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_mode       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_hold_reason  TEXT,
  ADD COLUMN IF NOT EXISTS admin_decided_by  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS admin_decided_at  TIMESTAMPTZ;

-- ── Indexes for the verifier job ───────────────────────────────────────
-- Fast lookup of QR orders that need polling (status in non-terminal state)
CREATE INDEX IF NOT EXISTS idx_payment_orders_qr_pending
  ON payment_orders(status, created_at)
  WHERE gateway = 'binance_pay_qr' AND status IN ('awaiting_payment', 'detected', 'verifying');

-- Unique memo lookup (the memo IS the idempotency key for ledger matching)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_qr_memo
  ON payment_orders(qr_memo)
  WHERE qr_memo IS NOT NULL;

-- Detected tx hash must be globally unique (no double-credit on same on-chain payment)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_detected_tx
  ON payment_orders(detected_tx_hash)
  WHERE detected_tx_hash IS NOT NULL;

-- Admin review queue scan
CREATE INDEX IF NOT EXISTS idx_payment_orders_review_queue
  ON payment_orders(status, created_at DESC)
  WHERE status = 'verifying';

-- ── Seed the binance_pay_qr provider config (disabled by default) ─────
-- Idempotent INSERT - works whether or not the 'environment' column exists from prior migration 017.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_provider_config' AND column_name = 'environment'
  ) THEN
    INSERT INTO payment_provider_config
      (gateway, display_name, is_enabled, environment, daily_deposit_cap_usdt, min_deposit_usdt, max_deposit_usdt)
    VALUES
      ('binance_pay_qr', 'Binance Pay QR', false, 'live', 10000, 10, 100000)
    ON CONFLICT (gateway) DO NOTHING;
  ELSE
    INSERT INTO payment_provider_config
      (gateway, display_name, is_enabled, daily_deposit_cap_usdt, min_deposit_usdt, max_deposit_usdt)
    VALUES
      ('binance_pay_qr', 'Binance Pay QR', false, 10000, 10, 100000)
    ON CONFLICT (gateway) DO NOTHING;
  END IF;
END $$;

-- Payment review decisions (admin hold/release/reject history for feedback loop)
CREATE TABLE IF NOT EXISTS payment_review_decisions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id            UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  admin_id            UUID NOT NULL REFERENCES users(id),
  decision            VARCHAR(20) NOT NULL CHECK (decision IN ('release', 'reject', 'hold')),
  decision_note       TEXT,
  original_verdict    VARCHAR(20),
  original_confidence NUMERIC(4, 3),
  original_reason     TEXT,
  shadow_mode         BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_review_decisions_order ON payment_review_decisions(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_review_decisions_admin ON payment_review_decisions(admin_id);
CREATE INDEX IF NOT EXISTS idx_payment_review_decisions_created ON payment_review_decisions(created_at DESC);

-- ── Receipt uploads storage directory ──────────────────────────────────
-- Stored on local disk under backend/uploads/deposit-receipts/
-- (gitignored; mounted as a Docker volume in production)
CREATE TABLE IF NOT EXISTS deposit_receipt_files (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  original_name   TEXT,
  mime_type       VARCHAR(100),
  size_bytes      INTEGER,
  sha256          VARCHAR(64) NOT NULL,
  ocr_result      JSONB,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_receipt_files_order ON deposit_receipt_files(order_id);
CREATE INDEX IF NOT EXISTS idx_deposit_receipt_files_user  ON deposit_receipt_files(user_id);

-- ✅ LLM prompt versioning (weekly feedback loop writes here; scorer reads latest active row)
CREATE TABLE IF NOT EXISTS llm_prompt_versions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_type     VARCHAR(50) NOT NULL UNIQUE,
  version         INTEGER NOT NULL DEFAULT 1,
  prompt_text     TEXT NOT NULL,
  few_shot_count  INTEGER NOT NULL DEFAULT 0,
  source_decisions INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      VARCHAR(100) DEFAULT 'auto-feedback-loop',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_prompt_versions_active
  ON llm_prompt_versions(prompt_type, is_active, created_at DESC)
  WHERE is_active = true;

-- Migration 018 complete
