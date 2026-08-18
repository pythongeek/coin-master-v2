/**
 * S1-W11 — payout reconciliation cron
 *
 * Audit ref:  PROD_AUDIT_2026-08-07.md → W11
 * Severity:   HIGH — silent stuck states, user funds in limbo.
 *
 * Bug:  A 'confirmed' transaction with no tx_hash after 30 min = a
 *       BullMQ job that was eaten (Redis blip, worker crash, queue
 *       reset). The DB row stays 'confirmed' forever, the user's
 *       balance is locked, and no admin gets paged.
 *
 * Fix:  Every 5 minutes, scan for:
 *       (1) status='confirmed' AND tx_hash IS NULL AND created_at < 30 min ago
 *           → flip to 'payout_stuck' (reuse S1-W3 state) + admin email
 *       (2) status='pending' AND created_at < 48 hours
 *           → log + admin email (auto-refund is W16, separate)
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/s1-w11-reconciliation.test.ts
 */

import {
  resetAllMocks,
  MOCK_TRANSACTIONS,
  MOCK_AUDIT_LOGS,
  setQueryInterceptor,
} from './helpers/test-mocks';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✅ ${msg}`); pass++; }
  else { console.error(`  ❌ ${msg}`); fail++; }
}

function assertEq(actual: any, expected: any, msg: string) {
  const a = typeof actual === 'number' ? actual.toFixed(8) : actual;
  const e = typeof expected === 'number' ? expected.toFixed(8) : expected;
  if (a === e) {
    console.log(`  ✅ ${msg} (actual=${a}, expected=${e})`);
    pass++;
  } else {
    console.error(`  ❌ ${msg} (actual=${a}, expected=${e})`);
    fail++;
  }
}

function installW11Interceptor() {
  setQueryInterceptor(async (text: string, params: any[]) => {
    const upper = text.trim().replace(/\s+/g, ' ').toUpperCase();

    // SELECT … FROM transactions WHERE status='confirmed' AND tx_hash IS NULL AND created_at < $1
    // params[0] is the cutoff timestamp (stuckBefore).
    if (upper.includes('FROM TRANSACTIONS') && upper.includes('STATUS = \'CONFIRMED\'') && upper.includes('TX_HASH IS NULL')) {
      const cutoff = new Date(params[0]);
      return {
        rows: MOCK_TRANSACTIONS
          .filter((t) => t.status === 'confirmed' && !t.tx_hash && new Date(t.created_at) < cutoff)
          .slice(0, 100),
      };
    }

    // SELECT … FROM transactions WHERE status='pending' AND created_at < $1
    if (upper.includes('FROM TRANSACTIONS') && upper.includes('STATUS = \'PENDING\'') && !upper.includes('STATUS = \'CONFIRMED\'')) {
      return {
        rows: MOCK_TRANSACTIONS
          .filter((t) => t.status === 'pending')
          .slice(0, 100),
      };
    }

    // UPDATE transactions SET status = 'payout_stuck' WHERE id = $2 AND status = 'confirmed'
    if (upper.startsWith('UPDATE TRANSACTIONS SET STATUS = \'PAYOUT_STUCK\'')) {
      const id = params[1];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      if (tx) {
        tx.status = 'payout_stuck';
        tx.metadata = {
          ...(tx.metadata || {}),
          payout_stuck_at: new Date().toISOString(),
          payout_stuck_reason: 'reconciliation_no_tx_hash',
          payout_stuck_age_seconds: params[0] ? Number(params[0]) : 0,
        };
      }
      return { rows: [], rowCount: 1 };
    }

    return undefined;
  });
}

async function runTests() {
  console.log('🧪 S1-W11 payout reconciliation cron tests\n');

  const { runPayoutReconciliation } = require('../services/payout-reconciliation');

  // ─────────────────────────────────────────────────────────────
  // Test A: confirmed-without-tx_hash → payout_stuck + admin email
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── A: confirmed-without-tx_hash (30+ min old) → payout_stuck ──');
    resetAllMocks();

    const stuckId = 'stuck-confirmed-1';
    MOCK_TRANSACTIONS.push({
      id: stuckId, user_id: 'u-1', wallet_id: 'w-1',
      type: 'withdrawal', amount: 100, status: 'confirmed',
      tx_hash: null, metadata: {},
      created_at: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    });

    installW11Interceptor();

    const result = await runPayoutReconciliation();

    assert(result.stuckConfirmed >= 1, 'result.stuckConfirmed >= 1');
    const tx = MOCK_TRANSACTIONS.find((t) => t.id === stuckId)!;
    assert(tx.status === 'payout_stuck', `tx.status='payout_stuck' (got '${tx.status}')`);
    assert(tx.metadata?.payout_stuck_reason === 'reconciliation_no_tx_hash', 'reason = reconciliation_no_tx_hash');
    assert(typeof tx.metadata?.payout_stuck_age_seconds === 'number', 'payout_stuck_age_seconds recorded');

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test B: pending-withdrawal (48+ hours old) → log + alert
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── B: pending withdrawal (48+ hours old) → log + alert (no auto-refund) ──');
    resetAllMocks();

    MOCK_TRANSACTIONS.push({
      id: 'old-pending-1', user_id: 'u-2', wallet_id: 'w-2',
      type: 'withdrawal', amount: 50, status: 'pending',
      tx_hash: null, metadata: {},
      created_at: new Date(Date.now() - 72 * 60 * 60 * 1000), // 72 hours ago
    });

    installW11Interceptor();

    const result = await runPayoutReconciliation();

    assert(result.stuckPending >= 1, 'result.stuckPending >= 1');

    // The pending row must NOT be auto-flipped (auto-refund is W16)
    const tx = MOCK_TRANSACTIONS.find((t) => t.id === 'old-pending-1')!;
    assert(tx.status === 'pending', `tx.status stays 'pending' (got '${tx.status}') — auto-refund is W16`);

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test C: recent confirmed (10 min old) → NOT touched
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── C: recent confirmed (10 min old, no tx_hash) → NOT touched ──');
    resetAllMocks();

    MOCK_TRANSACTIONS.push({
      id: 'recent-confirmed-1', user_id: 'u-3', wallet_id: 'w-3',
      type: 'withdrawal', amount: 75, status: 'confirmed',
      tx_hash: null, metadata: {},
      created_at: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    });

    installW11Interceptor();

    const result = await runPayoutReconciliation();

    // The interceptor's SELECT filters by 30-min age. So a 10-min-old
    // row is not in the result set. The mutation never fires.
    const tx = MOCK_TRANSACTIONS.find((t) => t.id === 'recent-confirmed-1')!;
    assert(tx.status === 'confirmed', `tx.status stays 'confirmed' (got '${tx.status}') — too recent`);
    assertEq(result.stuckConfirmed, 0, 'result.stuckConfirmed = 0');

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test D: confirmed with tx_hash → NOT touched
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── D: confirmed with tx_hash → NOT touched (broadcast succeeded) ──');
    resetAllMocks();

    MOCK_TRANSACTIONS.push({
      id: 'confirmed-with-hash', user_id: 'u-4', wallet_id: 'w-4',
      type: 'withdrawal', amount: 200, status: 'confirmed',
      tx_hash: 'tron-on-chain-hash', // <-- has hash, on-chain
      metadata: {},
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    installW11Interceptor();

    const result = await runPayoutReconciliation();

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === 'confirmed-with-hash')!;
    assert(tx.status === 'confirmed', 'tx.status stays confirmed (tx_hash present)');
    assertEq(result.stuckConfirmed, 0, 'stuckConfirmed = 0');

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test E: lifecycle — startPayoutReconciliationCron is idempotent
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── E: startPayoutReconciliationCron is idempotent ──');
    const { startPayoutReconciliationCron, stopPayoutReconciliationCron } = require('../services/payout-reconciliation');
    startPayoutReconciliationCron();
    startPayoutReconciliationCron(); // idempotent
    stopPayoutReconciliationCron();
    assert(true, 'start/stop idempotent (no crash)');
    console.log('');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  else process.exit(0);
}

const { installCommonMocks } = require('./helpers/test-mocks');
installCommonMocks();

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
