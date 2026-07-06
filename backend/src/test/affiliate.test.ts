import Module from 'module';
import { Request, Response } from 'express';

// ============================================================================
// 0. Intercept ioredis and other external services
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
  return originalRequire.apply(this, arguments as any);
};

import * as dbModule from '../config/database';
import { db } from '../config/database';
import { placeBet } from '../services/game-engine';
import authRouter from '../routes/auth';
import affiliateRouter from '../routes/affiliate';

// ============================================================================
// 1. Mock DB and Users/Transactions State
// ============================================================================
const mockUsers = [
  {
    id: 'user-referrer',
    username: 'referrer_user',
    email: 'referrer@example.com',
    password_hash: '$2a$12$abcdefghijklmnopqrstuv',
    balance: '100.00',
    total_wagered: '0.00',
    pending_rakeback: '0.00',
    referral_code: 'REFGOOD1',
    referred_by: null,
    pending_affiliate_balance: '0.50',
    total_affiliate_earned: '0.50',
    is_active: true,
  },
  {
    id: 'user-referee',
    username: 'referee_user',
    email: 'referee@example.com',
    password_hash: '$2a$12$abcdefghijklmnopqrstuv',
    balance: '50.00',
    total_wagered: '0.00',
    pending_rakeback: '0.00',
    referral_code: 'REFGOOD2',
    referred_by: 'user-referrer',
    pending_affiliate_balance: '0.00',
    total_affiliate_earned: '0.00',
    is_active: true,
  }
];

const mockTransactions: any[] = [];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');


  // Generic fallback for new dual-balance SELECT queries (added by shared-mocks patcher)
  if (normalized.includes('SELECT balance, bonus_balance_coins, withdrawable_balance_coins') && normalized.includes('FROM users')) {
    const userId = params[0];
    const user = mockUsers.find((u: any) => u.id === userId);
    if (!user) return { rows: [] };
    const __u = user as any;
    if (__u.withdrawable_balance_coins === undefined) __u.withdrawable_balance_coins = String(__u.balance);
    if (__u.bonus_balance_coins === undefined) __u.bonus_balance_coins = '0';
    if (__u.total_wagered === undefined) __u.total_wagered = '0.00';
    if (__u.pending_rakeback === undefined) __u.pending_rakeback = '0.00';
    return { rows: [user] };
  }

  // users SELECT query
  if (normalized.includes('SELECT balance, total_wagered, pending_rakeback, referred_by FROM users')) {
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

  if (normalized.includes('SELECT referral_code, pending_affiliate_balance, total_affiliate_earned FROM users')) {
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

  if (normalized.includes('SELECT id FROM users WHERE referral_code = $1')) {
    const code = params[0];
    const user = mockUsers.find(u => u.referral_code === code);
    if (!user) return { rows: [] };
    const __u = user as any;
    if (__u.withdrawable_balance_coins === undefined) {
      __u.withdrawable_balance_coins = String(__u.balance);
    }
    if (__u.bonus_balance_coins === undefined) {
      __u.bonus_balance_coins = '0';
    }
    return { rows: [user] };
  }

  if (normalized.includes('SELECT id, username FROM users WHERE username = $1')) {
    const username = params[0];
    const user = mockUsers.find(u => u.username === username);
    if (!user) return { rows: [] };
    const __u = user as any;
    if (__u.withdrawable_balance_coins === undefined) {
      __u.withdrawable_balance_coins = String(__u.balance);
    }
    if (__u.bonus_balance_coins === undefined) {
      __u.bonus_balance_coins = '0';
    }
    return { rows: [user] };
  }

  if (normalized.includes('SELECT COUNT(*) as count, COALESCE(SUM(total_wagered), 0) as wagered FROM users')) {
    const refBy = params[0];
    const referees = mockUsers.filter(u => u.referred_by === refBy);
    const sumWagered = referees.reduce((sum, u) => sum + parseFloat(u.total_wagered), 0);
    return { rows: [{ count: referees.length.toString(), wagered: sumWagered.toString() }] };
  }

  // users FOR UPDATE queries
  if (normalized.includes('SELECT pending_affiliate_balance, total_affiliate_earned FROM users WHERE id = $1 FOR UPDATE')) {
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

  if (normalized.includes('SELECT balance, pending_affiliate_balance FROM users WHERE id = $1 FOR UPDATE')) {
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


  // users UPDATE query (new dual-balance pattern) — added by shared-mocks patcher
  if (normalized.includes('UPDATE users SET') && normalized.includes('withdrawable_balance_coins')) {
    const userId = params[params.length - 1];
    const user = mockUsers.find((u: any) => u.id === userId);
    if (user) {
      const matchAdd = normalized.match(/withdrawable_balance_coins\s*=\s*withdrawable_balance_coins\s*\+\s*\$(\d+)/i);
      const matchSub = normalized.match(/withdrawable_balance_coins\s*=\s*withdrawable_balance_coins\s*-\s*\$(\d+)/i);
      const current = parseFloat((user as any).withdrawable_balance_coins || (user as any).balance);
      if (matchSub) {
        const idx = parseInt(matchSub[1]) - 1;
        const delta = parseFloat(params[idx]);
        (user as any).withdrawable_balance_coins = String(current - delta);
        (user as any).balance = String(current - delta);
      } else if (matchAdd) {
        const idx = parseInt(matchAdd[1]) - 1;
        const delta = parseFloat(params[idx]);
        (user as any).withdrawable_balance_coins = String(current + delta);
        (user as any).balance = String(current + delta);
      }
    }
    return { rows: [{ new_balance: user ? parseFloat((user as any).balance) : 0 }] };
  }

  // PATCHED_BY_SHARED_MOCKS

  // users UPDATE query (game engine)
  if (normalized.startsWith('UPDATE users SET balance = $1, total_wagered = $2, pending_rakeback = $3')) {
    const balance = params[0];
    const totalWagered = params[1];
    const pendingRakeback = params[2];
    const userId = params[3];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.balance = String(balance);
      user.total_wagered = String(totalWagered);
      user.pending_rakeback = String(pendingRakeback);
    }
    return { rows: [] };
  }

  // users UPDATE pending affiliate balance query
  if (normalized.startsWith('UPDATE users SET pending_affiliate_balance = $1, total_affiliate_earned = $2')) {
    const pending = params[0];
    const total = params[1];
    const userId = params[2];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.pending_affiliate_balance = String(pending);
      user.total_affiliate_earned = String(total);
    }
    return { rows: [] };
  }

  // users claim UPDATE query
  if (normalized.startsWith('UPDATE users SET balance = $1, pending_affiliate_balance = 0.00000000')) {
    const balance = params[0];
    const userId = params[1];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.balance = String(balance);
      user.pending_affiliate_balance = '0.00000000';
    }
    return { rows: [] };
  }

  // bets table query
  if (normalized.includes('SELECT COUNT(*) as count FROM bets')) {
    return { rows: [{ count: '5' }] };
  }

  if (normalized.startsWith('INSERT INTO bets')) {
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO admin_settings') || normalized.startsWith('INSERT INTO transactions')) {
    let type = 'unknown';
    if (normalized.includes("'affiliate_reward'")) {
      type = 'affiliate_reward';
    } else if (normalized.includes("'jackpot'")) {
      type = 'jackpot';
    } else if (normalized.includes("'rakeback'")) {
      type = 'rakeback';
    }

    const amount = normalized.includes('affiliate_reward') ? params[2] : params[4];

    mockTransactions.push({
      id: params[0],
      user_id: params[1],
      type,
      amount,
      status: 'completed'
    });
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO users')) {
    // Use predictable ids so Scenario 2 can reference them
    const predictableId = params[1] === 'user_referred' ? 'user-referee' : params[0];
    const newUser = {
      id: predictableId,
      username: params[1],
      email: params[2],
      password_hash: params[3],
      balance: '10.00',
      total_wagered: '0.00',
      pending_rakeback: '0.00',
      referral_code: params[5] || 'CF123456',
      referred_by: params[4],
      pending_affiliate_balance: '0.00',
      total_affiliate_earned: '0.00',
      is_active: true
    };
    mockUsers.push(newUser);
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT key, value FROM admin_settings')) {
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT id, url, secret FROM webhook_subscriptions')) {
    return { rows: [] };
  }

  return { rows: [] };
}

// Override both db.query and module-level query so setup's client uses test's mock
db.query = mockQuery as any;
(dbModule as any).query = mockQuery;
db.connect = async () => {
  return {
    query: mockQuery,
    release: () => {},
  } as any;
};

// Express routing helpers
function getRouteHandler(router: any, path: string, method: string) {
  const route = router.stack.find((s: any) => s.route && s.route.path === path && s.route.methods[method]);
  return route.route.stack[route.route.stack.length - 1].handle;
}

async function runTests() {
  console.log('🧪 Starting Affiliate & Referral Engine Integration Tests...');

  try {
    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Registration with Referral Codes
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing registration with valid and invalid referral codes...');

    const registerHandler = getRouteHandler(authRouter, '/register', 'post');

    // 1a. Test invalid referral code
    const req1 = {
      body: { username: 'userC', password: 'password123', referralCode: 'INVALID_CODE' }
    } as unknown as Request;
    
    let errCode = 200;
    let errResp: any = null;
    const res1 = {
      status(code: number) { errCode = code; return this; },
      json(data: any) { errResp = data; return this; }
    } as unknown as Response;

    await registerHandler(req1, res1);
    if (errCode !== 400 || !errResp || errResp.error !== 'প্রদত্ত রেফারেল কোডটি সঠিক নয়।') {
      throw new Error(`Expected registration failure with code 400 and custom error, got status ${errCode}: ${JSON.stringify(errResp)}`);
    }
    console.log('✅ Invalid referral code rejected correctly.');

    // 1b. Test valid referral code (referred by REFGOOD1)
    const req2 = {
      body: { username: 'user_referred', password: 'password123', referralCode: 'REFGOOD1' }
    } as unknown as Request;
    
    let successCode = 200;
    let successResp: any = null;
    const res2 = {
      status(code: number) { successCode = code; return this; },
      json(data: any) { successResp = data; return this; }
    } as unknown as Response;

    await registerHandler(req2, res2);
    if (successCode !== 201 || !successResp || !successResp.success) {
      throw new Error(`Expected registration success, got: ${successCode} - ${JSON.stringify(successResp)}`);
    }

    const createdUser = mockUsers.find(u => u.username === 'user_referred');
    if (!createdUser || createdUser.referred_by !== 'user-referrer') {
      throw new Error(`Referee user was not linked to referrer. User state: ${JSON.stringify(createdUser)}`);
    }
    if (!createdUser.referral_code || !createdUser.referral_code.startsWith('CF')) {
      throw new Error(`Referee user was not assigned a valid referral code: ${createdUser?.referral_code}`);
    }
    console.log('✅ Referee registered successfully and linked to referrer user.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Commission Accumulation in Game Engine
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing game engine updates on referee bet placement...');

    const initialReferrerPending = parseFloat(mockUsers[0].pending_affiliate_balance);
    
    // Referee places a bet of $20.00. House edge is 2%.
    // Commission to referrer = 20 * (2.0 / 100) * 0.10 = 0.04 USD.
    await placeBet({
      userId: 'user-referee',
      choice: 'heads',
      amount: 20.00,
      clientSeed: 'seed123',
    });

    const updatedReferrer = mockUsers[0];
    const newReferrerPending = parseFloat(updatedReferrer.pending_affiliate_balance);
    const newReferrerTotal = parseFloat(updatedReferrer.total_affiliate_earned);

    if (newReferrerPending !== initialReferrerPending + 0.04) {
      throw new Error(`Referrer pending affiliate balance not updated correctly. Expected ${initialReferrerPending + 0.04}, got ${newReferrerPending}`);
    }
    if (newReferrerTotal !== 0.50 + 0.04) {
      throw new Error(`Referrer total affiliate balance not updated correctly. Expected 0.54, got ${newReferrerTotal}`);
    }
    console.log('✅ Game engine correctly calculated and credited referrer affiliate commission.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Get Affiliate Stats and Claim Commission
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing affiliate stats and claim routes...');

    const getStatsHandler = getRouteHandler(affiliateRouter, '/affiliate', 'get');
    const claimHandler = getRouteHandler(affiliateRouter, '/affiliate/claim', 'post');

    // 3a. Test GET /affiliate stats
    const reqStats = {
      user: { userId: 'user-referrer', username: 'referrer_user', isAdmin: false, role: 'user' }
    } as any;
    
    let statsResp: any = null;
    const resStats = {
      json(data: any) { statsResp = data; return this; }
    } as unknown as Response;

    await getStatsHandler(reqStats, resStats);
    if (!statsResp || !statsResp.success || statsResp.pendingBalance !== 0.54) {
      throw new Error(`Unexpected statistics response: ${JSON.stringify(statsResp)}`);
    }
    console.log('✅ Statistics endpoint returned correct referrer data.');

    // 3b. Test POST /affiliate/claim
    const initialBalance = parseFloat(updatedReferrer.balance);
    const reqClaim = {
      user: { userId: 'user-referrer', username: 'referrer_user', isAdmin: false, role: 'user' }
    } as any;
    
    let claimResp: any = null;
    const resClaim = {
      json(data: any) { claimResp = data; return this; }
    } as unknown as Response;

    await claimHandler(reqClaim, resClaim);
    if (!claimResp || !claimResp.success || claimResp.amount !== 0.54) {
      throw new Error(`Claim failed or returned unexpected response: ${JSON.stringify(claimResp)}`);
    }

    if (parseFloat(updatedReferrer.balance) !== initialBalance + 0.54) {
      throw new Error(`Claimed amount not credited to main user balance. Balance in state: ${updatedReferrer.balance}`);
    }
    if (parseFloat(updatedReferrer.pending_affiliate_balance) !== 0) {
      throw new Error(`Claimed pending balance not reset to 0: ${updatedReferrer.pending_affiliate_balance}`);
    }

    // Verify transaction record
    const claimTx = mockTransactions.find(t => t.user_id === 'user-referrer' && t.type === 'affiliate_reward');
    if (!claimTx || parseFloat(claimTx.amount) !== 0.54) {
      throw new Error(`Expected claim transaction record missing or invalid: ${JSON.stringify(mockTransactions)}`);
    }
    console.log('✅ Claim endpoint successfully transferred pending balance to wallet and recorded transaction log.');

    console.log('\n🎉 All affiliate & referral engine integration tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Affiliate test failed:', error);
    process.exit(1);
  }
}

runTests();
