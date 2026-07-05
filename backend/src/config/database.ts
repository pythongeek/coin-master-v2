import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL কানেকশন পুল
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                  // সর্বোচ্চ কানেকশন সংখ্যা
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// কানেকশন টেস্ট
export async function connectDB(): Promise<void> {
  try {
    const client = await db.connect();
    
    // Ensure KYC, Role, 2FA, and VIP Rakeback columns exist
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_applicant_id VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_temp_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_wagered DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_rakeback DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_affiliate_balance DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_affiliate_earned DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000;

      -- Immutable audit log chain hash
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_hash VARCHAR(64);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_chain_hash ON audit_logs(chain_hash);
    `);

    // Ensure transactions table constraint includes affiliate_reward and jackpot
    const txTableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'transactions'
      );
    `);
    if (txTableCheck.rows[0].exists) {
      // NOTE: 'payout' is kept for backwards compatibility with the
      // pre-merge local schema. The merged schema uses 'win' for the
      // same concept going forward, but the live DB has 121 historical
      // rows with type='payout' that we cannot drop or rewrite without
      // losing the bet-history. Both names are valid; the frontend
      // treats them identically.
      await client.query(`
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
        ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'payout', 'rakeback', 'rain', 'bonus', 'fee', 'affiliate_reward', 'jackpot'));
      `);
    }

    // Populate referral_code for users who do not have one
    const usersWithoutCode = await client.query(
      'SELECT id FROM users WHERE referral_code IS NULL'
    );
    for (const row of usersWithoutCode.rows) {
      let code = '';
      let isUnique = false;
      while (!isUnique) {
        const rand = Math.floor(100000 + Math.random() * 900000);
        code = `CF${rand}`;
        const check = await client.query('SELECT id FROM users WHERE referral_code = $1', [code]);
        if (check.rows.length === 0) {
          isUnique = true;
        }
      }
      await client.query(
        'UPDATE users SET referral_code = $1 WHERE id = $2',
        [code, row.id]
      );
    }


    // Ensure default jackpot settings exist in admin_settings
    await client.query(`
      INSERT INTO admin_settings (key, value, description) VALUES
        ('jackpot_enabled', 'true', 'প্রোগ্রেসিভ জ্যাকপট চালু'),
        ('jackpot_min_bet', '1.00', 'জ্যাকপটের জন্য সর্বনিম্ন বেট পরিমাণ'),
        ('jackpot_contribution_percent', '1.00', 'বেটের শতকরা কত অংশ জ্যাকপট পুলে যোগ হবে'),
        ('jackpot_hit_chance', '10000', 'জ্যাকপট জয়ের সম্ভাবনা (১/X)'),
        ('jackpot_start_pool', '10.00', 'জ্যাকপট শুরুর পুলের পরিমাণ'),
        ('jackpot_pool', '10.00', 'জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থ')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Ensure Webhook Subscriptions and Logs tables exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        url         TEXT NOT NULL,
        secret      VARCHAR(255) NOT NULL,
        events      TEXT[] NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        subscription_id UUID REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
        event_type      VARCHAR(50) NOT NULL,
        payload         JSONB NOT NULL,
        response_status INTEGER,
        response_body   TEXT,
        error_message   TEXT,
        attempt         INTEGER NOT NULL,
        success         BOOLEAN NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_logs_subscription ON webhook_logs(subscription_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at DESC);
    `);

    // Ensure Promo Codes and User Promos tables exist
    await client.query(`
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
    `);

    // Ensure default promo codes exist
    await client.query(`
      INSERT INTO promo_codes (code, type, value, max_uses, max_bonus_amount, expires_at, is_active)
      VALUES 
        ('WELCOME10', 'no_deposit', 10.00, 0, NULL, NOW() + INTERVAL '1 year', true),
        ('MATCH100', 'deposit_match', 1.00, 0, 500.00, NOW() + INTERVAL '1 year', true)
      ON CONFLICT (code) DO NOTHING;
    `);

    // Alter users table to add fingerprint, registration_ip, and is_flagged columns
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip VARCHAR(45);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT false;
    `);

    // Ensure Fraud Logs table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS fraud_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        fingerprint VARCHAR(255),
        details TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_fraud_logs_user_id ON fraud_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_fraud_logs_created_at ON fraud_logs(created_at DESC);
    `);

    // Ensure audit_logs table, indexes and trigger function exist
    await client.query(`
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
    `);

    // Helper to drop and create triggers on tables if they exist
    const tablesToAudit = ['users', 'wallets', 'bets', 'transactions'];
    for (const table of tablesToAudit) {
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        );
      `, [table]);
      
      if (tableCheck.rows[0].exists) {
        await client.query(`
          DROP TRIGGER IF EXISTS ${table}_audit ON ${table};
          CREATE TRIGGER ${table}_audit AFTER INSERT OR UPDATE OR DELETE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION audit_trigger();
        `);
      }
    }

    // Ensure achievements tables exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS achievements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(120) NOT NULL,
        description TEXT NOT NULL,
        icon VARCHAR(40) NOT NULL DEFAULT 'Trophy',
        category VARCHAR(40) NOT NULL DEFAULT 'general',
        condition_type VARCHAR(40) NOT NULL CHECK (condition_type IN ('total_bets', 'total_wins', 'win_streak', 'loss_streak', 'total_wagered', 'net_pnl', 'biggest_win', 'referrals')),
        condition_value DECIMAL(18, 8) NOT NULL DEFAULT 1,
        coin_reward DECIMAL(18, 8) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_achievements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
        progress DECIMAL(18, 8) NOT NULL DEFAULT 0,
        unlocked_at TIMESTAMPTZ,
        rewarded_at TIMESTAMPTZ,
        UNIQUE(user_id, achievement_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_achievements_unlocked ON user_achievements(user_id, unlocked_at);

      INSERT INTO achievements (key, name, description, icon, category, condition_type, condition_value, coin_reward, sort_order) VALUES
        ('first_bet', 'First Flip', 'Place your first bet.', 'Play', 'milestone', 'total_bets', 1, 1, 10),
        ('bettor_100', '100 Flips', 'Place 100 bets.', 'Dices', 'volume', 'total_bets', 100, 5, 20),
        ('bettor_1000', '1,000 Flips', 'Place 1,000 bets.', 'Dices', 'volume', 'total_bets', 1000, 25, 30),
        ('winner_10', '10 Wins', 'Win 10 bets.', 'Coins', 'wins', 'total_wins', 10, 2, 40),
        ('winner_100', '100 Wins', 'Win 100 bets.', 'Coins', 'wins', 'total_wins', 100, 15, 50),
        ('streak_5', 'Hot Streak', 'Win 5 bets in a row.', 'Flame', 'streak', 'win_streak', 5, 10, 60),
        ('streak_10', 'Legendary Streak', 'Win 10 bets in a row.', 'Flame', 'streak', 'win_streak', 10, 50, 70),
        ('high_roller', 'High Roller', 'Wager $1,000 in total.', 'Banknote', 'volume', 'total_wagered', 1000, 20, 80),
        ('whale', 'Whale', 'Wager $50,000 in total.', 'Banknote', 'volume', 'total_wagered', 50000, 200, 90),
        ('in_the_green', 'In the Green', 'Reach $100 net profit.', 'TrendingUp', 'profit', 'net_pnl', 100, 10, 100)
      ON CONFLICT (key) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        category = EXCLUDED.category,
        condition_type = EXCLUDED.condition_type,
        condition_value = EXCLUDED.condition_value,
        coin_reward = EXCLUDED.coin_reward,
        sort_order = EXCLUDED.sort_order;
    `);

    // Ensure daily_wheel_spins table exists
    // (Migration 2.3 — Daily Login Wheel)
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_wheel_spins (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_spin_at TIMESTAMPTZ,
        last_prize_label VARCHAR(120),
        last_prize_value DECIMAL(18, 8) NOT NULL DEFAULT 0,
        server_seed_hash VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_wheel_spins_user ON daily_wheel_spins(user_id);
    `);

    // Ensure bonus_campaigns and bonus_campaign_claims tables exist
    // (Migration 2.8 — Bonus Campaign Management System)
    await client.query(`
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

      INSERT INTO admin_settings (key, value, description) VALUES
        ('bonusWelcomeAmount',           '10',  'Welcome bonus amount in coins (admin-editable)'),
        ('bonusWagerMultiplier',         '30',  'Wagering multiplier — bonus × N = wagering required'),
        ('bonusMaxWithdrawalMultiplier', '3',   'Max withdrawal = bonus × N'),
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
    `);

    const result = await client.query('SELECT NOW() as now, version()');
    client.release();

    console.log('✅ PostgreSQL কানেক্টেড!');
    console.log(`📅 সার্ভার সময়: ${result.rows[0].now}`);
  } catch (error) {
    console.error('❌ PostgreSQL কানেক্ট করতে সমস্যা:', error);
    process.exit(1);
  }
}

// Helper: Query চালানোর জন্য
// Optional generic lets callers type the returned rows; defaults to
// the pg driver's QueryResult<any>. Many call sites use the generic
// to get typed `rows[0].field` access without casting. The
// `extends QueryResultRow` constraint is required by pg@8.x types.
// We use a Record<string, any> default that satisfies the constraint
// but is permissive enough to be useful as "no type info".
import type { QueryResultRow } from 'pg';
type DefaultRow = Record<string, any>;
export async function query<T extends QueryResultRow = DefaultRow>(text: string, params?: unknown[]) {
  const start = Date.now();
  try {
    const result = await db.query<T>(text, params);
    const duration = Date.now() - start;

    if (process.env.NODE_ENV === 'development') {
      console.log(`🗄️ Query: ${text.substring(0, 50)}... | ${duration}ms`);
    }

    return result;
  } catch (error) {
    console.error('❌ Database query error:', error);
    throw error;
  }
}

/**
 * Run a callback inside a database transaction. The callback receives
 * a `txQuery` function that runs queries on the same connection (and
 * therefore the same transaction). On any throw, the transaction is
 * rolled back. Used by services that need atomic multi-step writes
 * (payments, bonus calculations, wallet operations).
 *
 * The `txQuery` parameter intentionally has a simple `(text, params)`
 * signature, NOT the full `query<T>` type — that avoids the
 * `pg.QueryResultRow` constraint and keeps the callback ergonomic.
 * Callers needing typed rows can cast inside the callback.
 */
export async function withTransaction<T>(
  callback: (txQuery: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(async (text, params) => {
      const r = await client.query(text, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a database query inside a transaction, setting session audit variables.
 */
export async function queryAudited(
  userId: string | null,
  ip: string | null,
  userAgent: string | null,
  text: string,
  params?: unknown[]
) {
  const start = Date.now();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    if (userId) {
      await client.query(`SELECT set_config('audit.user_id', $1, true)`, [userId]);
    } else {
      await client.query(`SELECT set_config('audit.user_id', '', true)`);
    }
    
    if (ip) {
      await client.query(`SELECT set_config('audit.ip_address', $1, true)`, [ip]);
    } else {
      await client.query(`SELECT set_config('audit.ip_address', '', true)`);
    }
    
    if (userAgent) {
      await client.query(`SELECT set_config('audit.user_agent', $1, true)`, [userAgent]);
    } else {
      await client.query(`SELECT set_config('audit.user_agent', '', true)`);
    }
    
    const result = await client.query(text, params);
    await client.query('COMMIT');
    
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log(`🗄️ Audited Query: ${text.substring(0, 50)}... | ${duration}ms`);
    }
    
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Audited database query error:', error);
    throw error;
  } finally {
    client.release();
  }
}
