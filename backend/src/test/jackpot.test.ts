import Module from 'module';
import { Request, Response } from 'express';

// ============================================================================
// 0. Intercept ioredis & reconciliation before anything else is loaded
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

// ============================================================================
// 1. Mock DB State
// ============================================================================
const mockUsers = [
  { id: 'user-id-1', username: 'player_one', balance: '1000.00', total_wagered: '0.00', pending_rakeback: '0.00', is_active: true }
];

let mockAdminSettings: Record<string, string> = {
  jackpot_enabled: 'true',
  jackpot_min_bet: '1.00',
  jackpot_contribution_percent: '1.00',
  jackpot_hit_chance: '10000',
  jackpot_start_pool: '10.00',
  jackpot_pool: '10.00',
  house_edge_percent: '2.00',
  min_bet_amount: '0.01',
  max_bet_amount: '1000.00',
  max_win_amount: '50000.00',
  max_concurrent_bets: '1',
  rain_trigger_streak: '5',
  rain_budget_daily: '50.00',
  rain_claim_per_user: '0.10',
  max_squad_size: '5'
};

const mockTransactions: any[] = [];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  // users SELECT query
  if (normalized.includes('FROM users') && normalized.includes('balance')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
    if (!user) return { rows: [] };
    // Auto-fill withdrawable_balance_coins if not set, for tests using the
    // single-balance model. Mirrors the DB trigger that keeps
    // users.balance = bonus_balance_coins + withdrawable_balance_coins.
    if ((user as any).withdrawable_balance_coins === undefined) {
      (user as any).withdrawable_balance_coins = String((user as any).balance);
    }
    if ((user as any).bonus_balance_coins === undefined) {
      (user as any).bonus_balance_coins = '0';
    }
    return { rows: [user] };
  }

  // users UPDATE query (new dual-balance pattern)
  if (normalized.includes('UPDATE users SET') && normalized.includes('withdrawable_balance_coins')) {
    const userId = params[params.length - 1];
    const user = mockUsers.find(u => u.id === userId);
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

  // users UPDATE query (legacy single-balance pattern)
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

  // admin_settings SELECT query
  if (normalized.startsWith('SELECT key, value FROM admin_settings')) {
    const rows = Object.entries(mockAdminSettings).map(([key, value]) => ({ key, value }));
    return { rows };
  }

  // admin_settings UPDATE query (via INSERT ON CONFLICT)
  if (normalized.startsWith('INSERT INTO admin_settings')) {
    let key = params[0];
    let value = params[1];
    if (normalized.includes("'jackpot_pool'")) {
      key = 'jackpot_pool';
      value = params[0];
    }
    mockAdminSettings[key] = String(value);
    return { rows: [] };
  }

  // transactions INSERT
  if (normalized.startsWith('INSERT INTO transactions')) {
    mockTransactions.push({
      id: params[0],
      user_id: params[1],
      type: params[2] || 'jackpot',
      amount: params[3],
      status: params[4]
    });
    return { rows: [] };
  }

  // count bets query
  if (normalized.includes('SELECT COUNT(*) as count FROM bets')) {
    return { rows: [{ count: '5' }] };
  }

  // set_config settings
  if (normalized.includes('set_config(')) {
    return { rows: [] };
  }

  // Fallback
  return { rows: [] };
}

// Override DB module
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

// Import target routers
import gameRouter from '../routes/game';
import { placeBet } from '../services/game-engine';

// ============================================================================
// 2. Helpers
// ============================================================================
function createMockRequest(body: any = {}): Request {
  return {
    body,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'TestAgent' }
  } as unknown as Request;
}

function createMockResponse() {
  let statusCode = 200;
  let jsonResponse: any = null;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      jsonResponse = data;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    getStatusCode: () => statusCode,
    getResponse: () => jsonResponse,
  };
}

function getRouteHandler(router: any, path: string, method: string): any {
  const route = router.stack.find((s: any) => s.route && s.route.path === path && s.route.methods[method]);
  if (!route) throw new Error(`Route not found for path: ${path}`);
  const handlers = (route as any).route.stack;
  return handlers[handlers.length - 1].handle;
}

// ============================================================================
// 3. Test runner
// ============================================================================
async function runTests() {
  console.log('🧪 Starting Progressive Jackpot and Public Verifier integration tests...\n');

  try {
    // -------------------------------------------------------------
    // Test 1: GET /api/game/jackpot
    // -------------------------------------------------------------
    console.log('1. Testing GET /api/game/jackpot...');
    const jackpotHandler = getRouteHandler(gameRouter, '/jackpot', 'get');
    const req1 = createMockRequest();
    const res1 = createMockResponse();

    await jackpotHandler(req1, res1.res);

    if (res1.getStatusCode() !== 200) {
      throw new Error(`Expected status 200, got ${res1.getStatusCode()}`);
    }

    const data1 = res1.getResponse();
    if (!data1.success || data1.data.jackpotPool !== 10.0 || !data1.data.jackpotEnabled) {
      throw new Error(`Invalid jackpot response data: ${JSON.stringify(data1)}`);
    }
    console.log('✅ GET /api/game/jackpot verified (returns correct current pool balance).');

    // -------------------------------------------------------------
    // Test 2: Bet placement adds contribution to jackpot pool
    // -------------------------------------------------------------
    console.log('\n2. Testing jackpot accumulation on bet placement...');
    
    // User places a $100 bet.
    // jackpotContributionPercent = 1.0% -> $1.00 should be added to pool.
    // jackpotMinBet = $1.00, so $100 bet qualifies.
    // Expect pool to grow from $10.00 to $11.00 (unless it hits the jackpot).
    // Let's call placeBet.
    const betResult = await placeBet({
      userId: 'user-id-1',
      choice: 'heads',
      amount: 100,
      clientSeed: 'test-client-seed',
      targetMultiplier: 2.0
    });

    if (betResult.jackpotWon) {
      console.log(`🏆 Jackpot hit during test! Won: $${betResult.jackpotAmount}`);
      if (parseFloat(mockAdminSettings.jackpot_pool) !== 10.0) {
        throw new Error(`Expected jackpot pool to reset to $10.00 on win, got ${mockAdminSettings.jackpot_pool}`);
      }
    } else {
      console.log(`Pool accumulated successfully. Current pool: $${mockAdminSettings.jackpot_pool}`);
      if (parseFloat(mockAdminSettings.jackpot_pool) !== 11.0) {
        throw new Error(`Expected jackpot pool to be 11.00, got ${mockAdminSettings.jackpot_pool}`);
      }
    }
    console.log('✅ Jackpot contribution accumulation verified.');

    // -------------------------------------------------------------
    // Test 3: Bets below jackpotMinBet do not accumulate jackpot
    // -------------------------------------------------------------
    console.log('\n3. Testing low wagers are excluded from jackpot...');
    
    // jackpotMinBet is 1.00. Let's make a bet of 0.50.
    // Pool should remain the same.
    const prePool = parseFloat(mockAdminSettings.jackpot_pool);
    await placeBet({
      userId: 'user-id-1',
      choice: 'heads',
      amount: 0.50,
      clientSeed: 'test-client-seed-2',
      targetMultiplier: 2.0
    });

    const postPool = parseFloat(mockAdminSettings.jackpot_pool);
    if (prePool !== postPool) {
      throw new Error(`Expected pool to stay at ${prePool}, but it changed to ${postPool}`);
    }
    console.log('✅ Verified wagers below minimum are excluded from jackpot.');

    // -------------------------------------------------------------
    // Test 4: Jackpot provably fair trigger verification (POST /verify)
    // -------------------------------------------------------------
    console.log('\n4. Testing provably fair verify route with jackpot verification details...');
    const verifyHandler = getRouteHandler(gameRouter, '/verify', 'post');
    const reqVerify = createMockRequest({
      serverSeed: 'my-super-secret-server-seed',
      clientSeed: 'my-cool-client-seed',
      nonce: '5',
      serverSeedHash: '75a1334c9735d496a7dfbc3c69018442fae910408544d67389a9c84fd09b533a', // sha256 hash of serverSeed
      choice: 'heads',
      targetMultiplier: 2.0,
      houseEdge: 2.0,
      jackpotHitChance: 10000
    });
    const resVerify = createMockResponse();

    await verifyHandler(reqVerify, resVerify.res);

    if (resVerify.getStatusCode() !== 200) {
      throw new Error(`Expected verify endpoint status 200, got ${resVerify.getStatusCode()}`);
    }

    const verifyData = resVerify.getResponse();
    if (!verifyData.success || !verifyData.data.jackpot || verifyData.data.jackpot.roll === undefined) {
      throw new Error(`Verifier response does not contain jackpot calculations: ${JSON.stringify(verifyData)}`);
    }

    console.log(`Verify roll output: ${JSON.stringify(verifyData.data.jackpot)}`);
    if (verifyData.data.jackpot.signature !== 'my-cool-client-seed:5:jackpot') {
      throw new Error(`Jackpot verification signature incorrect: ${verifyData.data.jackpot.signature}`);
    }
    console.log('✅ Standalone public verify endpoint successfully computes provably fair jackpot values.');

    console.log('\n🎉 All progressive jackpot and public verifier tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test suite failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
