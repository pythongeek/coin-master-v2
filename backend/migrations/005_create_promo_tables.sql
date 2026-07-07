-- migrate:up
-- Promo code system: campaigns and per-user claims

CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(50) UNIQUE NOT NULL,
  type VARCHAR(30) NOT NULL,
  value DECIMAL(18, 8) NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses_count INTEGER NOT NULL DEFAULT 0,
  max_bonus_amount DECIMAL(18, 8),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_promos (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  promo_code_id UUID REFERENCES promo_codes(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  claimed_amount DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, promo_code_id)
);

INSERT INTO promo_codes (code, type, value, max_uses, max_bonus_amount, expires_at, is_active)
VALUES
  ('WELCOME10', 'no_deposit', 10.00, 0, NULL, NOW() + INTERVAL '1 year', true),
  ('MATCH100', 'deposit_match', 1.00, 0, 500.00, NOW() + INTERVAL '1 year', true)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS user_promos;
DROP TABLE IF EXISTS promo_codes;
