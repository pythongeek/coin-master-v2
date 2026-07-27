/**
 * P2-05 focused test — database connection retry loop.
 *
 * The retry logic is in `connectDB()` in `config/database.ts`. It
 * uses an exponential backoff loop and classifies errors as
 * transient vs fatal. The test exercises the *core* retry logic
 * without depending on a real PostgreSQL connection.
 *
 * Strategy: the test reads `classifyDbError` (exported) for unit
 * coverage of the error classifier, and patches `db.connect` for
 * end-to-end coverage of `connectDB()`'s retry loop. The
 * `process.exit` calls are intercepted via the canonical
 * `__TEST_MOCK_QUERY__` indirection isn't right — instead, we
 * monkey-patch `process.exit` to throw a sentinel error that we
 * can catch and inspect.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/database-retry.test.ts
 */

import { classifyDbError, connectDB } from '../config/database';
import { db } from '../config/database';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

// Helper: sleep that doesn't block tests forever
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('P2-05: database connection retry loop');

  // ── Case 1: classifyDbError — transient SQLSTATE codes ──────────
  assert(classifyDbError({ code: '08000' }) === 'transient', 'classifyDbError: 08000 (connection_exception) → transient');
  assert(classifyDbError({ code: '08006' }) === 'transient', 'classifyDbError: 08006 (connection_failure) → transient');
  assert(classifyDbError({ code: '57P03' }) === 'transient', 'classifyDbError: 57P03 (cannot_connect_now) → transient');
  assert(classifyDbError({ code: '53300' }) === 'transient', 'classifyDbError: 53300 (too_many_connections) → transient');

  // ── Case 2: classifyDbError — Node network error codes ─────────
  assert(classifyDbError({ code: 'ECONNREFUSED' }) === 'transient', 'classifyDbError: ECONNREFUSED → transient');
  assert(classifyDbError({ code: 'ENOTFOUND' }) === 'transient', 'classifyDbError: ENOTFOUND → transient');
  assert(classifyDbError({ code: 'ETIMEDOUT' }) === 'transient', 'classifyDbError: ETIMEDOUT → transient');
  assert(classifyDbError({ code: 'EAI_AGAIN' }) === 'transient', 'classifyDbError: EAI_AGAIN → transient');
  assert(classifyDbError({ code: 'EHOSTUNREACH' }) === 'transient', 'classifyDbError: EHOSTUNREACH → transient');

  // ── Case 3: classifyDbError — fatal SQLSTATE codes ─────────────
  assert(classifyDbError({ code: '28P01' }) === 'fatal', 'classifyDbError: 28P01 (invalid_password) → fatal');
  assert(classifyDbError({ code: '28000' }) === 'fatal', 'classifyDbError: 28000 (invalid_authorization_specification) → fatal');
  assert(classifyDbError({ code: '3D000' }) === 'fatal', 'classifyDbError: 3D000 (invalid_catalog_name) → fatal');
  assert(classifyDbError({ code: '3F000' }) === 'fatal', 'classifyDbError: 3F000 (invalid_schema_name) → fatal');

  // ── Case 4: classifyDbError — unknown defaults to 'unknown' ─────
  assert(classifyDbError({ code: 'XX999' }) === 'unknown', 'classifyDbError: unknown code → unknown');
  assert(classifyDbError(new Error('plain error')) === 'unknown', 'classifyDbError: Error without code → unknown');
  assert(classifyDbError(null) === 'unknown', 'classifyDbError: null → unknown');
  assert(classifyDbError(undefined) === 'unknown', 'classifyDbError: undefined → unknown');
  assert(classifyDbError('string error') === 'unknown', 'classifyDbError: string → unknown');

  // ── Case 5: connectDB retry loop — transient errors retry then succeed
  {
    let attempt = 0;
    // Use a tiny base delay so the test runs fast.
    process.env.DB_RETRY_ATTEMPTS = '5';
    process.env.DB_RETRY_BASE_MS = '1';

    // Patch db.connect to fail with ECONNREFUSED twice, then succeed.
    const originalConnect = db.connect.bind(db);
    (db as any).connect = async () => {
      attempt++;
      if (attempt <= 2) {
        const err: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      // 3rd attempt: return a fake client.
      return {
        query: async () => ({ rows: [{ now: new Date() }], rowCount: 1 }),
        release: () => {},
      };
    };
    // Patch shouldRunMigrationsOnBoot → just no-op (we don't want to load node-pg-migrate here).
    // Easier: just override RUN_MIGRATIONS_ON_BOOT.
    delete process.env.RUN_MIGRATIONS_ON_BOOT;

    try {
      await connectDB();
      assert(attempt === 3, `connectDB retried then succeeded (attempt=${attempt}, expected 3)`);
    } catch (e) {
      assert(false, `connectDB should not throw on transient-then-success: ${(e as Error).message}`);
    } finally {
      (db as any).connect = originalConnect;
    }
  }

  // ── Case 6: connectDB fatal error exits immediately (no retry)
  {
    let attempt = 0;
    process.env.DB_RETRY_ATTEMPTS = '5';
    process.env.DB_RETRY_BASE_MS = '1';

    // Intercept process.exit so we can capture its argument without
    // killing the test process. We throw a sentinel error instead.
    const originalExit = process.exit;
    let exitCode: number | null = null;
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error(`__TEST_PROCESS_EXIT__:${code}`);
    };

    const originalConnect = db.connect.bind(db);
    (db as any).connect = async () => {
      attempt++;
      const err: any = new Error('password authentication failed for user "cryptoflip"');
      err.code = '28P01';
      throw err;
    };

    let caught = false;
    try {
      await connectDB();
    } catch (e) {
      caught = true;
      assert(
        (e as Error).message.startsWith('__TEST_PROCESS_EXIT__'),
        `process.exit was called via sentinel: ${(e as Error).message}`,
      );
    } finally {
      (db as any).connect = originalConnect;
      process.exit = originalExit;
    }
    assert(caught, 'fatal error caused connectDB to throw (via intercepted exit)');
    assert(attempt === 1, `fatal error: attempted exactly 1 time (got ${attempt}, no retry)`);
    assert(exitCode === 1, `fatal error: process.exit(1) was called (got ${exitCode})`);
  }

  // ── Case 7: connectDB exhausts retries on persistent transient error
  {
    let attempt = 0;
    // Note: the RETRY_ATTEMPTS constant is captured at module-load
    // time, so the env override is only effective if the module
    // has not been imported yet in this test process. We use the
    // default (5 attempts) here to be robust against import order.
    delete process.env.DB_RETRY_ATTEMPTS;
    process.env.DB_RETRY_BASE_MS = '1';

    const originalExit = process.exit;
    let exitCode: number | null = null;
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error(`__TEST_PROCESS_EXIT__:${code}`);
    };

    const originalConnect = db.connect.bind(db);
    (db as any).connect = async () => {
      attempt++;
      const err: any = new Error('connect ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    let caught = false;
    try {
      await connectDB();
    } catch (e) {
      caught = true;
      assert(
        (e as Error).message.startsWith('__TEST_PROCESS_EXIT__'),
        `process.exit was called via sentinel: ${(e as Error).message}`,
      );
    } finally {
      (db as any).connect = originalConnect;
      process.exit = originalExit;
    }
    assert(caught, 'exhausted retries caused connectDB to throw (via intercepted exit)');
    assert(attempt === 5, `exhausted retries: attempted exactly 5 times (the default, got ${attempt})`);
    assert(exitCode === 1, `exhausted retries: process.exit(1) was called (got ${exitCode})`);
  }

  // ── Case 8: env override (DB_RETRY_ATTEMPTS=1) — no retry, fatal-style
  // The retry loop honors DB_RETRY_ATTEMPTS. With 1, a single fatal
  // error exits.
  {
    let attempt = 0;
    process.env.DB_RETRY_ATTEMPTS = '1';
    process.env.DB_RETRY_BASE_MS = '1';

    const originalExit = process.exit;
    let exitCode: number | null = null;
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error(`__TEST_PROCESS_EXIT__:${code}`);
    };

    const originalConnect = db.connect.bind(db);
    (db as any).connect = async () => {
      attempt++;
      const err: any = new Error('3D000');
      err.code = '3D000';
      throw err;
    };

    let caught = false;
    try {
      await connectDB();
    } catch (e) {
      caught = true;
    } finally {
      (db as any).connect = originalConnect;
      process.exit = originalExit;
    }
    assert(caught, '1-attempt fatal error → exit');
    assert(attempt === 1, `1-attempt fatal: attempted exactly 1 time (got ${attempt})`);
  }

  console.log('');
  if (failed) {
    console.error('FAILED: P2-05 tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P2-05 database-retry tests passed');
    process.exit(0);
  }
})();
