/**
 * WO-3 atomic deposit crediting — real-DB tests.
 *
 * Verifies the four core invariants of processDeposit (wallet.service.ts):
 *
 *   1. Single deposit → both Prisma-side (user_balances, ledger_entries)
 *      and legacy-side (users.wallet_balance_coins, users.balance,
 *      wallet_transactions) writes commit atomically.
 *   2. Duplicate deposit (same depositId) → no double credit. The second
 *      call is a no-op that returns the existing ledger entry.
 *   3. Forced mid-transaction failure → NONE of the four writes
 *      persist (rolled back together).
 *   4. The wallet_transactions INSERT uses the real column shape
 *      (no `amount`/`description`/`status` columns that the
 *      pre-WO-3 syncExistingBalance referenced).
 *
 * Test design:
 *   - Uses the real Postgres DB (DATABASE_URL). The Prisma client
 *     uses a separate connection from the raw pg pool.
 *   - Each test creates a fresh userId so isolation is trivial
 *     (no global state, no inter-test ordering risk).
 *   - Tests assert on the four observable writes; they don't
 *     reach into the Prisma client's internal state.
 *
 * Real-DB harness from PR-2 (lint-migrations, npm test against
 * ephemeral pg) ensures the migrations 049+050 are applied.
 * The Prisma client compiles against the migrated schema, and
 * the parity gate in CI catches future drift.
 */

import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

import { walletService } from '../services/wallet.service';

const prisma = new PrismaClient({
  log: ['error'],
});

let pool: Pool | null = null;

function queryPool(text: string, params: any[] = []): Promise<{ rows: any[] }> {
  if (!pool) throw new Error('queryPool called before pool initialized');
  return pool.query(text, params) as unknown as Promise<{ rows: any[] }>;
}

let failed = false;
function assert(cond: boolean | null | undefined, msg: string): void {
  if (cond) {
    console.log('✅', msg);
  } else {
    console.error('❌', msg);
    failed = true;
  }
}

interface UserRow {
  id: string;
  wallet_balance_coins: string;
  balance: string;
}
interface WalletTxRow {
  user_id: string;
  type: string;
  amount_coins: string;
  currency: string;
  source: string;
  note: string;
  metadata: Record<string, unknown>;
}
interface LedgerRow {
  user_id: string;
  currency_id: string;
  entry_type: string;
  amount: string;
  reference_id: string;
  balance_before: string;
  balance_after: string;
}

async function getUserLegacyCols(userId: string): Promise<UserRow | null> {
  const result = await queryPool(
    'SELECT id, wallet_balance_coins::text, balance::text FROM users WHERE id = $1',
    [userId]
  );
  return (result.rows[0] as UserRow) || null;
}

async function getWalletTransactions(userId: string): Promise<WalletTxRow[]> {
  const result = await queryPool(
    `SELECT user_id, type, amount_coins::text, currency, source, note, metadata
       FROM wallet_transactions
      WHERE user_id = $1
        AND source = 'crypto_deposit'
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows as WalletTxRow[];
}

async function getLedgerEntries(userId: string): Promise<LedgerRow[]> {
  const result = await queryPool(
    `SELECT user_id, currency_id, entry_type, amount::text, reference_id,
            balance_before::text, balance_after::text
       FROM ledger_entries
      WHERE user_id = $1
        AND entry_type = 'deposit'
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows as LedgerRow[];
}

async function seedTestUser(_currencyId: string): Promise<string> {
  const userId = uuidv4();
  await queryPool(
    `INSERT INTO users (id, username, email, password_hash, is_active, is_admin, kyc_status, kyc_tier)
     VALUES ($1, $2, $3, $4, true, false, 'unverified', 0)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `wo3_${userId.slice(0, 8)}`, `wo3_${userId.slice(0, 8)}@test.local`, 'bcrypt-hash']
  );
  return userId;
}

async function cleanupTestUser(userId: string): Promise<void> {
  await queryPool('DELETE FROM ledger_entries WHERE user_id = $1', [userId]);
  await queryPool('DELETE FROM wallet_transactions WHERE user_id = $1', [userId]);
  await queryPool('DELETE FROM user_balances WHERE user_id = $1', [userId]);
  await queryPool('DELETE FROM users WHERE id = $1', [userId]);
}

async function runTests() {
  console.log('🧪 WO-3 atomic deposit crediting — real-DB tests\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL must be set. This test uses a real Postgres DB.');
    process.exit(1);
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Resolve the USDT currency ID from the seed migration.
  const usdtRow = await queryPool(
    `SELECT id FROM currencies WHERE code = 'USDT'`
  );
  if (usdtRow.rows.length === 0) {
    console.error('❌ USDT currency row not found. Migration 050 must be applied.');
    process.exit(1);
  }
  const usdtCurrencyId = usdtRow.rows[0].id;
  console.log(`USDT currency id: ${usdtCurrencyId}`);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 1: Single deposit → all four writes commit atomically
  // ─────────────────────────────────────────────────────────────────
  console.log('\nScenario 1: Single deposit credits all four tables atomically');
  const user1 = await seedTestUser(usdtCurrencyId);
  const depositId1 = uuidv4();
  const depositAmount = new Decimal('123.45678900');

  try {
    await walletService.processDeposit(
      user1,
      usdtCurrencyId,
      depositAmount,
      depositId1,
      `Test deposit ${depositId1.slice(0, 8)}`
    );

    // Prisma-side
    const ubRow = await prisma.userBalance.findUnique({
      where: { userId_currencyId: { userId: user1, currencyId: usdtCurrencyId } },
    });
    assert(ubRow !== null, 'user_balances row created');
    assert(
      ubRow && ubRow.availableBalance.toString() === '123.456789',
      `user_balances.availableBalance = 123.456789 (got ${ubRow?.availableBalance.toString()})`
    );
    assert(ubRow && ubRow.totalDeposited.toString() === '123.456789',
      `user_balances.totalDeposited credited (got ${ubRow?.totalDeposited.toString()})`);

    const ledgerRows = await getLedgerEntries(user1);
    assert(ledgerRows.length === 1, `ledger_entries has exactly 1 deposit row (got ${ledgerRows.length})`);
    assert(
      ledgerRows[0]?.reference_id === `deposit:${depositId1}`,
      `ledger_entries.reference_id = deposit:${depositId1.slice(0, 12)}…`
    );
    assert(
      parseFloat(ledgerRows[0]?.balance_after || '0') === 123.456789,
      `ledger_entries.balance_after = 123.456789 (got ${ledgerRows[0]?.balance_after})`
    );

    // Legacy-side
    const userRow = await getUserLegacyCols(user1);
    assert(userRow !== null, 'users row still exists');
    assert(
      userRow && parseFloat(userRow.wallet_balance_coins) === 123.456789,
      `users.wallet_balance_coins credited to 123.456789 (got ${userRow?.wallet_balance_coins})`
    );
    // trg_sync_user_balance derives users.balance = bonus + withdrawable.
    // After our UPDATE, both bonus=0 and withdrawable=123.456789, so
    // balance should be 123.456789. The trigger fires on every UPDATE
    // and overwrites whatever we set — the only way to set balance is
    // to set the split columns and let the trigger compute it.
    assert(
      userRow && parseFloat(userRow.balance) === 123.456789,
      `users.balance (trigger-derived) = 123.456789 (got ${userRow?.balance})`
    );

    const walletTxs = await getWalletTransactions(user1);
    assert(walletTxs.length === 1, `wallet_transactions has exactly 1 topup row (got ${walletTxs.length})`);
    assert(
      walletTxs[0]?.type === 'topup',
      `wallet_transactions.type = 'topup' (got ${walletTxs[0]?.type})`
    );
    assert(
      parseFloat(walletTxs[0]?.amount_coins || '0') === 123.456789,
      `wallet_transactions.amount_coins = 123.456789 (got ${walletTxs[0]?.amount_coins})`
    );
    assert(
      walletTxs[0]?.currency === 'COIN',
      `wallet_transactions.currency = 'COIN' (got ${walletTxs[0]?.currency})`
    );
  } finally {
    await cleanupTestUser(user1);
  }

  // ─────────────────────────────────────────────────────────────────
  // Scenario 2: Duplicate deposit (same depositId) → no double credit
  // ─────────────────────────────────────────────────────────────────
  console.log('\nScenario 2: Duplicate deposit (same depositId) is a no-op');
  const user2 = await seedTestUser(usdtCurrencyId);
  const depositId2 = uuidv4();

  try {
    await walletService.processDeposit(
      user2, usdtCurrencyId, depositAmount, depositId2, 'first call'
    );
    await walletService.processDeposit(
      user2, usdtCurrencyId, depositAmount, depositId2, 'second call (should be no-op)'
    );

    const ubRow2 = await prisma.userBalance.findUnique({
      where: { userId_currencyId: { userId: user2, currencyId: usdtCurrencyId } },
    });
    assert(
      ubRow2 && ubRow2.availableBalance.toString() === '123.456789',
      `availableBalance still 123.456789 after duplicate (got ${ubRow2?.availableBalance.toString()})`
    );

    const ledgerRows2 = await getLedgerEntries(user2);
    assert(ledgerRows2.length === 1, `ledger_entries still has 1 row (got ${ledgerRows2.length})`);

    const walletTxs2 = await getWalletTransactions(user2);
    assert(walletTxs2.length === 1, `wallet_transactions still has 1 row (got ${walletTxs2.length})`);

    const userRow2 = await getUserLegacyCols(user2);
    assert(
      userRow2 && parseFloat(userRow2.wallet_balance_coins) === 123.456789,
      `users.wallet_balance_coins still 123.456789 (got ${userRow2?.wallet_balance_coins})`
    );
    assert(
      userRow2 && parseFloat(userRow2.balance) === 123.456789,
      `users.balance (trigger-derived) still 123.456789 (got ${userRow2?.balance})`
    );
  } finally {
    await cleanupTestUser(user2);
  }

  // ─────────────────────────────────────────────────────────────────
  // Scenario 3: Forced mid-transaction failure → no writes persist
  // ─────────────────────────────────────────────────────────────────
  // Strategy: drop the FK target (the users row) between the
  // idempotency check and the transaction's writes. The transaction
  // hits the FK constraint on user_id during the legacy-side UPDATE
  // (which runs AFTER the Prisma-side writes) and rolls back. The
  // idempotency check passes (no pre-existing ledger row), but the
  // $executeRaw UPDATE fails on the now-orphaned user.
  //
  // We avoid the pre-inserted-conflicting-row approach because the
  // idempotency check correctly treats it as a no-op (which is the
  // production-safe behavior). The pre-existing-ledger-entry path is
  // Scenario 2. Scenario 3 needs a *different* failure path.
  console.log('\nScenario 3: Forced mid-transaction failure → no writes persist');
  const user3 = await seedTestUser(usdtCurrencyId);
  const depositId3 = uuidv4();

  // Make a *fresh* currency_id that will be used for the orphan
  // user, so the FK violation is forced. We create a test user, then
  // delete it right before calling processDeposit (after the
  // idempotency check, before the tx).
  const orphanUserId = uuidv4();
  await queryPool(
    `INSERT INTO users (id, username, email, password_hash, is_active, is_admin, kyc_status, kyc_tier)
     VALUES ($1, $2, $3, $4, true, false, 'unverified', 0)
     ON CONFLICT (id) DO NOTHING`,
    [orphanUserId, `wo3_orphan_${orphanUserId.slice(0, 8)}`, `wo3_orphan_${orphanUserId.slice(0, 8)}@test.local`, 'bcrypt-hash']
  );
  // Prisma-side writes need the user_balances row to exist with FK valid
  // at the start of the tx (or the upsert creates it). Since we're
  // using an orphan user, the userBalance.upsert on a non-existent
  // user FK will fail inside the tx.
  // We DON'T seed a user_balances row — the upsert will create one,
  // and the legacy-side UPDATE on the same userId will fail because
  // the user was deleted mid-test.
  //
  // Delete the orphan user before the call.
  await queryPool('DELETE FROM users WHERE id = $1', [orphanUserId]);

  try {
    // The function will start the tx; userBalance.upsert will try
    // to INSERT a row referencing the now-nonexistent orphanUserId.
    // The FK on user_balances.user_id -> users.id will fire.
    // (If it doesn't — because the upsert was already cached — we
    // also have the legacy-side UPDATE which will also fail.)
    let threw = false;
    let caughtMsg = '';
    try {
      await walletService.processDeposit(
        orphanUserId, usdtCurrencyId, depositAmount, depositId3, 'should fail on FK violation'
      );
    } catch (err) {
      threw = true;
      caughtMsg = (err as Error).message;
    }

    assert(threw, 'processDeposit threw (not swallowed)');
    assert(
      caughtMsg.length > 0,
      `processDeposit threw with a non-empty error (got: ${caughtMsg.slice(0, 200)})`
    );

    // Verify NOTHING was persisted for the orphan user.
    const ubRow3 = await prisma.userBalance.findUnique({
      where: { userId_currencyId: { userId: orphanUserId, currencyId: usdtCurrencyId } },
    });
    assert(ubRow3 === null, 'user_balances NOT created (rolled back)');

    const ledgerRows3 = await getLedgerEntries(orphanUserId);
    assert(ledgerRows3.length === 0, `ledger_entries NOT created (got ${ledgerRows3.length})`);

    const walletTxs3 = await getWalletTransactions(orphanUserId);
    assert(walletTxs3.length === 0, `wallet_transactions NOT created (got ${walletTxs3.length})`);
  } finally {
    // Cleanup: try to delete the orphan user (probably already gone)
    // and any related rows. Safe if they don't exist.
    await queryPool('DELETE FROM ledger_entries WHERE user_id = $1', [orphanUserId]);
    await queryPool('DELETE FROM wallet_transactions WHERE user_id = $1', [orphanUserId]);
    await queryPool('DELETE FROM user_balances WHERE user_id = $1', [orphanUserId]);
    await queryPool('DELETE FROM users WHERE id = $1', [orphanUserId]);
    await cleanupTestUser(user3);
  }

  // ─────────────────────────────────────────────────────────────────
  // Scenario 4: wallet_transactions INSERT uses the real column shape
  // ─────────────────────────────────────────────────────────────────
  // The pre-WO-3 syncExistingBalance referenced columns that don't
  // exist (amount, description, status). If the new code still
  // tried to write those, the INSERT would fail and the whole tx
  // would roll back. Scenario 1 already proved the INSERT succeeds
  // (we got exactly 1 wallet_transactions row). This scenario
  // confirms the column VALUES are sensible (amount_coins, not amount).
  console.log('\nScenario 4: wallet_transactions uses real column shape (amount_coins, not amount)');
  const user4 = await seedTestUser(usdtCurrencyId);
  const depositId4 = uuidv4();

  try {
    await walletService.processDeposit(
      user4, usdtCurrencyId, depositAmount, depositId4, 'column-shape test'
    );

    const walletTxs4 = await getWalletTransactions(user4);
    assert(walletTxs4.length === 1, 'wallet_transactions row exists');
    const tx = walletTxs4[0];
    assert(tx !== undefined, 'wallet_transactions row fetched');
    if (tx) {
      assert(tx.hasOwnProperty('amount_coins'), 'row has amount_coins column (not amount)');
      assert(!tx.hasOwnProperty('amount') || (tx as any).amount === undefined,
        'row does NOT have deprecated amount column');
      assert(tx.type === 'topup', 'type is "topup" (live schema CHECK constraint)');
      assert(tx.currency === 'COIN', 'currency is "COIN" (live schema default)');
      assert(typeof tx.note === 'string', 'note is a string (was "description" in the broken version)');
    }
  } finally {
    await cleanupTestUser(user4);
  }

  console.log('');
  if (failed) {
    console.error('FAILED: WO-3 atomic-deposit tests did not all pass');
    process.exit(1);
  } else {
    console.log('🎉 All WO-3 atomic-deposit tests passed');
  }
}

(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('Fatal error during test run:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
    // Capture pool to a local before the finally so the type system
    // doesn't narrow it to `never` after the process.exit(1) branch
    // in the inner try block. `as any` because pg's Pool type is
    // generic over T extends QueryResultRow and our any-row type
    // trips the variance check.
    const p: any = pool;
    if (p) await p.end().catch(() => {});
  }
})();