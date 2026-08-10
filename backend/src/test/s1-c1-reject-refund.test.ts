/**
 * S1-C1 — rejectWithdrawal refund bug regression tests
 *
 * Audit ref:  PROD_AUDIT_2026-08-07.md → S1-C1 + MONEY-1 + W1
 * Severity:   CRITICAL — admin rejection caused permanent user fund loss
 *
 * Bug:  rejectWithdrawal credited users.withdrawable_balance_coins instead
 *       of restoring wallets.balance + decrementing wallets.locked_balance.
 *       The withdrawal submit (withdrawal-queue.ts:203) debited the wallet;
 *       the reject refunded a different, unrelated column.
 *
 * Fix:  Transaction wraps SELECT … FOR UPDATE on the tx row, then
 *       UPDATE wallets SET balance = balance + $1, locked_balance = … - $1
 *       — restoring the wallet that was originally debited.
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/s1-c1-reject-refund.test.ts
 *
 * Asserts the closed invariant:
 *   submit:    wallets.balance -= amount, wallets.locked_balance += amount
 *   reject:    wallets.balance += amount, wallets.locked_balance -= amount
 *
 * Test isolation: installCommonMocks() (auto-installed via setup.ts) provides
 * the default mock layer. We use setQueryInterceptor to override the four
 * queries this fix introduces (the global mocks don't yet handle two-column
 * wallet UPDATE, tx-row FOR UPDATE select, tx status UPDATE, or the audit_log
 * column order). This avoids touching test-mocks.ts which 50+ other tests
 * depend on.
 */

import {
  resetAllMocks,
  MOCK_USERS,
  MOCK_WALLETS,
  MOCK_TRANSACTIONS,
  MOCK_AUDIT_LOGS,
  setQueryInterceptor,
} from './helpers/test-mocks';

// Loaded after setup hook so the mocked db module is in place.
const { rejectWithdrawal } = require('../services/bonus');

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

/**
 * Install query interceptors for the four queries this fix introduces.
 * Returns a teardown function that clears the interceptor.
 */
function installC1Interceptors() {
  setQueryInterceptor(async (text: string, params: any[]) => {
    const upper = text.trim().replace(/\s+/g, ' ').toUpperCase();

    // 1. SELECT … FROM transactions … FOR UPDATE (the new lock)
    if (
      upper.startsWith('SELECT USER_ID, WALLET_ID, AMOUNT, STATUS') &&
      upper.includes('FROM TRANSACTIONS') &&
      upper.includes('FOR UPDATE')
    ) {
      const id = params[0];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      return { rows: tx ? [tx] : [] };
    }

    // 2. UPDATE wallets SET balance = balance + $1, locked_balance = locked_balance - $1
    if (
      upper.startsWith('UPDATE WALLETS') &&
      upper.includes('BALANCE = BALANCE + $1') &&
      upper.includes('LOCKED_BALANCE = LOCKED_BALANCE - $1')
    ) {
      const amount = Number(params[0]);
      const walletId = params[1];
      const userId = params[2];
      const wallet = MOCK_WALLETS.find(
        (w) => w.id === walletId && w.user_id === userId,
      );
      if (!wallet) {
        // Match the production throw: returns rowCount=0 to trigger the
        // rejectWithdrawal guard.
        return { rows: [], rowCount: 0 };
      }
      wallet.balance = Number(wallet.balance) + amount;
      wallet.locked_balance = Number(wallet.locked_balance) - amount;
      return { rows: [], rowCount: 1 };
    }

    // 3. UPDATE transactions SET status = 'rejected', completed_at = NOW(), metadata = ...
    if (upper.startsWith('UPDATE TRANSACTIONS SET STATUS = \'REJECTED\'')) {
      const id = params[0];
      const rejectedBy = params[1];
      const reason = params[2];
      const tx = MOCK_TRANSACTIONS.find((t) => t.id === id);
      if (tx) {
        tx.status = 'rejected';
        tx.completed_at = new Date();
        tx.metadata = {
          ...(tx.metadata || {}),
          rejected_by: rejectedBy,
          rejection_reason: reason,
          rejected_at: new Date().toISOString(),
        };
      }
      return { rows: [], rowCount: 1 };
    }

    // 4. INSERT INTO audit_log (category, action, severity, user_id, details)
    //    The actual rejectWithdrawal INSERT uses LITERALS for the first
    //    three columns and $1, $2 for user_id and details:
    //      VALUES ('withdrawal', 'withdrawal.rejected', 'warn', $1, $2)
    //    So params[0] = user_id, params[1] = JSON details.
    if (
      upper.startsWith('INSERT INTO AUDIT_LOG') &&
      upper.includes('CATEGORY') &&
      upper.includes('ACTION') &&
      upper.includes('SEVERITY')
    ) {
      MOCK_AUDIT_LOGS.push({
        user_id: params[0],
        category: 'withdrawal',
        action: 'withdrawal.rejected',
        severity: 'warn',
        details: params[1] || {},
        created_at: new Date(),
      });
      return { rows: [] };
    }

    // Fall through to default handler.
    return undefined;
  });
}

function clearInterceptors() {
  setQueryInterceptor(null);
}

async function runTests() {
  console.log('🧪 S1-C1 rejectWithdrawal refund correctness tests\n');

  // ─────────────────────────────────────────────────────────────
  // Test A: Happy path — reject a pending withdrawal restores the wallet
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test A: pending → rejected → wallet restored ──');
    resetAllMocks();
    installC1Interceptors();

    const userId = '11111111-1111-1111-1111-111111111111';
    const walletId = '22222222-2222-2222-2222-222222222222';
    const txId = '33333333-3333-3333-3333-333333333333';

    MOCK_USERS.push({ id: userId, balance: 0, is_active: true });

    // Wallet in the post-submission state: balance=50, locked_balance=50
    MOCK_WALLETS.push({
      id: walletId,
      user_id: userId,
      chain: 'tron',
      token_symbol: 'USDT',
      balance: 50,
      locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId,
      user_id: userId,
      wallet_id: walletId,
      type: 'withdrawal',
      amount: 50,
      status: 'pending',
      metadata: {},
    });

    const result = await rejectWithdrawal(txId, 'admin-uuid', 'KYC failed manual review');

    assert(result.ok === true, 'rejectWithdrawal returns ok=true');
    assertEq(result.refundedCoins, 50, 'refundedCoins equals amount');

    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 100, 'wallets.balance restored from 50 to 100');
    assertEq(wallet.locked_balance, 0, 'wallets.locked_balance decremented from 50 to 0');

    const tx = MOCK_TRANSACTIONS.find((t) => t.id === txId)!;
    assert(tx.status === 'rejected', `tx.status='rejected' (got '${tx.status}')`);
    assert(
      tx.status !== 'failed',
      'tx.status is NOT \'failed\' (rejected is distinct from failed)',
    );
    assert(tx.metadata?.rejected_by === 'admin-uuid', 'metadata.rejected_by set');
    assert(
      tx.metadata?.rejection_reason === 'KYC failed manual review',
      'metadata.rejection_reason set',
    );
    assert(tx.completed_at !== undefined, 'completed_at set on rejection');

    const audit = MOCK_AUDIT_LOGS.find(
      (a) => a.user_id === userId && a.action === 'withdrawal.rejected',
    );
    assert(audit !== undefined, 'audit_log entry written');
    assert(audit?.category === 'withdrawal', 'audit category=withdrawal');
    assert(audit?.severity === 'warn', 'audit severity=warn');

    // Critically: the user's actual wallet balance was NOT touched where
    // it wasn't supposed to be (the original bug).
    const user = MOCK_USERS.find((u) => u.id === userId)!;
    assert(
      user.withdrawable_balance_coins === undefined ||
        user.withdrawable_balance_coins === 0,
      'users.withdrawable_balance_coins was NOT credited (the original bug)',
    );

    clearInterceptors();
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test B: Reject an already-rejected withdrawal — no double-refund
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test B: already-rejected → no double-refund ──');
    resetAllMocks();
    installC1Interceptors();

    const userId = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const walletId = 'bbbbbbb1-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const txId = 'ccccccc1-cccc-cccc-cccc-cccccccccccc';

    MOCK_WALLETS.push({
      id: walletId,
      user_id: userId,
      chain: 'tron',
      balance: 50,
      locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId,
      user_id: userId,
      wallet_id: walletId,
      type: 'withdrawal',
      amount: 50,
      status: 'rejected', // <-- already rejected
      metadata: { rejected_by: 'previous-admin' },
    });

    const result = await rejectWithdrawal(txId, 'admin-uuid', 'redundant rejection');

    assert(result.ok === false, 'rejectWithdrawal returns ok=false on already-rejected');
    assertEq(result.refundedCoins, 0, 'refundedCoins=0 on already-rejected');

    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 50, 'wallet.balance unchanged after no-op reject');
    assertEq(wallet.locked_balance, 50, 'wallet.locked_balance unchanged after no-op reject');

    clearInterceptors();
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test C: Sequential second reject — only one succeeds
  // (The FOR UPDATE lock serializes concurrent reject calls; the
  //  second call sees status='rejected' and returns ok=false.)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test C: second reject call after first succeeds ──');
    resetAllMocks();
    installC1Interceptors();

    const userId = '11111111-2222-3333-4444-555555555555';
    const walletId = '22222222-3333-4444-5555-666666666666';
    const txId = '33333333-4444-5555-6666-777777777777';

    MOCK_WALLETS.push({
      id: walletId,
      user_id: userId,
      chain: 'tron',
      balance: 50,
      locked_balance: 50,
    });

    MOCK_TRANSACTIONS.push({
      id: txId,
      user_id: userId,
      wallet_id: walletId,
      type: 'withdrawal',
      amount: 50,
      status: 'pending',
      metadata: {},
    });

    const first = await rejectWithdrawal(txId, 'admin-A', 'first');
    const second = await rejectWithdrawal(txId, 'admin-B', 'second');

    assert(first.ok === true, 'first reject succeeds');
    assert(second.ok === false, 'second reject returns ok=false (already processed)');
    assertEq(second.refundedCoins, 0, 'second refund is 0');

    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 100, 'wallet.balance restored exactly once (not 150)');
    assertEq(wallet.locked_balance, 0, 'wallet.locked_balance decremented exactly once');

    clearInterceptors();
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test D: Reject after confirmed — no refund (money already sent)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test D: confirmed status → no refund ──');
    resetAllMocks();
    installC1Interceptors();

    const userId = 'dddddddd-eeee-eeee-eeee-ffffffffffff';
    const walletId = 'eeeeeeee-ffff-ffff-ffff-000000000000';
    const txId = 'aaaaaaaa-bbbb-bbbb-bbbb-cccccccccccc';

    // After confirmed, locked_balance should be 0 (payout drained it).
    MOCK_WALLETS.push({
      id: walletId,
      user_id: userId,
      chain: 'tron',
      balance: 0,
      locked_balance: 0,
    });

    MOCK_TRANSACTIONS.push({
      id: txId,
      user_id: userId,
      wallet_id: walletId,
      type: 'withdrawal',
      amount: 50,
      status: 'confirmed', // <-- already paid out
      tx_hash: 'tron-tx-hash-on-chain',
      metadata: {},
    });

    const result = await rejectWithdrawal(txId, 'admin-uuid', 'post-confirm reject');

    assert(result.ok === false, 'rejectWithdrawal returns ok=false on confirmed');
    assertEq(result.refundedCoins, 0, 'refundedCoins=0 on confirmed');

    const wallet = MOCK_WALLETS.find((w) => w.id === walletId)!;
    assertEq(wallet.balance, 0, 'wallet.balance unchanged after confirmed-reject');
    assertEq(wallet.locked_balance, 0, 'wallet.locked_balance unchanged after confirmed-reject');

    clearInterceptors();
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test E: Non-existent tx
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test E: non-existent tx → ok=false ──');
    resetAllMocks();
    installC1Interceptors();

    const result = await rejectWithdrawal(
      '00000000-0000-0000-0000-000000000000',
      'admin-uuid',
      'no such tx',
    );
    assert(result.ok === false, 'rejectWithdrawal returns ok=false on missing tx');
    assertEq(result.refundedCoins, 0, 'refundedCoins=0 on missing tx');

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
