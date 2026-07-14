-- =============================================================
--  Migration 026: Admin manual balance adjustments
-- =============================================================
--  1. Add 'admin_adjustment' to transactions.type CHECK
--  2. Create admin_balance_adjustments table for rich audit trail
--  3. Seed admin_settings for per-tx + per-day limits

-- 1. Extend transactions.type CHECK constraint
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'deposit', 'withdrawal', 'bet', 'win', 'rakeback', 'rain',
    'bonus', 'fee', 'admin_adjustment'
  ));

-- 2. Rich audit trail for admin adjustments
CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_user_id uuid NOT NULL REFERENCES users(id),
  direction varchar(10) NOT NULL,           -- 'credit' | 'debit'
  amount_coins numeric(20, 8) NOT NULL,    -- positive number
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  balance_before numeric(20, 8) NOT NULL,
  balance_after numeric(20, 8) NOT NULL,
  reason text NOT NULL,                    -- min 20 chars
  category varchar(50) NOT NULL DEFAULT 'manual',  -- 'manual' | 'goodwill' | 'correction' | 'chargeback' | 'prize' | 'refund' | 'other'
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_balance_adj_user ON admin_balance_adjustments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_balance_adj_admin ON admin_balance_adjustments(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_balance_adj_tx ON admin_balance_adjustments(transaction_id);

-- 3. Admin-configurable safety limits
INSERT INTO admin_settings (key, value, description) VALUES
  ('admin_balance_max_per_adjustment', '100000', 'Max coins in a single admin adjustment (default 100k). 0 = unlimited.'),
  ('admin_balance_max_per_day', '1000000', 'Max total coins an admin can adjust in 24h. 0 = unlimited.'),
  ('admin_balance_notify_user', 'true', 'Send email to user when their balance is adjusted.'),
  ('admin_balance_max_balance_after', '10000000', 'Refuse credit if user balance would exceed this (anti-typo, default 10M).')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
