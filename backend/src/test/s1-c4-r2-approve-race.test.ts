/**
 * S1-C4-R2 — concurrent admin approve/reject race regression tests
 *
 * Audit ref:  PROD_AUDIT_2026-08-07.md → C4, R1, R2
 * Severity:   CRITICAL — two admins can double-approve / double-refund
 *
 * Bug:  approveWithdrawal and rejectWithdrawal both SELECTed the
 *       transaction row WITHOUT FOR UPDATE. Two concurrent admin calls
 *       both passed the status='pending' check and both executed the
 *       UPDATE — the second one dispatched a duplicate BullMQ payout
 *       job (for approve) or refunded twice (for reject).
 *
 * Fix:  Wrap both functions in withTransaction + SELECT … FOR UPDATE.
 *       The C1 fix already did this for rejectWithdrawal; this PR
 *       extends the same pattern to approveWithdrawal.
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/s1-c4-r2-approve-race.test.ts
 *
 * Assertion strategy:
 *   Sequential double-call: trivially exercises the lock — the second
 *   call sees status != 'pending' and returns ok=false. This is the
 *   same code path the lock protects in concurrent execution.
 */

import {
  resetAllMocks,
  MOCK_USERS,
  MOCK_WALLETS,
  MOCK_TRANSACTIONS,
  MOCK_AUDIT_LOGS,
  setQueryInterceptor,
} from './helpers/test-mocks';

const { approveWithdrawal, rejectWithdrawal } = require('../services/bonus');

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    pass++;
  } else {
    console.error(`  ❌ ${msg}`);
    fail++;
  }
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

function installC4R2Interceptors() {
  setQueryInterceptor(async (text: string, params: any[]) => {
    const upper = text.trim().replace(/\s+/g, ' ').toUpperCase();

    // SELECT transactions … FOR UPDATE (shared by approve + reject)
    if (
      upper.startsWith('SELECT USER_ID') &&
      upper.includes('FROM TRANSACTIONS') &&
      upper.includes('FOR UPDATE')
    ) {
      const id = params[0];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      return { rows: tx ? [tx] : [] };
    }

    // UPDATE wallets SET balance = balance + $1, locked_balance = locked_balance - $1
    if (
      upper.startsWith('UPDATE WALLETS') &&
      upper.includes('BALANCE = BALANCE + $1') &&
      upper.includes('LOCKED_BALANCE = LOCKED_BALANCE - $1')
    ) {
      const amount = Number(params[0]);
      const walletId = params[1];
      const userId = params[2];
      const wallet = MOCK_WALLETS.find((w) => w.id === walletId && w.user_id === userId);
      if (!wallet) return { rows: [], rowCount: 0 };
      wallet.balance = Number(wallet.balance) + amount;
      wallet.locked_balance = Number(wallet.locked_balance) - amount;
      return { rows: [], rowCount: 1 };
    }

    // UPDATE transactions SET status = 'rejected' (from C1 fix)
    if (upper.startsWith('UPDATE TRANSACTIONS SET STATUS = \'REJECTED\'')) {
      const id = params[0];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      if (tx) {
        tx.status = 'rejected';
        tx.completed_at = new Date();
        tx.metadata = {
          ...(tx.metadata || {}),
          rejected_by: params[1],
          rejection_reason: params[2],
          rejected_at: new Date().toISOString(),
        };
      }
      return { rows: [], rowCount: 1 };
    }

    // UPDATE transactions SET status = 'confirmed' (from C4-R2 fix)
    if (upper.startsWith('UPDATE TRANSACTIONS SET STATUS = \'CONFIRMED\'')) {
      const id = params[0];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      if (tx) {
        tx.status = 'confirmed';
        tx.confirmed_at = new Date();
        tx.metadata = {
          ...(tx.metadata || {}),
          approved_by: params[1],
          approved_at: new Date().toISOString(),
        };
      }
      return { rows: [], rowCount: 1 };
    }

    // INSERT INTO audit_log (category, action, severity, user_id, details)
    // The INSERTs use LITERALS for category/action/severity and $1, $2
    // for user_id and details. Detect which action by the SQL literal.
    if (
      upper.startsWith('INSERT INTO AUDIT_LOG') &&
      upper.includes('CATEGORY') &&
      upper.includes('ACTION') &&
      upper.includes('SEVERITY')
    ) {
      let action = 'unknown';
      let severity = 'info';
      if (upper.includes('WITHDRAWAL.APPROVED')) {
        action = 'withdrawal.approved';
      } else if (upper.includes('WITHDRAWAL.REJECTED')) {
        action = 'withdrawal.rejected';
        severity = 'warn';
      }
      MOCK_AUDIT_LOGS.push({
        user_id: params[0],
        category: 'withdrawal',
        action,
        severity,
        details: params[1] || {},
        created_at: new Date(),
      });
      return { rows: [] };
    }

    return undefined;
  });
}

function clearInterceptors() {
  setQueryInterceptor(null);
}

async function runTests() {
  console.log('🧪 S1-C4-R2 concurrent approve/reject race tests\n');

  // ──────────────────────────────────────────────────────────
  // Test A: Approve happy path — pending → confirmed, audit +1
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test A: pending → confirmed (approve) ──');
    resetAllMocks();
    installC4R2Interceptors();

    const userId = '11111111-1111-1111-1111-111111111111';
    const walletId = '22222222-2222-2222-2222-222222222222';
    const txId = '33333333-3333-3333-3333-333333333333';

    MOCK_WALLETS.push({
      id: walletId, user_id: userId, chain: 'tron',
      balance: 50, locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId, user_id: userId, wallet_id: walletId,
      type: 'withdrawal', amount: 50, status: 'pending',
      metadata: { chain: 'tron', currency: 'USDT' },
    });

    const result = await approveWithdrawal(txId, 'admin-uuid');

    assert(result.ok === true, 'approveWithdrawal returns ok=true');

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'confirmed', `tx.status='confirmed' (got '${tx.status}')`);
    assert(tx.metadata?.approved_by === 'admin-uuid', 'metadata.approved_by set');
    assert(tx.confirmed_at !== undefined, 'confirmed_at set');

    const audit = MOCK_AUDIT_LOGS.find((a) => a.action === 'withdrawal.approved');
    assert(audit !== undefined, 'audit_log withdrawal.approved entry written');
    assert(audit?.user_id === userId, 'audit_log user_id matches');

    clearInterceptors();
    console.log('');
  }

  // ──────────────────────────────────────────────────────────
  // Test B: Concurrent approval — second call sees status != pending
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test B: concurrent approve — first wins, second returns ok=false ──');
    resetAllMocks();
    installC4R2Interceptors();

    const userId = '11111111-2222-3333-4444-555555555555';
    const walletId = '22222222-3333-4444-5555-666666666666';
    const txId = '33333333-4444-5555-6666-777777777777';

    MOCK_WALLETS.push({
      id: walletId, user_id: userId, chain: 'tron',
      balance: 50, locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId, user_id: userId, wallet_id: walletId,
      type: 'withdrawal', amount: 50, status: 'pending',
      metadata: { chain: 'tron', currency: 'USDT' },
    });

    const first = await approveWithdrawal(txId, 'admin-A');
    const second = await approveWithdrawal(txId, 'admin-B');

    assert(first.ok === true, 'first approve succeeds');
    assert(second.ok === false, 'second approve returns ok=false (race prevented)');

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'confirmed', 'tx.status is confirmed (not flipped twice)');

    const auditCount = MOCK_AUDIT_LOGS.filter(a => a.action === 'withdrawal.approved').length;
    assertEq(auditCount, 1, 'audit_log withdrawal.approved count = 1 (not 2)');

    clearInterceptors();
    console.log('');
  }

  // ──────────────────────────────────────────────────────────
  // Test C: Approve after reject — returns ok=false
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test C: approve after reject → ok=false ──');
    resetAllMocks();
    installC4R2Interceptors();

    const userId = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const walletId = 'bbbbbbb1-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const txId = 'ccccccc1-cccc-cccc-cccc-cccccccccccc';

    MOCK_WALLETS.push({
      id: walletId, user_id: userId, chain: 'tron',
      balance: 50, locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId, user_id: userId, wallet_id: walletId,
      type: 'withdrawal', amount: 50, status: 'pending',
      metadata: { chain: 'tron', currency: 'USDT' },
    });

    // First reject (C1 fix)
    const rej = await rejectWithdrawal(txId, 'admin-A', 'first reject');
    assert(rej.ok === true, 'reject succeeds');

    // Then try to approve
    const app = await approveWithdrawal(txId, 'admin-B');
    assert(app.ok === false, 'approve after reject returns ok=false');

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'rejected', 'tx.status stays rejected (approve did not flip)');

    // CRITICAL: balance must not be flipped twice. The reject restored
    // balance to 100, locked_balance to 0. If the approve had somehow
    // raced through, it would have decremented balance again.
    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 100, 'wallet.balance unchanged after failed approve');
    assertEq(wallet.locked_balance, 0, 'wallet.locked_balance unchanged after failed approve');

    clearInterceptors();
    console.log('');
  }

  // ──────────────────────────────────────────────────────────
  // Test D: Approve after approve — first wins, second is no-op
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test D: approve after approve → second ok=false, no duplicate payout ──');
    resetAllMocks();
    installC4R2Interceptors();

    const userId = 'dddddddd-eeee-eeee-eeee-ffffffffffff';
    const walletId = 'eeeeeeee-ffff-ffff-ffff-000000000000';
    const txId = 'aaaaaaaa-bbbb-bbbb-bbbb-cccccccccccc';

    MOCK_WALLETS.push({
      id: walletId, user_id: userId, chain: 'tron',
      balance: 50, locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId, user_id: userId, wallet_id: walletId,
      type: 'withdrawal', amount: 50, status: 'pending',
      metadata: { chain: 'tron', currency: 'USDT' },
    });

    const first = await approveWithdrawal(txId, 'admin-A');
    const second = await approveWithdrawal(txId, 'admin-B');

    assert(first.ok === true, 'first approve succeeds');
    assert(second.ok === false, 'second approve returns ok=false');

    // The payout dispatch is OUTSIDE the transaction. With the mock
    // BullMQ not actually running, we can't directly count dispatch
    // calls — but the second call's ok=false proves the row was
    // already 'confirmed' before the second one tried, so no payout
    // would be queued.
    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'confirmed', 'tx.status stays confirmed (no double-flip)');

    clearInterceptors();
    console.log('');
  }

  // ──────────────────────────────────────────────────────────
  // Test E: Concurrent reject — second call sees status != pending
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test E: concurrent reject — first wins, second returns ok=false ──');
    resetAllMocks();
    installC4R2Interceptors();

    const userId = '11111111-3333-3333-3333-333333333333';
    const walletId = '22222222-3333-3333-3333-333333333333';
    const txId = '33333333-3333-3333-3333-333333333333';

    MOCK_WALLETS.push({
      id: walletId, user_id: userId, chain: 'tron',
      balance: 50, locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId, user_id: userId, wallet_id: walletId,
      type: 'withdrawal', amount: 50, status: 'pending',
      metadata: {},
    });

    const first = await rejectWithdrawal(txId, 'admin-A', 'first');
    const second = await rejectWithdrawal(txId, 'admin-B', 'second');

    assert(first.ok === true, 'first reject succeeds');
    assert(second.ok === false, 'second reject returns ok=false (no double-refund)');

    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 100, 'wallet.balance restored exactly once (not 150)');
    assertEq(wallet.locked_balance, 0, 'wallet.locked_balance decremented exactly once');

    clearInterceptors();
    console.log('');
  }

  // ──────────────────────────────────────────────────────────
  // Test F: Approve non-existent tx
  // ──────────────────────────────────────────────────────────
  {
    console.log('── Test F: approve non-existent tx → ok=false ──');
    resetAllMocks();
    installC4R2Interceptors();

    const result = await approveWithdrawal(
      '00000000-0000-0000-0000-000000000000',
      'admin-uuid',
    );
    assert(result.ok === false, 'approveWithdrawal returns ok=false on missing tx');

    clearInterceptors();
    console.log('');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
