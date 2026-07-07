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

// Migration runner — replaces inline schema changes
async function runMigrations(): Promise<void> {
  const { execSync } = await import('child_process');
  // path imports removed -- using process.cwd()
  // url import removed -- using process.cwd()

  const projectRoot = process.cwd();
  

  try {
    execSync(
      'npx node-pg-migrate up --no-check-order --migrations-dir migrations',
      {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit',
      }
    );
  } catch (err) {
    console.error('Database migration failed:', err);
    throw err;
  }
}

// কানেকশন টেস্ট + মাইগ্রেশন রান
export async function connectDB(): Promise<void> {
  try {
    const client = await db.connect();

    await runMigrations();

    const result = await client.query('SELECT NOW() as now, version()');
    client.release();

    console.log('PostgreSQL connected!');
    console.log(`Server time: ${result.rows[0].now}`);
  } catch (error) {
    console.error('PostgreSQL connection failed:', error);
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
