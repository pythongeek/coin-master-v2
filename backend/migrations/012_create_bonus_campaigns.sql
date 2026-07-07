-- migrate:up
-- Bonus Campaign Management System (Phase 2.8)

CREATE TABLE IF NOT EXISTS bonus_campaigns (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code varchar(60) UNIQUE,
  name varchar(120) NOT NULL,
  description text,
  bonus_type varchar(30) NOT NULL,
  amount_coins numeric(18,8),
  percent numeric(8,4),
  max_amount_coins numeric(18,8),
  free_spin_count integer,
  free_spin_value_coins numeric(18,8),
  wagering_multiplier numeric(8,2) NOT NULL DEFAULT 30,
  wagering_required_coins numeric(18,8) NOT NULL DEFAULT 0,
  max_withdrawal_multiplier numeric(8,2) DEFAULT 3,
  max_withdrawal_coins numeric(18,8),
  min_deposit_to_withdraw_pct numeric(5,2) DEFAULT 50,
  target_user_ids uuid[],
  target_vip_tiers integer[],
  target_countries varchar(10)[],
  min_total_deposit_coins numeric(18,8) NOT NULL DEFAULT 0,
  min_total_bets integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamp with time zone NOT NULL DEFAULT now(),
  ends_at timestamp with time zone,
  claim_window_hours integer,
  expires_after_hours integer NOT NULL DEFAULT 168,
  max_claims_total integer NOT NULL DEFAULT 0,
  claims_count integer NOT NULL DEFAULT 0,
  max_claims_per_user integer NOT NULL DEFAULT 1,
  total_budget_coins numeric(18,8),
  total_paid_coins numeric(18,8) NOT NULL DEFAULT 0,
  requires_opt_in boolean NOT NULL DEFAULT true,
  auto_grant_on_event varchar(40),
  badge_color varchar(20),
  icon varchar(40),
  sort_order integer NOT NULL DEFAULT 100,
  created_by uuid REFERENCES users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bonus_campaigns_active
  ON bonus_campaigns(is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_bonus_campaigns_type
  ON bonus_campaigns(bonus_type) WHERE is_active = true;

-- Extend bonus_claims with campaign references
ALTER TABLE bonus_claims
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES bonus_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grant_source varchar(30) NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS period varchar(30);

CREATE INDEX IF NOT EXISTS idx_bonus_claims_campaign
  ON bonus_claims(campaign_id) WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bonus_campaign_claims (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid NOT NULL REFERENCES bonus_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bonus_claim_id uuid NOT NULL REFERENCES bonus_claims(id) ON DELETE CASCADE,
  amount_coins numeric(18,8) NOT NULL,
  wagering_completed_coins numeric(18,8) NOT NULL DEFAULT 0,
  wagering_required_coins numeric(18,8) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  claimed_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bcc_campaign_status ON bonus_campaign_claims(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_bcc_user_campaign ON bonus_campaign_claims(user_id, campaign_id);

-- Seed default bonus-related admin settings
INSERT INTO admin_settings (key, value, description) VALUES
  ('bonusWelcomeAmount',           '10',  'Welcome bonus amount in coins (admin-editable)'),
  ('bonusWagerMultiplier',         '30',  'Wagering multiplier -- bonus x N = wagering required'),
  ('bonusMaxWithdrawalMultiplier', '3',   'Max withdrawal = bonus x N'),
  ('bonusExpiryDays',              '7',   'Days until bonus expires and is forfeit'),
  ('bonusMinDepositToWithdrawPct', '50',  'Min deposit as % of bonus before withdrawal allowed'),
  ('bonusCooldownHours',           '24',  'Hours after bonus grant before withdrawal allowed'),
  ('bonusDepositMatchPct',         '50',  'Deposit match bonus as % of deposit (0 = disabled)'),
  ('bonusDepositMatchCap',         '100', 'Max deposit match bonus per deposit in coins'),
  ('bonusCashbackPct',             '10',  'Default cashback % of net losses'),
  ('bonusVipMonthlyAmount',        '25',  'Default monthly VIP tier bonus'),
  ('bonusFreeSpinCount',           '5',   'Default number of free spins per welcome campaign'),
  ('bonusFreeSpinValue',           '1',   'Default bet value per free spin (coins)')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Seed default welcome campaign
INSERT INTO bonus_campaigns (
  code, name, description, bonus_type,
  amount_coins, wagering_multiplier, max_withdrawal_multiplier,
  min_deposit_to_withdraw_pct, expires_after_hours,
  requires_opt_in, auto_grant_on_event,
  is_active, sort_order, badge_color, icon,
  max_claims_per_user, claim_window_hours
)
SELECT
  'WELCOME2026',
  'Welcome Bonus',
  'Free coins for new users -- wager 30x to unlock withdrawals.',
  'welcome',
  10.00000000, 30.00, 3.00, 50.00, 168,
  false, 'signup',
  true, 10, 'gold', 'Gift',
  1, 24
WHERE NOT EXISTS (SELECT 1 FROM bonus_campaigns WHERE code = 'WELCOME2026');

-- migrate:down
DROP TABLE IF EXISTS bonus_campaign_claims;
ALTER TABLE bonus_claims DROP COLUMN IF EXISTS campaign_id, DROP COLUMN IF EXISTS grant_source, DROP COLUMN IF EXISTS period;
DROP TABLE IF EXISTS bonus_campaigns;
DELETE FROM admin_settings WHERE key LIKE 'bonus%';
