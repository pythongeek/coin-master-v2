-- ═══════════════════════════════════════════════════════════════
--  MIGRATION 2.8 — Bonus Campaign Management System
-- ═══════════════════════════════════════════════════════════════
--
--  Adds a full bonus-campaign management layer on top of the
--  existing bonus_claims table. The admin can now:
--    • Create time-bound campaigns for every bonus type
--    • Define wagering requirements, caps, eligible users
--    • Target specific users, VIP tiers, or opt-in
--    • Track claims and metrics per campaign
--
--  Bonus types supported (varchar(30) in bonus_claims.bonus_type):
--    welcome           — new signup bonus
--    deposit_match     — % match on deposit
--    cashback          — % of net losses back
--    free_spin         — N free coin flips (no wager deducted)
--    reload            — % match on subsequent deposits
--    vip_tier          — VIP-tier recurring reward
--    tournament        — leaderboard prize
--    loss_back         — refund % of a losing streak
--    manual            — admin hand-out (vip, comp, goodwill)
--    affiliate_reward  — referral reward
--    rain              — chat rain payout
--
-- ═══════════════════════════════════════════════════════════════

-- ── 1. bonus_campaigns — admin-managed campaign templates ────

CREATE TABLE IF NOT EXISTS bonus_campaigns (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Identity
  code varchar(60) UNIQUE,                         -- e.g. 'WELCOME2026', 'CRYPTO_RAIN_BONUS' (nullable for manual grants)
  name varchar(120) NOT NULL,
  description text,
  -- Type & economics
  bonus_type varchar(30) NOT NULL,                 -- see list above
  amount_coins numeric(18,8),                       -- flat amount (welcome, free_spin prize, manual)
  percent numeric(8,4),                            -- % match (deposit_match, cashback, loss_back, reload)
  max_amount_coins numeric(18,8),                  -- cap per claim (e.g. 100$ max on deposit match)
  free_spin_count integer,                          -- for free_spin type
  free_spin_value_coins numeric(18,8),             -- bet value per free spin
  -- Wagering requirements
  wagering_multiplier numeric(8,2) NOT NULL DEFAULT 30,
  wagering_required_coins numeric(18,8) NOT NULL DEFAULT 0, -- computed/cached
  max_withdrawal_multiplier numeric(8,2) DEFAULT 3,
  max_withdrawal_coins numeric(18,8),              -- optional hard cap
  min_deposit_to_withdraw_pct numeric(5,2) DEFAULT 50,
  -- Eligibility
  target_user_ids uuid[],                          -- specific users (NULL = all)
  target_vip_tiers integer[],                      -- VIP tiers (NULL = all)
  target_countries varchar(10)[],                  -- ISO2 (NULL = all)
  min_total_deposit_coins numeric(18,8) DEFAULT 0, -- user must have deposited at least this much
  min_total_bets integer DEFAULT 0,                -- user must have placed this many bets
  -- Lifecycle
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamp with time zone NOT NULL DEFAULT now(),
  ends_at timestamp with time zone,                -- NULL = no expiry
  claim_window_hours integer,                      -- hours user has to claim after seeing it
  expires_after_hours integer DEFAULT 168,         -- bonus expires 7 days after grant
  -- Limits
  max_claims_total integer DEFAULT 0,              -- 0 = unlimited
  claims_count integer NOT NULL DEFAULT 0,
  max_claims_per_user integer DEFAULT 1,
  total_budget_coins numeric(18,8),                -- optional cap on total payout
  total_paid_coins numeric(18,8) NOT NULL DEFAULT 0,
  -- Opt-in vs auto-grant
  requires_opt_in boolean NOT NULL DEFAULT true,
  auto_grant_on_event varchar(40),                 -- 'signup' | 'deposit' | NULL
  -- Display
  badge_color varchar(20),                         -- 'gold' | 'green' | 'maroon' | 'info'
  icon varchar(40),                                -- lucide icon name
  sort_order integer NOT NULL DEFAULT 100,
  -- Audit
  created_by uuid REFERENCES users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bonus_campaigns_active
  ON bonus_campaigns(is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_bonus_campaigns_type
  ON bonus_campaigns(bonus_type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bonus_campaigns_code
  ON bonus_campaigns(code) WHERE code IS NOT NULL;

-- ── 2. bonus_claims — link to campaign, add tier/period tracking ──

ALTER TABLE bonus_claims
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES bonus_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grant_source varchar(30) NOT NULL DEFAULT 'system',
                                                          -- 'signup' | 'deposit' | 'opt_in' | 'manual' | 'auto'
  ADD COLUMN IF NOT EXISTS period varchar(30);             -- 'daily' | 'weekly' | 'monthly' | 'event'

CREATE INDEX IF NOT EXISTS idx_bonus_claims_campaign
  ON bonus_claims(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bonus_claims_source
  ON bonus_claims(grant_source, status);

-- ── 3. bonus_campaign_claims — detailed per-claim analytics ──

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

-- ── 4. admin_settings — register all tunable bonus parameters ──

INSERT INTO admin_settings (key, value, description) VALUES
  ('bonusWelcomeAmount',                  '10',   'Welcome bonus amount in coins (admin-editable)'),
  ('bonusWagerMultiplier',                '30',   'Wagering multiplier — bonus × N = wagering required'),
  ('bonusMaxWithdrawalMultiplier',        '3',    'Max withdrawal = bonus × N (profit-first default)'),
  ('bonusExpiryDays',                     '7',    'Days until bonus expires and is forfeit'),
  ('bonusMinDepositToWithdrawPct',        '50',   'Min deposit as % of bonus before withdrawal allowed'),
  ('bonusCooldownHours',                  '24',   'Hours after bonus grant before withdrawal allowed'),
  ('bonusDepositMatchPct',                '50',   'Deposit match bonus as % of deposit (0 = disabled)'),
  ('bonusDepositMatchCap',                '100',  'Max deposit match bonus per deposit in coins'),
  ('bonusCashbackPct',                    '10',   'Default cashback % of net losses (when campaign active)'),
  ('bonusVipMonthlyAmount',               '25',   'Default monthly VIP tier bonus'),
  ('bonusFreeSpinCount',                  '5',    'Default number of free spins per welcome campaign'),
  ('bonusFreeSpinValue',                  '1',    'Default bet value per free spin (coins)')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- ── 5. Seed a default "Welcome" campaign so admin UI has something to show ──
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
  'Free coins for new users — wager 30× to unlock withdrawals.',
  'welcome',
  10.00000000, 30.00, 3.00, 50.00, 168,
  false, 'signup',
  true, 10, 'gold', 'Gift',
  1, 24
WHERE NOT EXISTS (SELECT 1 FROM bonus_campaigns WHERE code = 'WELCOME2026');

-- ── 6. Helper function: increment campaign stats atomically ──

CREATE OR REPLACE FUNCTION increment_campaign_stats(
  p_campaign_id uuid,
  p_amount numeric
)
RETURNS void AS $$
BEGIN
  UPDATE bonus_campaigns
    SET claims_count = claims_count + 1,
        total_paid_coins = total_paid_coins + p_amount,
        updated_at = now()
  WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql;