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
      reconcileUser: async (userId: string) => ({
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
import authRouter from '../routes/auth';
import { fraudGuard } from '../middleware/fraud-guard';
import adminRouter from '../routes/admin';

// ============================================================================
// 1. Mock DB State
// ============================================================================
const mockUsers = [
  {
    id: 'user-active-1',
    username: 'legit_player',
    email: 'legit@example.com',
    balance: '100.00',
    fingerprint: 'stable_fingerprint_hash_abc',
    registration_ip: '192.168.1.10',
    is_flagged: false,
    is_active: true
  },
  {
    id: 'user-flagged-2',
    username: 'abuser_player',
    email: 'abuser@example.com',
    balance: '10.00',
    fingerprint: 'stable_fingerprint_hash_abc', // Duplicate of user-active-1
    registration_ip: '192.168.1.10',
    is_flagged: true,
    is_active: true
  }
];

const mockFraudLogs: any[] = [
  {
    id: 'flag-log-1',
    user_id: 'user-flagged-2',
    type: 'multi_account_fingerprint',
    ip_address: '192.168.1.10',
    fingerprint: 'stable_fingerprint_hash_abc',
    details: 'আরেকটি অ্যাকাউন্টের সাথে ব্রাউজার ফিঙ্গারপ্রিন্ট মিলেছে: legit_player',
    created_at: new Date().toISOString(),
    username: 'abuser_player'
  }
];

// ============================================================================
// 2. Query Mock Interceptors
// ============================================================================
async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  // 2a. SELECT username checks
  if (normalized.includes('SELECT id FROM users WHERE username = $1')) {
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

  // 2b. SELECT duplicate fingerprint check
  if (normalized.includes('SELECT username FROM users WHERE fingerprint = $1 AND is_flagged = false')) {
    const fp = params[0];
    const match = mockUsers.find(u => u.fingerprint === fp && !u.is_flagged);
    return { rows: match ? [{ username: match.username }] : [] };
  }

  // 2c. SELECT IP duplicates count
  if (normalized.includes('SELECT count(*) FROM users WHERE registration_ip = $1')) {
    const ip = params[0];
    // Return 3 matches to simulate IP limit exceeded if checking IP 192.168.1.100
    if (ip === '192.168.1.100') {
      return { rows: [{ count: '3' }] };
    }
    return { rows: [{ count: '0' }] };
  }

  // 2d. SELECT is_flagged status check in fraudGuard
  if (normalized.includes('SELECT is_flagged FROM users WHERE id = $1')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
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

  // 2e. INSERT new user
  if (normalized.startsWith('INSERT INTO users')) {
    // Determine shouldFlag from params
    const id = params[0];
    const username = params[1];
    const fingerprint = params[6];
    const regIp = params[7];
    const isFlagged = params[8]; // $9 is is_flagged

    mockUsers.push({
      id,
      username,
      email: null as any,
      balance: '10.00',
      fingerprint,
      registration_ip: regIp,
      is_flagged: !!isFlagged,
      is_active: true
    });
    return { rows: [] };
  }

  // 2f. INSERT fraud log
  if (normalized.startsWith('INSERT INTO fraud_logs')) {
    mockFraudLogs.push({
      id: 'generated-id',
      user_id: params[0],
      type: params[1],
      ip_address: params[2],
      fingerprint: params[3],
      details: params[4],
      created_at: new Date().toISOString(),
      username: 'temp'
    });
    return { rows: [] };
  }

  // 2g. GET fraud logs list (admin route)
  if (normalized.includes('SELECT fl.id, fl.user_id, fl.type, fl.ip_address, fl.fingerprint, fl.details, fl.created_at, u.username FROM fraud_logs fl')) {
    return { rows: mockFraudLogs };
  }

  if (normalized.includes('SELECT COUNT(*) as total FROM fraud_logs')) {
    return { rows: [{ total: String(mockFraudLogs.length) }] };
  }

  // 2h. UPDATE unflag user
  if (normalized.includes('UPDATE users SET is_flagged = false WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    if (user) {
      user.is_flagged = false;
    }
    return { rows: [] };
  }

  // 2i. DELETE fraud logs for unflagged user
  if (normalized.includes('DELETE FROM fraud_logs WHERE user_id = $1')) {
    const id = params[0];
    const index = mockFraudLogs.findIndex(f => f.user_id === id);
    if (index !== -1) {
      mockFraudLogs.splice(index, 1);
    }
    return { rows: [] };
  }

  return { rows: [] };
}

// Override database queries
db.query = mockQuery as any;
(global as any).__TEST_MOCK_QUERY__ = mockQuery;
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
  console.log('🧪 Starting Active Fraud Detection Services Integration Tests...');

  try {
    const registerHandler = getRouteHandler(authRouter, '/register', 'post');
    const fraudLogsAdminHandler = getRouteHandler(adminRouter, '/fraud-logs', 'get');
    const unflagAdminHandler = getRouteHandler(adminRouter, '/users/:id/unflag', 'post');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Duplicate Fingerprint Flagging
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing duplicate browser fingerprint registration...');

    const req1 = {
      body: {
        username: 'duplicate_fp_abuser',
        password: 'secure_password_123',
        fingerprint: 'stable_fingerprint_hash_abc' // Matches user-active-1
      },
      headers: {}
    } as unknown as Request;
    let code1 = 200;
    let resp1: any = null;
    const res1 = {
      status(code: number) { code1 = code; return this; },
      json(data: any) { resp1 = data; return this; }
    } as unknown as Response;

    await registerHandler(req1, res1);

    if (code1 !== 201 || !resp1.success || !resp1.user.isFlagged) {
      throw new Error(`Expected successful registration with isFlagged = true, got: ${code1}: ${JSON.stringify(resp1)}`);
    }

    const createdUser = mockUsers.find(u => u.username === 'duplicate_fp_abuser');
    if (!createdUser || !createdUser.is_flagged) {
      throw new Error(`User was not flagged in database: ${JSON.stringify(createdUser)}`);
    }

    const fraudLog = mockFraudLogs.find(f => f.user_id === createdUser.id && f.type === 'multi_account_fingerprint');
    if (!fraudLog) {
      throw new Error(`Duplicate fingerprint fraud log not created: ${JSON.stringify(mockFraudLogs)}`);
    }
    console.log('✅ Duplicate browser fingerprint successfully detected, user flagged, and fraud log recorded.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Registration IP Limits Exceeded
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing registration IP limits (count >= 3)...');

    const req2 = {
      body: {
        username: 'ip_abuser_player',
        password: 'secure_password_123',
        fingerprint: 'different_fingerprint'
      },
      headers: {
        'x-forwarded-for': '192.168.1.100' // Simulates IP that exceeds threshold
      }
    } as unknown as Request;
    let code2 = 200;
    let resp2: any = null;
    const res2 = {
      status(code: number) { code2 = code; return this; },
      json(data: any) { resp2 = data; return this; }
    } as unknown as Response;

    await registerHandler(req2, res2);

    if (code2 !== 201 || !resp2.success || !resp2.user.isFlagged) {
      throw new Error(`Expected registration with isFlagged = true due to IP limits, got: ${code2}: ${JSON.stringify(resp2)}`);
    }

    const ipUser = mockUsers.find(u => u.username === 'ip_abuser_player');
    if (!ipUser || !ipUser.is_flagged) {
      throw new Error(`User was not flagged in database for IP limits: ${JSON.stringify(ipUser)}`);
    }

    const ipFraudLog = mockFraudLogs.find(f => f.user_id === ipUser.id && f.type === 'multi_account_ip');
    if (!ipFraudLog) {
      throw new Error(`IP limits fraud log not created: ${JSON.stringify(mockFraudLogs)}`);
    }
    console.log('✅ Registration IP limits successfully enforced, user flagged, and fraud log recorded.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Fraud Guard Middleware Route Block
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing fraudGuard middleware restrictions on flagged user...');

    // 3a. Test with flagged user (user-flagged-2)
    const reqGuardFlagged = {
      user: { userId: 'user-flagged-2' }
    } as any;
    let guardCodeFlagged = 200;
    let guardRespFlagged: any = null;
    const resGuardFlagged = {
      status(code: number) { guardCodeFlagged = code; return this; },
      json(data: any) { guardRespFlagged = data; return this; }
    } as any;

    await fraudGuard(reqGuardFlagged, resGuardFlagged, () => {
      throw new Error('fraudGuard next() was incorrectly called for flagged user');
    });

    if (guardCodeFlagged !== 403 || guardRespFlagged.success !== false) {
      throw new Error(`Expected 403 block for flagged user, got: ${guardCodeFlagged}: ${JSON.stringify(guardRespFlagged)}`);
    }
    console.log('✅ Flagged user successfully blocked with 403.');

    // 3b. Test with active user (user-active-1)
    const reqGuardActive = {
      user: { userId: 'user-active-1' }
    } as any;
    let guardNextCalled = false;
    await fraudGuard(reqGuardActive, {} as any, () => {
      guardNextCalled = true;
    });

    if (!guardNextCalled) {
      throw new Error('Expected next() to be called for active unflagged user');
    }
    console.log('✅ Active user successfully permitted to proceed.');

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 4: Admin Controls (Audit logs & Unflagging)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 4: Testing admin logs inspection and manual user unflagging...');

    // 4a. Verify GET /admin/fraud-logs
    const reqAdminLogs = { query: {} } as any;
    let adminLogsResp: any = null;
    await fraudLogsAdminHandler(reqAdminLogs, {
      json(data: any) { adminLogsResp = data; }
    } as any);

    if (!adminLogsResp || !adminLogsResp.success || adminLogsResp.logs.length === 0) {
      throw new Error(`Expected fraud logs list, got: ${JSON.stringify(adminLogsResp)}`);
    }
    console.log('✅ Admin successfully fetched list of all flagged accounts fraud logs.');

    // 4b. Verify unflag endpoint (POST /admin/users/:id/unflag)
    const flaggedUserObj = mockUsers.find(u => u.id === 'user-flagged-2');
    if (!flaggedUserObj || !flaggedUserObj.is_flagged) {
      throw new Error('Pre-test check failed: user-flagged-2 must be flagged');
    }

    const reqUnflag = { params: { id: 'user-flagged-2' } } as any;
    let unflagResp: any = null;
    await unflagAdminHandler(reqUnflag, {
      json(data: any) { unflagResp = data; }
    } as any);

    if (!unflagResp || !unflagResp.success) {
      throw new Error(`Expected successful unflag action, got: ${JSON.stringify(unflagResp)}`);
    }

    if (flaggedUserObj.is_flagged) {
      throw new Error('Expected user-flagged-2 to be unflagged in database');
    }

    const remainingFraudLogs = mockFraudLogs.filter(f => f.user_id === 'user-flagged-2');
    if (remainingFraudLogs.length > 0) {
      throw new Error('Expected associated fraud logs to be deleted on unflag');
    }
    console.log('✅ Admin successfully unflagged account, restored status, and cleared logs.');

    console.log('\n🎉 All active fraud detection services tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Fraud test failed:', error);
    process.exit(1);
  }
}

runTests();
