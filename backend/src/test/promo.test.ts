import Module from 'module';
import { Request, Response } from 'express';

// ============================================================================
// 0. Intercept ioredis and reconciliation before anything else is loaded
// ============================================================================
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      set() { return 'OK'; }
      get() { return null; }
      incr() { return 1; }
      del() {}
      expire() {}
    };
  }
  if (id === './reconciliation-engine' || id === '../services/reconciliation-engine') {
    return {
      reconcileUser: async (userId: string, client?: any) => ({
        userId,
        isValid: true,
        userBalance: { expected: 0, actual: 0, mismatch: 0 },
        walletBalances: [],
        frozen: false
      })
    };
  }
  if (id === './cache' || id === '../services/cache') {
    return {
      invalidateCache: async () => {}
    };
  }
  return originalRequire.apply(this, arguments as any);
};

import { db } from '../config/database';
import promoRouter from '../routes/promo';

// Import function to test deposit matching
import { completeDeposit } from '../services/deposit-monitor';

// ============================================================================
// 1. Mock DB State
// ============================================================================
const mockUsers = [
  {
    id: 'user-promo-1',
    username: 'promo_hunter',
    email: 'promo@example.com',
    balance: '100.00000000',
    is_active: true
  }
];

const mockWallets = [
  {
    id: 'wallet-promo-1',
    user_id: 'user-promo-1',
    chain: 'ethereum',
    address: '0x1234567890123456789012345678901234567890',
    balance: '100.00000000',
    locked_balance: '0.00000000'
  }
];

const mockPromoCodes = [
  {
    id: 'promo-no-dep',
    code: 'WELCOME10',
    type: 'no_deposit',
    value: '10.00000000',
    max_uses: 100,
    uses_count: 0,
    max_bonus_amount: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: true
  },
  {
    id: 'promo-dep-match',
    code: 'MATCH100',
    type: 'deposit_match',
    value: '1.00000000',
    max_uses: 0,
    uses_count: 5,
    max_bonus_amount: '500.00000000',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: true
  },
  {
    id: 'promo-expired',
    code: 'EXPIRED50',
    type: 'no_deposit',
    value: '50.00000000',
    max_uses: 0,
    uses_count: 0,
    max_bonus_amount: null,
    expires_at: new Date(Date.now() - 86400000).toISOString(),
    is_active: true
  },
  {
    id: 'promo-inactive',
    code: 'INACTIVE',
    type: 'no_deposit',
    value: '5.00000000',
    max_uses: 0,
    uses_count: 0,
    max_bonus_amount: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: false
  }
];

const mockUserPromos: any[] = [];
const mockTransactions: any[] = [];

// ============================================================================
// 2. Query Mock Interceptors
// ============================================================================
async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  // 2a. SELECT active user promos
  if (normalized.includes('SELECT pc.code, pc.value, pc.max_bonus_amount FROM user_promos up')) {
    const userId = params[0];
    const upRow = mockUserPromos.find(up => up.user_id === userId && up.status === 'active');
    if (!upRow) return { rows: [] };
    const codeRow = mockPromoCodes.find(pc => pc.id === upRow.promo_code_id);
    return { rows: codeRow ? [{ code: codeRow.code, value: codeRow.value, max_bonus_amount: codeRow.max_bonus_amount }] : [] };
  }

  // 2b. SELECT promo code details
  if (normalized.includes('SELECT id, type, value, max_uses, uses_count, max_bonus_amount, expires_at, is_active FROM promo_codes')) {
    const code = params[0];
    const promo = mockPromoCodes.find(p => p.code === code);
    return { rows: promo ? [promo] : [] };
  }

  // 2c. SELECT user_promos check
  if (normalized.includes('SELECT status FROM user_promos WHERE user_id = $1 AND promo_code_id = $2')) {
    const userId = params[0];
    const promoId = params[1];
    const match = mockUserPromos.find(up => up.user_id === userId && up.promo_code_id === promoId);
    return { rows: match ? [match] : [] };
  }

  // 2d. SELECT active user_promos for deposit match check
  if (normalized.includes("SELECT promo_code_id FROM user_promos WHERE user_id = $1 AND status = 'active'")) {
    const userId = params[0];
    const match = mockUserPromos.find(up => up.user_id === userId && up.status === 'active');
    return { rows: match ? [match] : [] };
  }

  // 2e. SELECT users table balance checks
  if (normalized.includes('SELECT balance FROM users WHERE id = $1')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
    if (!user) return { rows: [] };
    // Auto-fill balance columns for tests using single-balance mock users
    if ((user as any).withdrawable_balance_coins === undefined) {
      (user as any).withdrawable_balance_coins = String((user as any).balance);
    }
    if ((user as any).bonus_balance_coins === undefined) {
      (user as any).bonus_balance_coins = '0';
    }
    return { rows: [user] };
  }

  if (normalized.includes('SELECT balance FROM wallets WHERE id = $1')) {
    const walletId = params[0];
    const wallet = mockWallets.find(w => w.id === walletId);
    return { rows: wallet ? [wallet] : [] };
  }

  // 2f. SELECT active deposit match promos during deposit credit
  if (normalized.includes('SELECT up.promo_code_id, pc.code, pc.value, pc.max_bonus_amount FROM user_promos up')) {
    const userId = params[0];
    const upRow = mockUserPromos.find(up => up.user_id === userId && up.status === 'active');
    if (!upRow) return { rows: [] };
    const codeRow = mockPromoCodes.find(pc => pc.id === upRow.promo_code_id);
    return { rows: codeRow ? [{ promo_code_id: upRow.promo_code_id, code: codeRow.code, value: codeRow.value, max_bonus_amount: codeRow.max_bonus_amount }] : [] };
  }

  // 2g. UPDATE users balance
  if (normalized.startsWith('UPDATE users SET balance = balance + $1') || normalized.startsWith('UPDATE users SET balance = $1')) {
    const balance = params[0];
    const userId = params[1];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      if (normalized.includes('balance + $1')) {
        user.balance = String(parseFloat(user.balance) + balance);
      } else {
        user.balance = String(balance);
      }
    }
    return { rows: [] };
  }

  // 2h. UPDATE wallets balance
  if (normalized.startsWith('UPDATE wallets SET balance = balance + $1')) {
    const amount = params[0];
    const walletId = params[1];
    const wallet = mockWallets.find(w => w.id === walletId);
    if (wallet) {
      wallet.balance = String(parseFloat(wallet.balance) + amount);
    }
    return { rows: [] };
  }

  // 2i. UPDATE promo_codes increments
  if (normalized.startsWith('UPDATE promo_codes SET uses_count = uses_count + 1')) {
    const promoId = params[0];
    const promo = mockPromoCodes.find(p => p.id === promoId);
    if (promo) {
      promo.uses_count += 1;
    }
    return { rows: [] };
  }

  // 2j. UPDATE user_promos status updates
  if (normalized.startsWith('UPDATE user_promos SET status = \'claimed\'')) {
    const amount = params[0];
    const userId = params[1];
    const promoId = params[2];
    const upRow = mockUserPromos.find(up => up.user_id === userId && up.promo_code_id === promoId);
    if (upRow) {
      upRow.status = 'claimed';
      upRow.claimed_amount = amount;
    }
    return { rows: [] };
  }

  // 2k. INSERT user_promos
  if (normalized.startsWith('INSERT INTO user_promos')) {
    const isClaimed = normalized.includes("'claimed'");
    mockUserPromos.push({
      user_id: params[0],
      promo_code_id: params[1],
      status: isClaimed ? 'claimed' : 'active',
      claimed_amount: isClaimed ? params[2] : 0
    });
    return { rows: [] };
  }

  // 2l. INSERT transactions
  if (normalized.startsWith('INSERT INTO transactions')) {
    let type = 'unknown';
    if (normalized.includes("'bonus'")) {
      type = 'bonus';
    } else if (normalized.includes("'deposit'")) {
      type = 'deposit';
    }

    const hasWalletIdParam = params.length > 3;
    const amount = hasWalletIdParam ? params[3] : params[2];
    const walletId = hasWalletIdParam ? params[2] : null;
    const refId = hasWalletIdParam ? params[4] : null;

    mockTransactions.push({
      id: params[0],
      user_id: params[1],
      wallet_id: walletId,
      type,
      amount,
      status: 'completed',
      reference_id: refId,
      reference_type: hasWalletIdParam ? 'deposit' : 'promo_code'
    });
    return { rows: [] };
  }

  // 2m. UPDATE transactions completed status
  if (normalized.startsWith('UPDATE transactions SET status = \'completed\'')) {
    return { rows: [] };
  }

  return { rows: [] };
}

// Override DB connection
db.query = mockQuery as any;
(global as any).__TEST_MOCK_QUERY__ = mockQuery;
db.connect = async () => {
  return {
    query: mockQuery,
    release: () => {},
  } as any;
};

// Express routing helper
function getRouteHandler(router: any, path: string, method: string) {
  const route = router.stack.find((s: any) => s.route && s.route.path === path && s.route.methods[method]);
  return route.route.stack[route.route.stack.length - 1].handle;
}

async function runTests() {
  console.log('🧪 Starting Promo Codes & Welcome Bonuses Integration Tests...');

  try {
    const claimHandler = getRouteHandler(promoRouter, '/promo/claim', 'post');
    const getActiveHandler = getRouteHandler(promoRouter, '/promo/active', 'get');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Validation Rules (Expired, Inactive, Invalid)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing promo validation checks...');

    // 1a. Test invalid promo code
    const req1 = {
      user: { userId: 'user-promo-1' },
      body: { code: 'INVALIDCODE' }
    } as unknown as Request;
    let code1 = 200;
    let resp1: any = null;
    const res1 = {
      status(code: number) { code1 = code; return this; },
      json(data: any) { resp1 = data; return this; }
    } as unknown as Response;

    await claimHandler(req1, res1);
    if (code1 !== 400 || resp1.error !== 'প্রোমো কোডটি সঠিক নয়।') {
      throw new Error(`Expected rejection of invalid code, got ${code1}: ${JSON.stringify(resp1)}`);
    }
    console.log('✅ Invalid promo code rejected correctly.');

    // 1b. Test expired promo code
    const req2 = {
      user: { userId: 'user-promo-1' },
      body: { code: 'EXPIRED50' }
    } as unknown as Request;
    let code2 = 200;
    let resp2: any = null;
    const res2 = {
      status(code: number) { code2 = code; return this; },
      json(data: any) { resp2 = data; return this; }
    } as unknown as Response;

    await claimHandler(req2, res2);
    if (code2 !== 400 || resp2.error !== 'এই প্রোমো কোডটির মেয়াদ শেষ হয়ে গেছে।') {
      throw new Error(`Expected expired rejection, got ${code2}: ${JSON.stringify(resp2)}`);
    }
    console.log('✅ Expired promo code rejected correctly.');

    // 1c. Test inactive promo code
    const req3 = {
      user: { userId: 'user-promo-1' },
      body: { code: 'INACTIVE' }
    } as unknown as Request;
    let code3 = 200;
    let resp3: any = null;
    const res3 = {
      status(code: number) { code3 = code; return this; },
      json(data: any) { resp3 = data; return this; }
    } as unknown as Response;

    await claimHandler(req3, res3);
    if (code3 !== 400 || resp3.error !== 'এই প্রোমো কোডটি বর্তমানে নিষ্ক্রিয়।') {
      throw new Error(`Expected inactive rejection, got ${code3}: ${JSON.stringify(resp3)}`);
    }
    console.log('✅ Inactive promo code rejected correctly.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: No-Deposit Promo Claim (Instant Credit)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing no-deposit instant welcome bonus claiming...');

    const initialBalance = parseFloat(mockUsers[0].balance);
    const req4 = {
      user: { userId: 'user-promo-1' },
      body: { code: 'WELCOME10' }
    } as unknown as Request;
    let code4 = 200;
    let resp4: any = null;
    const res4 = {
      status(code: number) { code4 = code; return this; },
      json(data: any) { resp4 = data; return this; }
    } as unknown as Response;

    await claimHandler(req4, res4);
    if (code4 !== 200 || !resp4.success || resp4.amount !== 10.00) {
      throw new Error(`Expected successful no-deposit claim, got ${code4}: ${JSON.stringify(resp4)}`);
    }

    if (parseFloat(mockUsers[0].balance) !== initialBalance + 10.00) {
      throw new Error(`Expected user balance to be incremented by 10, got: ${mockUsers[0].balance}`);
    }

    // Verify claim and transaction logging
    const claimedPromo = mockUserPromos.find(up => up.user_id === 'user-promo-1' && up.promo_code_id === 'promo-no-dep');
    if (!claimedPromo || claimedPromo.status !== 'claimed' || claimedPromo.claimed_amount !== 10.00) {
      throw new Error(`User promo claim record missing or invalid: ${JSON.stringify(mockUserPromos)}`);
    }

    const bonusTx = mockTransactions.find(t => t.user_id === 'user-promo-1' && t.type === 'bonus');
    if (!bonusTx || bonusTx.amount !== 10.00) {
      throw new Error(`Bonus transaction log missing or invalid: ${JSON.stringify(mockTransactions)}`);
    }
    console.log('✅ Instant no-deposit bonus credited and logged successfully.');

    // Duplicate claim check
    let duplicateCode = 200;
    await claimHandler(req4, {
      status(code: number) { duplicateCode = code; return this; },
      json(data: any) { return this; }
    } as unknown as Response);
    if (duplicateCode !== 400) {
      throw new Error(`Expected duplicate claim rejection with status 400, got: ${duplicateCode}`);
    }
    console.log('✅ Duplicate promo code claims correctly blocked.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Deposit Match Activation & Confirmation matching
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing deposit-match promo code activation and match triggers...');

    // 3a. Claim deposit match promo MATCH100
    const req5 = {
      user: { userId: 'user-promo-1' },
      body: { code: 'MATCH100' }
    } as unknown as Request;
    let code5 = 200;
    let resp5: any = null;
    const res5 = {
      status(code: number) { code5 = code; return this; },
      json(data: any) { resp5 = data; return this; }
    } as unknown as Response;

    await claimHandler(req5, res5);
    if (code5 !== 200 || !resp5.success || resp5.type !== 'deposit_match') {
      throw new Error(`Expected deposit match code activation, got ${code5}: ${JSON.stringify(resp5)}`);
    }

    const activeMatch = mockUserPromos.find(up => up.user_id === 'user-promo-1' && up.promo_code_id === 'promo-dep-match');
    if (!activeMatch || activeMatch.status !== 'active') {
      throw new Error(`Pending active deposit match promo not recorded in state: ${JSON.stringify(mockUserPromos)}`);
    }

    // Verify /promo/active endpoint
    const reqAct = { user: { userId: 'user-promo-1' } } as any;
    let actResp: any = null;
    await getActiveHandler(reqAct, { json(data: any) { actResp = data; } } as any);
    if (!actResp || !actResp.success || actResp.activePromo.code !== 'MATCH100') {
      throw new Error(`Expected active promo endpoint to return MATCH100, got: ${JSON.stringify(actResp)}`);
    }
    console.log('✅ Deposit match code successfully activated and returned via endpoint.');

    // 3b. Simulate EVM USDT deposit credit of $250.00
    // Initial user balance is 110.00 (100.00 + 10.00 bonus from Scenario 2).
    // Deposit of $250.00 with 100% match should credit:
    // Deposit: $250.00
    // Bonus Match: $250.00 (total increase = $500.00, new balance = $610.00).
    const initialUserBalance = parseFloat(mockUsers[0].balance);
    const initialWalletBalance = parseFloat(mockWallets[0].balance);

    await completeDeposit(
      'dep-tx-123',
      'wallet-promo-1',
      'user-promo-1',
      250.00
    );

    const finalUserBalance = parseFloat(mockUsers[0].balance);
    const finalWalletBalance = parseFloat(mockWallets[0].balance);

    if (finalUserBalance !== initialUserBalance + 250.00 + 250.00) {
      throw new Error(`Expected user balance to be credited with deposit + matching bonus, expected 610.00, got: ${finalUserBalance}`);
    }
    if (finalWalletBalance !== initialWalletBalance + 250.00 + 250.00) {
      throw new Error(`Expected wallet balance to be credited with deposit + matching bonus, expected 610.00, got: ${finalWalletBalance}`);
    }

    // Verify match status transitioned to claimed
    if (activeMatch.status !== 'claimed' || activeMatch.claimed_amount !== 250.00) {
      throw new Error(`Deposit match status not updated correctly in database: ${JSON.stringify(activeMatch)}`);
    }

    // Verify matching bonus transaction logged in database
    const matchTx = mockTransactions.find(t => t.user_id === 'user-promo-1' && t.type === 'bonus' && t.reference_type === 'deposit');
    if (!matchTx || matchTx.amount !== 250.00) {
      throw new Error(`Expected matching bonus transaction missing or invalid: ${JSON.stringify(mockTransactions)}`);
    }
    console.log('✅ Deposit monitoring correctly intercepted deposit credit and applied capped matching promo balances.');

    console.log('\n🎉 All promo codes & welcome bonuses integration tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Promo test failed:', error);
    process.exit(1);
  }
}

runTests();
