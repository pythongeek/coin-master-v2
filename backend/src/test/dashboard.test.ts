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
  return originalRequire.apply(this, arguments as any);
};

// ============================================================================
// 1. Database Mocks
// ============================================================================
// Sequence of outcomes from newest to oldest:
// [W, W, W, L, L, W, L, L, L, L, L, W]
// Current Streak: +3 (3 wins)
// Max Win Streak: 3
// Max Loss Streak: 5
const mockBets = [
  { won: true, choice: 'heads', result: 'heads', amount: '10.00', payout: '19.60', created_at: new Date('2026-06-26T12:11:00Z') },
  { won: true, choice: 'heads', result: 'heads', amount: '10.00', payout: '19.60', created_at: new Date('2026-06-26T12:10:00Z') },
  { won: true, choice: 'heads', result: 'heads', amount: '10.00', payout: '19.60', created_at: new Date('2026-06-26T12:09:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:08:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:07:00Z') },
  { won: true, choice: 'heads', result: 'heads', amount: '10.00', payout: '19.60', created_at: new Date('2026-06-26T12:06:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:05:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:04:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:03:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:02:00Z') },
  { won: false, choice: 'tails', result: 'heads', amount: '10.00', payout: '0.00', created_at: new Date('2026-06-26T12:01:00Z') },
  { won: true, choice: 'heads', result: 'heads', amount: '10.00', payout: '19.60', created_at: new Date('2026-06-26T12:00:00Z') }
];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized.includes('SELECT COUNT(*) AS total_bets, COUNT(*) FILTER (WHERE won = true) AS total_wins, COUNT(*) FILTER (WHERE won = false) AS total_losses')) {
    return {
      rows: [{
        total_bets: '12',
        total_wins: '5',
        total_losses: '7',
        total_wagered: '120.00',
        net_pnl: '18.00',
        total_payout: '138.00',
        last_bet_at: new Date('2026-06-26T12:11:00Z'),
        biggest_win: '19.60'
      }]
    };
  }

  if (normalized.includes('SELECT balance FROM users WHERE id = $1')) {
    return { rows: [{ balance: '50.00' }] };
  }

  if (normalized.includes('SELECT won, choice, result, amount, payout, created_at FROM bets WHERE user_id = $1 AND status = \'resolved\'')) {
    return { rows: mockBets };
  }

  return { rows: [] };
}

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

// ============================================================================
// 2. Real Imports & Handlers Lookup
// ============================================================================
import router from '../routes/dashboard';

function createMockRequest(params: any = {}): Request {
  return {
    params,
    query: {},
    user: { userId: 'test-user-id', username: 'testuser', isAdmin: false }
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

function getRouteHandler(path: string, method: string): any {
  const route = router.stack.find((s: any) => s.route && s.route.path === path && s.route.methods[method]);
  if (!route) throw new Error(`Route not found for path: ${path}`);
  const handlers = (route as any).route.stack;
  return handlers[handlers.length - 1].handle;
}

// ============================================================================
// 3. Test Cases
// ============================================================================
async function runTests() {
  console.log('🧪 Starting User Stats, Hot/Cold Streaks, and Flips History Integration Tests...');

  try {
    const statsHandler = getRouteHandler('/stats/:userId', 'get');
    
    const req = createMockRequest({ userId: 'test-user-id' });
    const res = createMockResponse();
    const mockNext = () => {};

    // Execute stats route handler
    await statsHandler(req, res.res, mockNext);

    const status = res.getStatusCode();
    const body = res.getResponse();

    if (status !== 200) {
      throw new Error(`Expected status 200, got ${status}`);
    }

    if (!body.success || !body.data) {
      throw new Error(`Endpoint returned failed response: ${JSON.stringify(body)}`);
    }

    const data = body.data;

    // 1. Verify general stats
    if (data.balance === 50.00 && data.totalBets === 12 && data.totalWins === 5) {
      console.log('✅ Basic user stats and balances aggregated successfully.');
    } else {
      throw new Error(`Basic stats validation failed: ${JSON.stringify(data)}`);
    }

    // 2. Verify streaks calculation (current active, max win, max loss)
    const streaks = data.streaks;
    if (streaks.current === 3) {
      console.log('✅ Current active win streak computed correctly (+3 consecutive wins).');
    } else {
      throw new Error(`Current streak calculation error: expected +3, got ${streaks.current}`);
    }

    if (streaks.maxWin === 3) {
      console.log('✅ Maximum hot win streak computed correctly (3 consecutive wins).');
    } else {
      throw new Error(`Max win streak calculation error: expected 3, got ${streaks.maxWin}`);
    }

    if (streaks.maxLoss === 5) {
      console.log('✅ Maximum cold loss streak computed correctly (5 consecutive losses).');
    } else {
      throw new Error(`Max loss streak calculation error: expected 5, got ${streaks.maxLoss}`);
    }

    // 3. Verify flips history payload format & length
    const history = data.last100Flips;
    if (Array.isArray(history) && history.length === 12) {
      const first = history[0];
      if (
        first.won === true &&
        first.choice === 'heads' &&
        first.result === 'heads' &&
        first.amount === 10.00 &&
        first.payout === 19.60 &&
        first.createdAt
      ) {
        console.log('✅ Flips history schema array structured and returned correctly.');
      } else {
        throw new Error(`Flips history element mismatch: ${JSON.stringify(first)}`);
      }
    } else {
      throw new Error(`Expected flips history array of length 12, got ${history ? history.length : 'none'}`);
    }

    console.log('\n🎉 All user stats and streaks integration tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
