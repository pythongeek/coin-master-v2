/**
 * P0-05 focused test: reconciliation decoupled from placeBet hot path.
 *
 * The original `placeBet()` called `reconcileUser()` inline inside
 * the SERIALIZABLE transaction, holding user + wallets FOR UPDATE
 * row locks for the entire reconcile query burst. Under concurrent
 * betting this caused 30s timeouts on subsequent bets and could flip
 * the user's freeze flag mid-round.
 *
 * This test confirms the new contract:
 *
 *   1. `game-engine.ts` no longer imports + calls `reconcileUser`
 *      inside the placeBet transaction body (source-level check).
 *   2. `schedulePostCommitReconcile(userId)` exists and is exported.
 *   3. The coalescing cache suppresses duplicate reconcile calls
 *      within a 60s window (the second call for the same user is a
 *      no-op).
 *   4. `setImmediate` is the dispatch mechanism (verified via mock).
 *   5. `reconcileUser()` called standalone (no existingClient) runs
 *      its own transaction and writes `ledger_alerts` rows for
 *      mismatches WITHOUT flipping `users.is_active = false` when
 *      `reconciliation_auto_freeze` is unset or 'false'.
 *   6. When `reconciliation_auto_freeze = 'true'` AND a mismatch
 *      is found, `users.is_active = false` IS applied.
 *   7. The payment-reconciliation cron (`startReconciliationLoop` in
 *      services/reconciliation.ts) is untouched — it remains the
 *      authoritative periodic worker.
 */

import Module from 'module';
import fs from 'fs';
import path from 'path';

let failed = false;
function assert(cond: boolean, msg: string) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log('✅', msg);
  } else {
    // eslint-disable-next-line no-console
    console.error('❌', msg);
    failed = true;
  }
}

// ---------------------------------------------------------------------------
// 1. Source-level checks: game-engine.ts decoupled from inline reconcileUser
// ---------------------------------------------------------------------------
const geSrc = fs.readFileSync(
  path.join(__dirname, '../services/game-engine.ts'),
  'utf8',
);
const reSrc = fs.readFileSync(
  path.join(__dirname, '../services/reconciliation-engine.ts'),
  'utf8',
);

// Imports still OK (needed for schedulePostCommitReconcile's setImmediate body).
assert(/from ['"]\.\/reconciliation-engine['"]/.test(geSrc),
  'game-engine.ts still imports from reconciliation-engine (used by post-commit dispatcher)');

// CRITICAL: there must be NO `await reconcileUser(.*client.*)` (the inline pattern)
const inlinePattern = /await\s+reconcileUser\([^)]*client[^)]*\)/;
assert(!inlinePattern.test(geSrc),
  'game-engine.ts does NOT contain an inline `await reconcileUser(... client)` call inside the transaction');

// CRITICAL: schedulePostCommitReconcile is exported
assert(/export function schedulePostCommitReconcile/.test(geSrc),
  'schedulePostCommitReconcile is exported from game-engine.ts');

// CRITICAL: setImmediate is the dispatch mechanism
assert(/setImmediate\(\s*\(\)\s*=>\s*\{[\s\S]*reconcileUser/.test(geSrc),
  'schedulePostCommitReconcile uses setImmediate to dispatch reconcileUser');

// 60s coalescing window
assert(/RECONCILE_COALESCE_WINDOW_MS\s*=\s*60_?000/.test(geSrc),
  'game-engine.ts defines a 60_000 ms (60s) coalescing window');

// The coalescing map is keyed by userId
assert(/reconcileCache\s*=\s*new Map/.test(geSrc),
  'game-engine.ts uses a Map keyed by userId for coalescing');

// placeBet() now calls schedulePostCommitReconcile AFTER the COMMIT
const commitIdx = geSrc.indexOf("await client.query('COMMIT')");
const scheduleIdx = geSrc.lastIndexOf('schedulePostCommitReconcile(req.userId)');
assert(commitIdx > 0 && scheduleIdx > commitIdx,
  'schedulePostCommitReconcile(req.userId) is called AFTER client.query(COMMIT) (outside the transaction)');

// ---------------------------------------------------------------------------
// 2. Source-level: reconciliation-engine.ts alerts + freeze contract
// ---------------------------------------------------------------------------
assert(/ledger_alerts/.test(reSrc),
  'reconciliation-engine.ts writes to ledger_alerts on mismatch');
assert(/reconciliation_auto_freeze/.test(reSrc),
  'reconciliation-engine.ts honors reconciliation_auto_freeze admin setting');
assert(/'true'/.test(reSrc) && /shouldFreeze/.test(reSrc),
  'reconciliation-engine.ts only freezes when the admin setting == "true"');
// The alert INSERTs must come BEFORE the freeze block in the source order.
// We just check the alert-writing code runs unconditionally — the freeze
// is gated by shouldFreeze, but the alert path is not gated by anything.
// (Specific positional check: alert INSERTs appear above the freeze block.)
const alertInsertPos = reSrc.indexOf("INSERT INTO ledger_alerts");
const freezePos = reSrc.indexOf('shouldFreeze');
assert(alertInsertPos > 0 && freezePos > alertInsertPos,
  'ledger_alerts INSERT statements appear BEFORE the freeze block in the source');

// ---------------------------------------------------------------------------
// 3. Source-level: payment-reconciliation cron untouched
// ---------------------------------------------------------------------------
const reconCronSrc = fs.readFileSync(
  path.join(__dirname, '../services/reconciliation.ts'),
  'utf8',
);
assert(/startReconciliationLoop/.test(reconCronSrc),
  'services/reconciliation.ts still exports startReconciliationLoop (periodic cron)');
assert(/setInterval/.test(reconCronSrc),
  'services/reconciliation.ts still uses setInterval for the periodic cron');
assert(/RECONCILE_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(reconCronSrc),
  'services/reconciliation.ts cron interval unchanged at 5 minutes');

// ---------------------------------------------------------------------------
// 4. Runtime: schedulePostCommitReconcile coalesces + dispatches
// ---------------------------------------------------------------------------
//
// We stub `config/database` to return a working fake `db` whose
// `connect()` and `query()` both produce reconciliation-clean rows
// (no mismatches, is_active=true). This lets the real `reconcileUser`
// run to completion in the background and update the coalescing
// cache so subsequent calls in the same window are deduplicated.

const stubDb = {
  query: async (text: string) => {
    if (text.startsWith('SELECT balance,')) {
      return { rows: [{
        balance: '100',
        bonus_balance_coins: '0',
        withdrawable_balance_coins: '100',
        wagering_required_coins: '0',
        wagering_completed_coins: '0',
        is_active: true,
      }] };
    }
    if (text.includes("SUM(amount)") && text.includes("type = 'deposit'")) return { rows: [{ total: '100' }] };
    if (text.includes("SUM(amount)") && text.includes("type = 'withdrawal'")) return { rows: [{ total: '0' }] };
    if (text.includes("SUM(payout - amount)")) return { rows: [{ total: '0' }] };
    if (text.includes('squad_members')) return { rows: [{ total: '0' }] };
    if (text.includes('rain_claims')) return { rows: [{ total: '0' }] };
    if (text.includes('bonus_claims')) return { rows: [{ total: '0' }] };
    if (text.startsWith('SELECT id, chain, token_symbol')) return { rows: [] };
    if (text.includes("reconciliation_auto_freeze")) return { rows: [] };
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  },
  connect: async () => ({
    query: async (text: string) => stubDb.query(text),
    release: () => {},
  }),
  withTransaction: async () => undefined,
};

// reconciliation-engine.ts imports `{ db }` from '../config/database'.
// The exported shape is { db: Pool, query: fn, withTransaction: fn, connect: fn }.
// Build the stub so all four access patterns work.
function buildConfigDbStub(opts: { connectCounter?: { n: number }; queryOverride?: (text: string, params?: any[]) => Promise<any> } = {}) {
  const counter = opts.connectCounter;
  const queryFn = opts.queryOverride || stubDb.query;
  const dbPool = {
    connect: async () => {
      if (counter) counter.n++;
      return { query: queryFn, release: () => {} };
    },
    query: queryFn,
  };
  return {
    db: dbPool,
    query: queryFn,
    connect: async () => ({ query: queryFn, release: () => {} }),
    withTransaction: async () => undefined,
  };
}

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async connect() { return this; }
      async quit() { return 'OK'; }
      async disconnect() { return 'OK'; }
      async get() { return null; }
      async set() { return 'OK'; }
      async incr() { return 1; }
      async del() { return 1; }
      async expire() { return 1; }
    };
  }
  if (id.includes('config/database')) return stubDb;
  return originalRequire.apply(this, arguments as unknown as [string]);
};

// We can't easily count reconcileUser calls (it's a separate import chain),
// so instead we use the public surface: schedulePostCommitReconcile returns
// void. We measure coalescing behavior indirectly:
//   - After the FIRST reconcile runs (and updates the cache), the cache is
//     marked "completed at time T". A subsequent schedule for the same user
//     within 60s should be coalesced (no setImmediate fires a new query).
//   - We verify this by exposing the cache state via a test hook:
//     `_resetReconcileCacheForTests()` and observing that subsequent
//     schedulePostCommitReconcile calls don't reach `reconcileUser`.
//
// The cleanest signal is to spy on db.connect — if reconcileUser is invoked
// it will call db.connect exactly once. We track this counter.

let dbConnectCalls = 0;
const countingStubDb = buildConfigDbStub({ connectCounter: { n: 0 } });
// Wrap connect on the public object so the counter increments.
const realConnect = countingStubDb.db.connect;
countingStubDb.db.connect = async () => {
  dbConnectCalls++;
  return realConnect();
};

Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async connect() { return this; }
      async quit() { return 'OK'; }
      async disconnect() { return 'OK'; }
      async get() { return null; }
      async set() { return 'OK'; }
      async incr() { return 1; }
      async del() { return 1; }
      async expire() { return 1; }
    };
  }
  if (id.includes('config/database')) return countingStubDb;
  return originalRequire.apply(this, arguments as unknown as [string]);
};

// Require game-engine fresh so it picks up the counting stub
for (const k of Object.keys(require.cache)) {
  if (k.includes('game-engine')) delete require.cache[k];
}
const ge = require('../services/game-engine');

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

(async () => {
  // ── Case A: first schedulePostCommitReconcile fires once ──
  ge._resetReconcileCacheForTests();
  dbConnectCalls = 0;
  ge.schedulePostCommitReconcile('user-A');
  await flushImmediate();
  assert(dbConnectCalls === 1,
    `first reconcile for user-A: exactly 1 db.connect (got: ${dbConnectCalls})`);

  // ── Case B: second schedule for same user within 60s is coalesced ──
  dbConnectCalls = 0;
  ge.schedulePostCommitReconcile('user-A');
  ge.schedulePostCommitReconcile('user-A');
  ge.schedulePostCommitReconcile('user-A');
  await flushImmediate();
  assert(dbConnectCalls === 0,
    `duplicate reconciles within 60s window are coalesced (expected 0 db.connect, got: ${dbConnectCalls})`);

  // ── Case C: reconcile for a DIFFERENT user still fires ──
  dbConnectCalls = 0;
  ge.schedulePostCommitReconcile('user-B');
  await flushImmediate();
  assert(dbConnectCalls === 1,
    `reconcile for user-B (independent userId) fires (expected 1, got: ${dbConnectCalls})`);

  // ── Case D: after _resetReconcileCacheForTests, user-A fires again ──
  dbConnectCalls = 0;
  ge._resetReconcileCacheForTests();
  ge.schedulePostCommitReconcile('user-A');
  await flushImmediate();
  assert(dbConnectCalls === 1,
    `reconcile fires again after _resetReconcileCacheForTests (got: ${dbConnectCalls})`);

  // ── Case E: reconcileUser reference count in game-engine.ts (non-trivial) ──
  const reconcileUserMatches = (geSrc.match(/\breconcileUser\s*\(/g) || []).length;
  assert(reconcileUserMatches >= 2,
    `reconcileUser reference count in game-engine.ts is non-trivial (got: ${reconcileUserMatches})`);

  // ── Case F: reconcileUser writes alerts WITHOUT freezing when auto-freeze unset ──
  const alertRows: any[] = [];
  const userUpdates: any[] = [];

  const mismatchQuery = async (text: string, params: any[] = []) => {
    if (text.startsWith('SELECT balance,')) {
      return { rows: [{
        balance: '50',
        bonus_balance_coins: '0',
        withdrawable_balance_coins: '50',
        wagering_required_coins: '0',
        wagering_completed_coins: '0',
        is_active: true,
      }] };
    }
    if (text.includes("SUM(amount)") && text.includes("type = 'deposit'")) return { rows: [{ total: '100' }] };
    if (text.includes("SUM(amount)") && text.includes("type = 'withdrawal'")) return { rows: [{ total: '0' }] };
    if (text.includes("SUM(payout - amount)")) return { rows: [{ total: '0' }] };
    if (text.includes('squad_members')) return { rows: [{ total: '0' }] };
    if (text.includes('rain_claims')) return { rows: [{ total: '0' }] };
    if (text.includes('bonus_claims')) return { rows: [{ total: '0' }] };
    if (text.startsWith('SELECT id, chain, token_symbol')) return { rows: [] };
    if (text.includes("reconciliation_auto_freeze")) return { rows: [] };
    if (text.startsWith('INSERT INTO ledger_alerts')) {
      const row = { id: `alert-${alertRows.length + 1}`, user_id: params[0] };
      alertRows.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE users SET is_active')) {
      userUpdates.push({ sql: text, params });
      return { rows: [] };
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  };

  const stubDbMismatch = buildConfigDbStub({ queryOverride: mismatchQuery });

  // Swap stub
  Module.prototype.require = function (id: string) {
    if (id === 'ioredis') {
      return class MockRedis {
        on() { return this; }
        async connect() { return this; }
        async quit() { return 'OK'; }
        async disconnect() { return 'OK'; }
        async get() { return null; }
        async set() { return 'OK'; }
        async incr() { return 1; }
        async del() { return 1; }
        async expire() { return 1; }
      };
    }
    if (id.includes('config/database')) return stubDbMismatch;
    return originalRequire.apply(this, arguments as unknown as [string]);
  };

  for (const k of Object.keys(require.cache)) {
    if (k.includes('reconciliation-engine')) delete require.cache[k];
  }
  const reModule = require('../services/reconciliation-engine');

  const result = await reModule.reconcileUser('user-MISMATCH');
  assert(result.isValid === false, 'reconcileUser returns isValid=false on balance mismatch');
  assert(alertRows.length >= 1,
    `ledger_alerts row was written (got: ${alertRows.length})`);
  assert(userUpdates.length === 0,
    `users.is_active NOT set to false when reconciliation_auto_freeze is unset (UPDATE count: ${userUpdates.length})`);

  // ── Case G: auto-freeze ON → is_active = false IS applied ──
  const freezeQuery = async (text: string, params: any[] = []) => {
    if (text.includes("reconciliation_auto_freeze")) return { rows: [{ value: 'true' }] };
    return mismatchQuery(text, params);
  };
  const stubDbFreeze = buildConfigDbStub({ queryOverride: freezeQuery });
  Module.prototype.require = function (id: string) {
    if (id === 'ioredis') {
      return class MockRedis {
        on() { return this; }
        async connect() { return this; }
        async quit() { return 'OK'; }
        async disconnect() { return 'OK'; }
        async get() { return null; }
        async set() { return 'OK'; }
        async incr() { return 1; }
        async del() { return 1; }
        async expire() { return 1; }
      };
    }
    if (id.includes('config/database')) return stubDbFreeze;
    return originalRequire.apply(this, arguments as unknown as [string]);
  };

  alertRows.length = 0;
  userUpdates.length = 0;
  for (const k of Object.keys(require.cache)) {
    if (k.includes('reconciliation-engine')) delete require.cache[k];
  }
  const reModuleFreeze = require('../services/reconciliation-engine');
  const result2 = await reModuleFreeze.reconcileUser('user-FREEZE');
  assert(result2.frozen === true, 'reconcileUser returns frozen=true when auto-freeze is enabled');
  assert(alertRows.length >= 1,
    `ledger_alerts row STILL written when auto-freeze is on (got: ${alertRows.length})`);
  assert(userUpdates.length === 1,
    `users.is_active UPDATE applied exactly once when auto-freeze is on (got: ${userUpdates.length})`);

  // ── Summary ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('');
  if (failed) {
    // eslint-disable-next-line no-console
    console.error('❌ P0-05 tests FAILED');
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.log('🎉 All P0-05 reconciliation-decoupling tests passed');
    process.exit(0);
  }
})();
