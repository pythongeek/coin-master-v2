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

// P2-05 — Categorize DB connection errors as transient (retry) or
// fatal (exit immediately). Drives the exponential backoff loop
// in `connectDB()`. The lists are based on the libpq / PostgreSQL
// error codes documented at:
//   https://www.postgresql.org/docs/current/errcodes-appendix.html
//   https://node-postgres.com/apis/client#error-handling

/**
 * PostgreSQL SQLSTATE codes that indicate a TRANSIENT error — the
 * connection might succeed if we wait and retry. The classic case is
 * "the database is starting up" or "the pool is exhausted". These
 * errors are NEVER a config bug; they reflect temporary server state.
 */
const TRANSIENT_PG_CODES = new Set<string>([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08007', // transaction_resolution_unknown
  '57P03', // cannot_connect_now — DB is starting up
  '53300', // too_many_connections — pool exhausted
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P05', // idle_session_timeout
]);

/**
 * Node.js network-layer error codes that are TRANSIENT — typically
 * mean "the host is unreachable right now" (DNS, refused, timeout).
 * Same retry rationale as above.
 */
const TRANSIENT_NODE_CODES = new Set<string>([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ETIMEOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
]);

/**
 * PostgreSQL SQLSTATE codes that indicate a FATAL error — retrying
 * will always fail because the error is in our config (wrong password,
 * missing database). Failing fast is correct.
 */
const FATAL_PG_CODES = new Set<string>([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name (database does not exist)
  '3F000', // invalid_schema_name
  '42P01', // duplicate_table / undefined_table
  '42703', // undefined_column
]);

/**
 * Classify a DB error as 'transient' (retry), 'fatal' (exit), or
 * 'unknown' (retry as a precaution; if it persists, the retries
 * will eventually exhaust and we'll exit). The classification uses
 * the SQLSTATE code (PostgreSQL standard) and the Node.js error
 * `code` field (e.g., ECONNREFUSED).
 */
export function classifyDbError(error: unknown): 'transient' | 'fatal' | 'unknown' {
  if (!error || typeof error !== 'object') return 'unknown';
  const e = error as { code?: string };
  if (e.code) {
    if (FATAL_PG_CODES.has(e.code)) return 'fatal';
    if (TRANSIENT_PG_CODES.has(e.code)) return 'transient';
    if (TRANSIENT_NODE_CODES.has(e.code)) return 'transient';
  }
  return 'unknown';
}

/**
 * P2-05 — Exponential backoff configuration. Five attempts with
 * delays 1s, 2s, 4s, 8s, 16s. Total worst-case wait: 31 seconds.
 *
 * Operators can override via env (DB_RETRY_ATTEMPTS, DB_RETRY_BASE_MS)
 * for testing or special environments. Defaults are production-safe.
 */
const RETRY_ATTEMPTS = parseInt(process.env.DB_RETRY_ATTEMPTS || '5', 10);
const RETRY_BASE_MS = parseInt(process.env.DB_RETRY_BASE_MS || '1000', 10);

/**
 * Helper: sleep that respects the global Jest fake-timer test
 * environment. Real production uses `setTimeout`; tests can override
 * via `jest.useFakeTimers()`. We use `setTimeout` from
 * `node:timers/promises` for an async-friendly delay.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Internal helper: try to connect + ping once. Returns the client on
 * success, or throws on failure. The pool itself (the `db` constant)
 * is created at module-load time — `db.connect()` is what fails when
 * the DB is unreachable, because the lazy pool tries to open a real
 * socket on first use.
 */
async function tryOnce(): Promise<void> {
  const client = await db.connect();
  try {
    const result = await client.query('SELECT NOW() as now, version()');
    const serverTime = result.rows[0]?.now;
    console.log('PostgreSQL connected!');
    if (serverTime) {
      console.log(`Server time: ${serverTime}`);
    }
  } finally {
    client.release();
  }
}

/**
 * কানেকশন টেস্ট — P2-05 hardened with exponential backoff retry
 * loop. Five attempts, doubling delay each time (1s, 2s, 4s, 8s,
 * 16s). Classifies errors as transient (retry) vs fatal (exit
 * immediately) using PostgreSQL SQLSTATE codes and Node.js error
 * codes.
 *
 * Behavior:
 *   - Transient error → log warning, wait, retry.
 *   - Fatal error → log error, `process.exit(1)` immediately.
 *   - Unknown error → treat as transient (log + retry). If the issue
 *     is real, the retries will exhaust and we'll exit cleanly.
 *   - All 5 retries exhausted → log fatal summary, `process.exit(1)`.
 */
export async function connectDB(): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await tryOnce();
      // Success — log and exit the loop.
      if (attempt > 1) {
        console.log(`[db] Connected after ${attempt} attempt(s).`);
      }
      // Migration boot (preserved from P0-03).
      if (shouldRunMigrationsOnBoot()) {
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
      return;
    } catch (error) {
      lastError = error;
      const classification = classifyDbError(error);
      if (classification === 'fatal') {
        // Fatal — do not retry, exit immediately.
        console.error(
          `[db] FATAL database error on attempt ${attempt}/${RETRY_ATTEMPTS} — not retrying. ` +
            `Error: ${(error as Error).message ?? String(error)}`,
        );
        process.exit(1);
        return; // unreachable, but tsc-happy
      }
      if (attempt < RETRY_ATTEMPTS) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[db] Transient error on attempt ${attempt}/${RETRY_ATTEMPTS}: ` +
            `${(error as Error).message ?? String(error)}. ` +
            `Retrying in ${delayMs}ms...`,
        );
        await sleep(delayMs);
      }
    }
  }
  // Retries exhausted.
  console.error(
    `[db] FATAL: failed to connect to PostgreSQL after ${RETRY_ATTEMPTS} attempts. ` +
      `Last error: ${(lastError as Error)?.message ?? String(lastError)}`,
  );
  process.exit(1);
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
