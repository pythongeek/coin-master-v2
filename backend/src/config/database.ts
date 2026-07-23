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

// Migration runner — P0-03: REMOVED from connectDB().
//
// `runMigrations()` used to be called inline inside `connectDB()` on
// every backend boot. A syntax error in any future migration would
// throw, propagate to `connectDB()`'s catch, and call
// `process.exit(1)` — putting the backend into an endless restart
// loop on the orchestrator.
//
// Migrations are now driven by the dedicated CLI runner
// `backend/src/migrate-cli/run-migrations.ts`, invoked by `npm run migrate`,
// and by the dedicated `migrate` one-shot service in docker-compose
// (which the backend `depends_on` with `service_completed_successfully`).
//
// The backend's `connectDB()` no longer touches migrations. If you
// need to run migrations on boot for a local dev convenience, set
// `RUN_MIGRATIONS_ON_BOOT=true` — this is OFF by default and logs a
// deprecation warning when enabled (the supported path is the
// standalone CLI).
function shouldRunMigrationsOnBoot(): boolean {
  const raw = (process.env.RUN_MIGRATIONS_ON_BOOT || '').toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    console.warn(
      '[db] WARNING: RUN_MIGRATIONS_ON_BOOT=true — running migrations ' +
      'during backend boot. This is for local-dev convenience only; ' +
      'the supported production path is `npm run migrate` in a separate ' +
      'container / K8s Job. See BACKEND_PROD_READINESS.md P0-03.',
    );
    return true;
  }
  return false;
}

// কানেকশন টেস্ট
export async function connectDB(): Promise<void> {
  try {
    const client = await db.connect();

    const result = await client.query('SELECT NOW() as now, version()');
    client.release();

    console.log('PostgreSQL connected!');
    console.log(`Server time: ${result.rows[0].now}`);

    if (shouldRunMigrationsOnBoot()) {
      // Lazy-import to avoid loading node-pg-migrate in production
      // paths that never enable this flag.
      const { runMigrationsCli } = await import('../migrate-cli/run-migrations');
      const code = await runMigrationsCli();
      if (code !== 0) {
        throw new Error(`migrations exited with code ${code}`);
      }
    } else {
      console.log(
        '[db] Migrations skipped on boot (RUN_MIGRATIONS_ON_BOOT=false). ' +
        'Run `npm run migrate` from a separate container / K8s Job.',
      );
    }
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
