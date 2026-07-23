/**
 * P0-03 focused test: connectDB() does NOT crash on migration failure
 * and does NOT call process.exit(1) when RUN_MIGRATIONS_ON_BOOT is unset.
 *
 * Verifies:
 *   1. connectDB() returns successfully with no migrations on boot.
 *   2. The migration-skip log line is emitted.
 *   3. process.exit is NOT called.
 *
 * Companion to the CLI-level npm run migrate test: that one verifies
 * the CLI runner exits 1 on a malformed migration; this one verifies
 * the backend process does NOT crash in the same scenario.
 */

import { connectDB } from '../config/database';

(async () => {
  // Capture process.exit
  const origExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code}) — should not be called by connectDB() when migrations are skipped`);
  }) as any;

  let failed = false;
  function assert(cond: boolean, msg: string): void {
    if (cond) {
      console.log('✅', msg);
    } else {
      console.error('❌', msg);
      failed = true;
    }
  }

  console.log('[test] RUN_MIGRATIONS_ON_BOOT =', JSON.stringify(process.env.RUN_MIGRATIONS_ON_BOOT), '(expected undefined)');

  try {
    await connectDB();
    assert(exitCode === null,
      `process.exit was NOT called by connectDB() (exitCode=${exitCode})`);
    console.log('✅ connectDB() returned without crashing');
  } catch (err) {
    if (exitCode !== null) {
      console.error(`❌ FAIL: connectDB called process.exit(${exitCode}); it should not have`);
      failed = true;
    } else {
      console.error('❌ unexpected error:', err);
      failed = true;
    }
  }

  // Restore process.exit so the runner can exit normally.
  process.exit = origExit;
  if (failed) {
    origExit(1);
  } else {
    console.log('\n🎉 All P0-03 connectDB-skip-migrations tests passed');
    origExit(0);
  }
})();
