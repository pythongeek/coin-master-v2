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

// Helper: Transaction wrapper (Phase 2.3 added)
// All queries inside the callback run in a single transaction.
// On any error, the entire transaction rolls back.
export async function withTransaction<T>(
  callback: (txQuery: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) => Promise<T>
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
