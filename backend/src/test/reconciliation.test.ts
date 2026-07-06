import crypto from 'crypto';
import Module from 'module';

// Mocks database tables
const mockUsers: any[] = [];
const mockWallets: any[] = [];
const mockTransactions: any[] = [];
const mockBets: any[] = [];
const mockSquads: any[] = [];
const mockSquadMembers: any[] = [];
const mockRainClaims: any[] = [];
const mockLedgerAlerts: any[] = [];

// Intercept modules
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'bullmq') {
    return {
      Queue: class MockQueue {},
      Worker: class MockWorker {}
    };
  }
  return originalRequire.apply(this, arguments as any);
};

// SQL query interceptor and mock engine
async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
    return { rows: [] };
  }

  // 1. Fetch user actual balance
  if (normalized.startsWith('SELECT balance, is_active FROM users')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [user] : [] };
  }

  // 2. Fetch expected user balance components (user_id = $1)
  // The merged reconcile was patched to also count 'bonus' rows
  // as deposits and accept both 'completed' (merged vocab) and
  // 'confirmed' (pre-merge vocab) as a settled status. The mock
  // patterns below mirror that expanded query.
  if (normalized.includes("SUM(amount)") && normalized.includes("user_id = $1") && normalized.includes("type IN ('deposit', 'bonus')") && normalized.includes("status IN ('completed', 'confirmed')")) {
    const userId = params[0];
    const txs = mockTransactions.filter(t => t.user_id === userId && (t.type === 'deposit' || t.type === 'bonus') && (t.status === 'completed' || t.status === 'confirmed'));
    const total = txs.reduce((acc, t) => acc + Number(t.amount), 0);
    return { rows: [{ total }] };
  }

  // Withdrawals (includes the merged 'confirming' and pre-merge 'cancelled' states)
  if (normalized.includes("SUM(amount)") && normalized.includes("user_id = $1") && normalized.includes("type = 'withdrawal'") && normalized.includes("'pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled'")) {
    const userId = params[0];
    const txs = mockTransactions.filter(t => t.user_id === userId && t.type === 'withdrawal' && ['pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled'].includes(t.status));
    const total = txs.reduce((acc, t) => acc + Number(t.amount), 0);
    return { rows: [{ total }] };
  }

  // Bets resolved
  if (normalized.includes("SUM(payout - amount)") && normalized.includes("bets")) {
    const userId = params[0];
    const bets = mockBets.filter(b => b.user_id === userId && b.status === 'resolved');
    const total = bets.reduce((acc, b) => acc + (Number(b.payout) - Number(b.amount)), 0);
    return { rows: [{ total }] };
  }

  // Squad flips completed
  if (normalized.includes("sm.payout - sq.bet_amount_each") && normalized.includes("squad_members")) {
    const userId = params[0];
    const members = mockSquadMembers.filter(sm => sm.user_id === userId);
    let total = 0;
    for (const sm of members) {
      const sq = mockSquads.find(s => s.id === sm.squad_id && s.status === 'finished');
      if (sq) {
        total += (Number(sm.payout) - Number(sq.bet_amount_each));
      }
    }
    return { rows: [{ total }] };
  }

  // Rain claims
  if (normalized.includes("SUM(amount)") && normalized.includes("rain_claims")) {
    const userId = params[0];
    const claims = mockRainClaims.filter(c => c.user_id === userId);
    const total = claims.reduce((acc, c) => acc + Number(c.amount), 0);
    return { rows: [{ total }] };
  }

  // User alerts insertion
  if (normalized.startsWith('INSERT INTO ledger_alerts')) {
    const id = crypto.randomUUID();
    const user_id = params[0];
    let alert_type = '';
    if (normalized.includes("'user_balance_mismatch'")) alert_type = 'user_balance_mismatch';
    else if (normalized.includes("'wallet_balance_mismatch'")) alert_type = 'wallet_balance_mismatch';
    else if (normalized.includes("'wallet_locked_balance_mismatch'")) alert_type = 'wallet_locked_balance_mismatch';

    mockLedgerAlerts.push({
      id,
      user_id,
      alert_type,
      created_at: new Date()
    });
    return { rows: [{ id }] };
  }

  // 3. Fetch wallets
  if (normalized.startsWith('SELECT id, chain, token_symbol, balance, locked_balance FROM wallets')) {
    const userId = params[0];
    const wallets = mockWallets.filter(w => w.user_id === userId);
    return { rows: wallets };
  }

  // Wallet deposits (wallet_id = $1)
  // Includes the merged 'bonus' + 'confirmed' status extension.
  if (normalized.includes("SUM(amount)") && normalized.includes("wallet_id = $1") && normalized.includes("type IN ('deposit', 'bonus')") && normalized.includes("status IN ('completed', 'confirmed')")) {
    const walletId = params[0];
    const txs = mockTransactions.filter(t => t.wallet_id === walletId && (t.type === 'deposit' || t.type === 'bonus') && (t.status === 'completed' || t.status === 'confirmed'));
    const total = txs.reduce((acc, t) => acc + Number(t.amount), 0);
    return { rows: [{ total }] };
  }

  // Wallet withdrawals (all, wallet_id = $1) — also extended
  if (normalized.includes("SUM(amount)") && normalized.includes("wallet_id = $1") && normalized.includes("type = 'withdrawal'") && normalized.includes("'pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled'")) {
    const walletId = params[0];
    const txs = mockTransactions.filter(t => t.wallet_id === walletId && t.type === 'withdrawal' && ['pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled'].includes(t.status));
    const total = txs.reduce((acc, t) => acc + Number(t.amount), 0);
    return { rows: [{ total }] };
  }

  // Wallet withdrawals (locked only: pending/confirming/failed, wallet_id = $1)
  // NOTE: settled states ('completed', 'confirmed') are NOT locked —
  // they're already debited from the wallet.
  if (normalized.includes("SUM(amount)") && normalized.includes("wallet_id = $1") && normalized.includes("type = 'withdrawal'") && normalized.includes("'pending', 'confirming', 'failed'") && !normalized.includes("'confirmed'")) {
    const walletId = params[0];
    const txs = mockTransactions.filter(t => t.wallet_id === walletId && t.type === 'withdrawal' && ['pending', 'confirming', 'failed'].includes(t.status));
    const total = txs.reduce((acc, t) => acc + Number(t.amount), 0);
    return { rows: [{ total }] };
  }

  // Update user active status (Freeze account)
  if (normalized.startsWith('UPDATE users SET is_active = false')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.is_active = false;
    }
    return { rows: [] };
  }

  return { rows: [] };
}

// Inject DB Mocks
import * as dbModule from '../config/database';
const mockDb = {
  connect: async () => ({
    query: async (text: string, params: any[]) => mockQuery(text, params),
    release: () => {}
  }),
  query: async (text: string, params: any[]) => mockQuery(text, params)
};
(dbModule as any).db = mockDb;
(dbModule as any).query = mockQuery;

// Import reconciliation service
(global as any).__TEST_USE_REAL_RECONCILIATION__ = true;
import { reconcileUser } from '../services/reconciliation-engine';

async function runTests() {
  console.log('🧪 Starting Real-Time Reconciliation Engine Tests...');

  const userId = 'user-123-reconcile-test-uuid-4567';
  const walletId = 'wallet-789-reconcile-test-uuid-0123';

  // Seed default user and wallet
  mockUsers.push({
    id: userId,
    username: 'test_reconciler',
    balance: 100.00,
    is_active: true
  });

  mockWallets.push({
    id: walletId,
    user_id: userId,
    chain: 'ethereum',
    token_symbol: 'USDT',
    balance: 100.00,
    locked_balance: 0.00
  });

  // Seed deposit and withdrawal matching the balance
  mockTransactions.push({
    id: 'tx-dep-1',
    user_id: userId,
    wallet_id: walletId,
    type: 'deposit',
    amount: 150.00,
    status: 'completed'
  });

  mockTransactions.push({
    id: 'tx-wd-1',
    user_id: userId,
    wallet_id: walletId,
    type: 'withdrawal',
    amount: 50.00,
    status: 'completed'
  });

  // Expected user balance components: deposits(150) - withdrawals(50) = 100.00
  // Actual user balance: 100.00
  // Wallets expected: deposits(150) - withdrawals(50) = 100.00
  // Actual wallet: 100.00, locked: 0.00
  // Reconciled should be VALID

  try {
    // Scenario 1: Test valid state
    console.log('\nScenario 1: Testing valid account balances...');
    const res1 = await reconcileUser(userId);
    if (res1.isValid && !res1.frozen) {
      console.log('✅ Success: Valid account returned isValid = true and account was not frozen.');
    } else {
      throw new Error(`Expected valid state but got isValid = ${res1.isValid}, frozen = ${res1.frozen}`);
    }

    // Scenario 2: Test user balance mismatch (Compromised balance)
    console.log('\nScenario 2: Testing user balance mismatch detection...');
    // Manually modify user balance to trigger mismatch
    const user = mockUsers.find(u => u.id === userId);
    user.balance = 120.00; // Expected is 100.00

    const res2 = await reconcileUser(userId);
    if (!res2.isValid && res2.frozen && !user.is_active) {
      console.log('✅ Success: User balance mismatch detected, account successfully frozen, and alert logged.');
      if (mockLedgerAlerts.length === 1 && mockLedgerAlerts[0].alert_type === 'user_balance_mismatch') {
        console.log('✅ Alert details verified: logged type "user_balance_mismatch".');
      } else {
        throw new Error('Failed to find expected user mismatch alert in DB.');
      }
    } else {
      throw new Error(`Expected mismatch freeze but got isValid = ${res2.isValid}, frozen = ${res2.frozen}, user active = ${user.is_active}`);
    }

    // Restore user state
    user.is_active = true;
    user.balance = 100.00;
    mockLedgerAlerts.length = 0; // Reset alerts

    // Scenario 3: Test wallet balance mismatch detection
    console.log('\nScenario 3: Testing wallet balance mismatch detection...');
    const wallet = mockWallets.find(w => w.id === walletId);
    wallet.balance = 110.00; // Expected is 100.00

    const res3 = await reconcileUser(userId);
    if (!res3.isValid && res3.frozen && !user.is_active) {
      console.log('✅ Success: Wallet balance mismatch detected and account frozen.');
      if (mockLedgerAlerts.some(a => a.alert_type === 'wallet_balance_mismatch')) {
        console.log('✅ Alert details verified: logged type "wallet_balance_mismatch".');
      } else {
        throw new Error('Failed to find expected wallet mismatch alert in DB.');
      }
    } else {
      throw new Error(`Expected mismatch freeze but got isValid = ${res3.isValid}, frozen = ${res3.frozen}, user active = ${user.is_active}`);
    }

    // Restore user & wallet state
    user.is_active = true;
    wallet.balance = 100.00;
    mockLedgerAlerts.length = 0;

    // Scenario 4: Test wallet locked balance mismatch detection
    console.log('\nScenario 4: Testing wallet locked balance mismatch detection...');
    // Seed an outstanding pending withdrawal of 10 USDT
    mockTransactions.push({
      id: 'tx-wd-pending',
      user_id: userId,
      wallet_id: walletId,
      type: 'withdrawal',
      amount: 10.00,
      status: 'pending'
    });
    // Expected wallet balance = deposits(150) - withdrawals(50 + 10) = 90.00
    // Expected wallet locked_balance = pending withdrawals(10) = 10.00
    // Setup matching actual wallet state
    wallet.balance = 90.00;
    wallet.locked_balance = 12.00; // Expected is 10.00, mismatch!
    user.balance = 90.00;

    const res4 = await reconcileUser(userId);
    if (!res4.isValid && res4.frozen && !user.is_active) {
      console.log('✅ Success: Wallet locked balance mismatch detected and account frozen.');
      if (mockLedgerAlerts.some(a => a.alert_type === 'wallet_locked_balance_mismatch')) {
        console.log('✅ Alert details verified: logged type "wallet_locked_balance_mismatch".');
      } else {
        throw new Error('Failed to find expected wallet locked balance mismatch alert in DB.');
      }
    } else {
      throw new Error(`Expected mismatch freeze but got isValid = ${res4.isValid}, frozen = ${res4.frozen}, user active = ${user.is_active}`);
    }

    console.log('\n🎉 All reconciliation engine tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
