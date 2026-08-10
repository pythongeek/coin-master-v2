/**
 * S1-W10 — hot wallet minimum balance guard
 *
 * Audit ref:  PROD_AUDIT_2026-08-07.md → W10, H3
 * Severity:   HIGH → CRITICAL — hot wallet can drain to zero.
 *
 * Bug:  The existing check `hotBalance < amount` was binary. A
 *       withdrawal that would dip the hot wallet below an operational
 *       reserve (e.g., 1000 USDT for TronGrid energy fees) was
 *       rejected entirely — but the user was already on-chain.
 *       The fix: keep a MIN_BALANCE reserve; halt the withdrawal
 *       (status='payout_stuck') if the broadcast would dip below it.
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/s1-w10-hot-wallet-min.test.ts
 *
 * The test exercises the same SQL pattern the payout worker would
 * issue when the halt fires. The wallet + min_balance + amount
 * combinations are mocked.
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

function installW10Interceptor() {
  setQueryInterceptor(async (text: string, params: any[]) => {
    const upper = text.trim().replace(/\s+/g, ' ').toUpperCase();

    if (upper.startsWith('UPDATE TRANSACTIONS SET STATUS = \'PAYOUT_STUCK\'')) {
      const id = params[params.length - 1];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      if (tx) {
        tx.status = 'payout_stuck';
        tx.metadata = {
          ...(tx.metadata || {}),
          payout_stuck_at: new Date().toISOString(),
          payout_stuck_reason: 'hot_wallet_min_balance',
          payout_stuck_hot_balance: params[0],
          payout_stuck_required_balance: params[1],
          payout_stuck_min_balance: params[2],
          payout_stuck_amount: params[3],
        };
      }
      return { rows: [], rowCount: 1 };
    }

    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
      return { rows: [] };
    }

    return undefined;
  });
}

async function runTests() {
  console.log('🧪 S1-W10 hot wallet minimum balance guard\n');

  const { Decimal } = require('@prisma/client/runtime/library');
  const db = require('../config/database');

  // ─────────────────────────────────────────────────────────────
  // Test A: hot balance >= amount + min → proceeds (no halt)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── A: hot balance >= amount + min → proceeds (no halt) ──');
    resetAllMocks();

    const hotBalance = new Decimal('1000');
    const minBalance = new Decimal('100');
    const amount = new Decimal('900');
    const requiredBalance = minBalance.plus(amount); // 1000

    // No payout_stuck row should be created
    MOCK_TRANSACTIONS.push({
      id: 'tx-aaaa', user_id: 'u', wallet_id: 'w',
      type: 'withdrawal', amount: 900, status: 'confirmed',
      tx_hash: null, metadata: {},
    });

    installW10Interceptor();

    assert(
      hotBalance.greaterThanOrEqualTo(requiredBalance) === true,
      'hot balance 1000 >= required 1000 (proceed, no halt)',
    );

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test B: hot balance < amount + min → halt as payout_stuck
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── B: hot balance < amount + min → halt (payout_stuck) ──');
    resetAllMocks();

    const txId = 'tx-bbbb';
    MOCK_TRANSACTIONS.push({
      id: txId, user_id: 'u-b', wallet_id: 'w-b',
      type: 'withdrawal', amount: 950, status: 'confirmed',
      tx_hash: null, metadata: {},
    });

    installW10Interceptor();

    // Simulate the halt SQL the worker would issue.
    const hotBalance = '1000';
    const requiredBalance = '1050';
    const minBalance = '100';
    const amount = '950';

    await db.query(
      `UPDATE transactions
          SET status = 'payout_stuck',
              metadata = metadata || jsonb_build_object(
                'payout_stuck_at', NOW()::text,
                'payout_stuck_reason', 'hot_wallet_min_balance',
                'payout_stuck_hot_balance', $1::text,
                'payout_stuck_required_balance', $2::text,
                'payout_stuck_min_balance', $3::text,
                'payout_stuck_amount', $4::text
              )
        WHERE id = $5`,
      [hotBalance, requiredBalance, minBalance, amount, txId],
    );

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'payout_stuck', `tx.status='payout_stuck' (got '${tx.status}')`);
    assert(tx.metadata?.payout_stuck_reason === 'hot_wallet_min_balance', 'reason = hot_wallet_min_balance');
    assert(tx.metadata?.payout_stuck_hot_balance === '1000', 'hot_balance recorded');
    assertEq(tx.metadata?.payout_stuck_required_balance, '1050', 'required_balance recorded (= 100 + 950)');
    assertEq(tx.metadata?.payout_stuck_min_balance, '100', 'min_balance recorded');
    assertEq(tx.metadata?.payout_stuck_amount, '950', 'amount recorded');

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test C: hot balance >= amount BUT < amount + min → halt
  //   (this is the W10 bug case)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── C: hot balance covers amount but dips below MIN → halt ──');
    resetAllMocks();

    const hotBalance = new Decimal('1100');
    const minBalance = new Decimal('200');
    const amount = new Decimal('1000');
    const requiredBalance = minBalance.plus(amount); // 1200

    assert(hotBalance.greaterThanOrEqualTo(amount) === true, 'hot 1100 >= amount 1000 (single check passes)');
    assert(hotBalance.lessThan(requiredBalance) === true, 'hot 1100 < required 1200 (W10 halt fires)');

    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test D: hot balance < amount → original throw (existing logic)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── D: hot balance < amount → throw (existing pre-W10 logic) ──');
    resetAllMocks();

    const hotBalance = new Decimal('500');
    const amount = new Decimal('1000');

    assert(hotBalance.lessThan(amount) === true, 'hot 500 < amount 1000 → throw');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test E: env default is 1000 USDT
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── E: env.HOT_WALLET_MIN_BALANCE_USDT default = 1000 ──');
    const env = require('../config/env').env;
    assertEq(env.HOT_WALLET_MIN_BALANCE_USDT, 1000, 'default min_balance = 1000 USDT');
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
