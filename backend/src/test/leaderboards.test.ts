import Module from 'module';
import { Request, Response } from 'express';

// ============================================================================
// 0. Intercept ioredis before anything else is loaded
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
// 1. Mock DB and Users/Bets State
// ============================================================================
const mockUsers = [
  { id: 'user-id-1', username: 'player_one', balance: '100.00', total_wagered: '500.00', pending_rakeback: '2.50', is_active: true },
  { id: 'user-id-2', username: 'player_two', balance: '500.00', total_wagered: '2500.00', pending_rakeback: '0.00', is_active: true }
];

const mockBets = [
  { id: 'bet-1', user_id: 'user-id-1', amount: '100.00', won: true, status: 'resolved', created_at: new Date() },
  { id: 'bet-2', user_id: 'user-id-2', amount: '500.00', won: false, status: 'resolved', created_at: new Date() }
];

const mockTransactions: any[] = [];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  // 1. users SELECT query
  if (normalized.includes('FROM users') && normalized.includes('balance')) {
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

  // 1b. count bets query
  if (normalized.includes('SELECT COUNT(*) as count FROM bets')) {
    return { rows: [{ count: '2' }] };
  }

  // 2. users UPDATE query (claim / place bet)
  if (normalized.startsWith('UPDATE users SET balance = $1, pending_rakeback = 0.00000000')) {
    const balance = params[0];
    const userId = params[1];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.balance = String(balance);
      user.pending_rakeback = '0.00000000';
    }
    return { rows: [] };
  }

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

  // 3. Transactions INSERT
  if (normalized.startsWith('INSERT INTO transactions')) {
    mockTransactions.push({
      id: params[0],
      user_id: params[1],
      type: 'rakeback',
      amount: params[2],
      status: 'completed',
      metadata: '{}',
      ip_address: params[3],
      user_agent: params[4]
    });
    return { rows: [] };
  }

  // 4. Leaderboards query - Daily
  if (normalized.includes("INTERVAL '24 hours'")) {
    return {
      rows: [
        { user_id: 'user-id-2', username: 'player_two', volume: '500.00', bet_count: '1' },
        { user_id: 'user-id-1', username: 'player_one', volume: '100.00', bet_count: '1' }
      ]
    };
  }

  // 5. Leaderboards query - Weekly
  if (normalized.includes("INTERVAL '7 days'")) {
    return {
      rows: [
        { user_id: 'user-id-2', username: 'player_two', volume: '500.00', bet_count: '1' },
        { user_id: 'user-id-1', username: 'player_one', volume: '100.00', bet_count: '1' }
      ]
    };
  }

  // 6. set_config settings
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
  (global as any).__TEST_MOCK_QUERY__ = mockQuery;

// Mock admin-config helper
import * as adminConfigModule from '../services/admin-config';
(adminConfigModule as any).getConfig = async () => ({
  houseEdgePercent: 2.0,
  minBetAmount: 0.1,
  maxBetAmount: 1000,
  rainEnabled: true,
  squadEnabled: true,
  coinSpinDurationMs: 1000,
  maintenanceMode: false,
  maintenanceMessage: '',
  bankrollSolanaAddress: '',
  minWithdrawalAmount: 1.0,
  maxWithdrawalAmount: 1000.0,
  withdrawalFeePercent: 1.0
});

// Import target routers
import leaderboardsRouter from '../routes/leaderboards';
import walletRouter from '../routes/wallet';
import { placeBet } from '../services/game-engine';

// ============================================================================
// 2. Helpers
// ============================================================================
function createMockRequest(user: any, body: any = {}, ip = '127.0.0.1', userAgent = 'TestAgent'): Request {
  return {
    body,
    ip,
    headers: { 'user-agent': userAgent },
    user
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
  console.log('🧪 Starting Leaderboards and VIP Rakeback Engine integration tests...\n');

  try {
    // -------------------------------------------------------------
    // Test 1: GET /api/game/leaderboards
    // -------------------------------------------------------------
    console.log('1. Testing GET /api/game/leaderboards...');
    const leaderboardHandler = getRouteHandler(leaderboardsRouter, '/', 'get');
    const req1 = createMockRequest(null);
    const res1 = createMockResponse();

    await leaderboardHandler(req1, res1.res);

    if (res1.getStatusCode() !== 200) {
      throw new Error(`Expected status 200 for leaderboards, got ${res1.getStatusCode()}`);
    }

    const lbData = res1.getResponse();
    if (!lbData.success || !lbData.data || !lbData.data.daily || !lbData.data.weekly) {
      throw new Error(`Invalid response structure: ${JSON.stringify(lbData)}`);
    }

    if (lbData.data.daily.length !== 2 || lbData.data.daily[0].username !== 'player_two' || lbData.data.daily[0].volume !== 500) {
      throw new Error(`Daily leaderboard values mismatch: ${JSON.stringify(lbData.data.daily)}`);
    }
    console.log('✅ Leaderboards endpoint verified (returns daily & weekly top wager volumes).');

    // -------------------------------------------------------------
    // Test 2: POST /api/wallet/rakeback/claim
    // -------------------------------------------------------------
    console.log('\n2. Testing POST /api/wallet/rakeback/claim...');
    const claimHandler = getRouteHandler(walletRouter, '/rakeback/claim', 'post');
    const userPayload = { userId: 'user-id-1', username: 'player_one', isAdmin: false };
    const req2 = createMockRequest(userPayload);
    const res2 = createMockResponse();

    const oldBalance = parseFloat(mockUsers[0].balance);
    const expectedRakeback = parseFloat(mockUsers[0].pending_rakeback);

    await claimHandler(req2, res2.res);

    if (res2.getStatusCode() !== 200) {
      throw new Error(`Expected status 200 for rakeback claim, got ${res2.getStatusCode()}`);
    }

    const claimResponse = res2.getResponse();
    if (!claimResponse.success || claimResponse.amount !== expectedRakeback) {
      throw new Error(`Unexpected claim response: ${JSON.stringify(claimResponse)}`);
    }

    const updatedUser = mockUsers.find(u => u.id === 'user-id-1')!;
    if (parseFloat(updatedUser.balance) !== oldBalance + expectedRakeback || parseFloat(updatedUser.pending_rakeback) !== 0) {
      throw new Error(`User balance/rakeback not updated: ${JSON.stringify(updatedUser)}`);
    }

    const claimTx = mockTransactions.find(t => t.user_id === 'user-id-1' && t.type === 'rakeback');
    if (!claimTx || parseFloat(claimTx.amount) !== expectedRakeback || claimTx.status !== 'completed') {
      throw new Error(`Rakeback claim transaction record missing or invalid: ${JSON.stringify(mockTransactions)}`);
    }
    console.log('✅ Rakeback manual claim endpoint verified (correctly credited user balance and updated history logs).');

    // -------------------------------------------------------------
    // Test 3: placeBet updates total_wagered and pending_rakeback correctly based on VIP tier
    // -------------------------------------------------------------
    console.log('\n3. Testing placeBet for VIP rakeback computations...');
    
    // User is "player_two" who has: balance = 500, total_wagered = 2500 (Silver: $1,001 - $10,000, 10% of house edge)
    // House edge is 2.0%. Rakeback percent = 10%
    // A bet of $100:
    //   - total_wagered becomes 2500 + 100 = 2600.
    //   - rakeback rate is 10% (0.10) because total_wagered is <= 10000.
    //   - rakeback generated is 100 * (2.0 / 100) * 0.10 = 0.20
    //   - pending_rakeback becomes 0.00 + 0.20 = 0.20
    const betResult = await placeBet({
      userId: 'user-id-2',
      choice: 'heads',
      amount: 100,
      clientSeed: 'some-client-seed',
      targetMultiplier: 2.0
    });

    const userTwo = mockUsers.find(u => u.id === 'user-id-2')!;
    if (parseFloat(userTwo.total_wagered) !== 2600) {
      throw new Error(`Expected user total_wagered to be 2600, got ${userTwo.total_wagered}`);
    }

    if (parseFloat(userTwo.pending_rakeback) !== 0.20) {
      throw new Error(`Expected pending_rakeback to be 0.20 (Silver tier 10% of 2% house edge of $100 bet), got ${userTwo.pending_rakeback}`);
    }
    console.log('✅ placeBet updates total_wagered and pending_rakeback correctly (escalated dynamically based on Silver VIP tier).');

    console.log('\n🎉 All leaderboards and VIP rakeback engine integration tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test suite failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
