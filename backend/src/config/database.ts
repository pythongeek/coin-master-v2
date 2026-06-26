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
    
    // Ensure KYC, Role and 2FA columns exist
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_applicant_id VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_temp_secret TEXT;
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
