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
    `);

    // Ensure transactions table constraint includes affiliate_reward and jackpot
    const txTableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'transactions'
      );
    `);
    if (txTableCheck.rows[0].exists) {
      await client.query(`
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
        ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'rakeback', 'rain', 'bonus', 'fee', 'affiliate_reward', 'jackpot'));
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
export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  try {
    const result = await db.query(text, params);
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
