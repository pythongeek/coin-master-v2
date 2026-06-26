import Module from 'module';
import assert from 'assert';

// ============================================================================
// 0. Intercept modules before loading services
// ============================================================================
const originalRequire = Module.prototype.require;

// Global Mock Redis states
let useRedisLock = true;
const redisKeys: Record<string, string> = {};

// PostgreSQL lock simulator state
let isRowLocked = false;
const lockQueue: (() => void)[] = [];

function acquireRowLock(): Promise<void> {
  if (!isRowLocked) {
    isRowLocked = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    lockQueue.push(resolve);
  });
}

function releaseRowLock(): void {
  isRowLocked = false;
  if (lockQueue.length > 0) {
    isRowLocked = true;
    const nextResolve = lockQueue.shift();
    if (nextResolve) nextResolve();
  }
}

// Mock database state
const mockUsers = [
  { id: 'user-concurrency-1', username: 'player_concurrency', balance: '10.00000000', total_wagered: '0.00000000', pending_rakeback: '0.00000000', is_active: true }
];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized.startsWith('SELECT balance, total_wagered, pending_rakeback FROM users')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
    
    // Simulate FOR UPDATE blocking lock
    if (normalized.includes('FOR UPDATE')) {
      await acquireRowLock();
    }
    
    return { rows: user ? [user] : [] };
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

  if (normalized.startsWith('SELECT COUNT(*) as count FROM bets')) {
    return { rows: [{ count: '0' }] };
  }

  if (normalized.startsWith('INSERT INTO bets')) {
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO admin_settings') || normalized.startsWith('INSERT INTO transactions')) {
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT key, value FROM admin_settings')) {
    return { rows: [] }; // Falls back to default config
  }

  if (normalized.startsWith('SELECT id, url, secret FROM webhook_subscriptions')) {
    return { rows: [] }; // No webhook subscriptions for tests
  }

  return { rows: [] };
}

const mockClient = {
  query: async (text: string, params: any[] = []) => {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized === 'BEGIN') {
      return { rows: [] };
    }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      releaseRowLock();
      return { rows: [] };
    }
    return await mockQuery(text, params);
  },
  release: () => {}
};

const mockDb = {
  connect: async () => {
    return mockClient;
  },
  query: mockQuery
};

Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async set(key: string, val: string, mode?: string, duration?: number, flag?: string) {
        if (key.startsWith('bet_lock:')) {
          if (!useRedisLock) return 'OK'; // lock always succeeds when disabled
          if (redisKeys[key]) return null;
          redisKeys[key] = val;
          return 'OK';
        }
        redisKeys[key] = val;
        return 'OK';
      }
      async get(key: string) {
        return redisKeys[key] || null;
      }
      async del(key: string) {
        delete redisKeys[key];
        return 1;
      }
      async incr(key: string) { return 1; }
      async expire(key: string) { return 1; }
    };
  }
  if (id === '../config/database' || id === './database' || id.endsWith('config/database')) {
    return {
      db: mockDb,
      query: mockQuery
    };
  }
  if (id === 'bullmq') {
    return {
      Queue: class MockQueue {
        async add() { return { id: 'mock-job-id' }; }
      },
      Worker: class MockWorker {
        on() { return this; }
      }
    };
  }
  if (id === './reconciliation-engine' || id === '../services/reconciliation-engine' || id.endsWith('reconciliation-engine')) {
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
  if (id === './provably-fair' || id === '../services/provably-fair' || id.endsWith('provably-fair')) {
    return {
      generateServerSeed: () => 'mock-server-seed',
      hashServerSeed: () => 'mock-server-seed-hash',
      generateClientSeed: () => 'mock-client-seed',
      resolveFlip: (seeds: any, choice: any, amount: number, houseEdge: number, multiplier: number) => {
        return {
          won: false, // ALWAYS LOSS for deterministic balance reduction
          result: choice === 'heads' ? 'tails' : 'heads',
          payout: 0,
          winChance: 49.0,
          roll: 50.0,
          rawHash: 'mock-raw-hash'
        };
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};

// Now import the placeBet service under test
import { placeBet } from '../services/game-engine';

async function runTests() {
  console.log('🧪 Starting Concurrency and Double-Spend Protection Tests...');

  try {
    const userId = 'user-concurrency-1';

    // ============================================================================
    // Scenario 1: Redis Lock is enabled. Concurrent requests should fail fast.
    // ============================================================================
    console.log('\nScenario 1: Testing Redis bet locks with rapid concurrent requests...');
    useRedisLock = true;
    mockUsers[0].balance = '10.00000000'; // Reset balance
    delete redisKeys[`bet_lock:${userId}`]; // Reset lock

    // We trigger 3 concurrent bet calls
    const betPromises = [
      placeBet({ userId, choice: 'heads', amount: 3.0 }),
      placeBet({ userId, choice: 'heads', amount: 3.0 }),
      placeBet({ userId, choice: 'heads', amount: 3.0 })
    ];

    const results = await Promise.allSettled(betPromises);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    console.log(`Results: ${succeeded.length} succeeded, ${failed.length} failed.`);
    if (failed.length > 0) {
      console.log('Rejection reasons for failed promises:');
      failed.forEach((f, idx) => console.log(`  - Fail #${idx + 1}: ${(f as PromiseRejectedResult).reason}`));
    }
    
    // With Redis locking, only 1 request must succeed, other 2 must be blocked
    assert.strictEqual(succeeded.length, 1, 'Only exactly 1 concurrent request should succeed when Redis lock is active');
    assert.strictEqual(failed.length, 2, 'Other 2 requests should be blocked by Redis lock');
    
    const errorMsg = (failed[0] as PromiseRejectedResult).reason.message;
    assert.ok(errorMsg.includes('একটি গেম চলছে'), 'Error message should say a game is already in progress');

    console.log('✅ Scenario 1 (Redis Locks) verified successfully!');

    // ============================================================================
    // Scenario 2: Redis Lock is bypassed/disabled. PostgreSQL FOR UPDATE locking
    // must serialize transactions and prevent balance double-spend exploits.
    // ============================================================================
    console.log('\nScenario 2: Testing PostgreSQL FOR UPDATE row locking (Redis lock bypassed)...');
    useRedisLock = false; // Bypass Redis lock
    mockUsers[0].balance = '10.00000000'; // Reset balance to $10.00
    delete redisKeys[`bet_lock:${userId}`]; // Clear lock

    // We fire 4 concurrent bets of $3.00 each (total cost $12.00, which exceeds $10.00 balance)
    // If serialization is correct, 3 bets of $3.00 will succeed (costing $9.00), leaving balance $1.00.
    // The 4th bet will read $1.00 balance and reject as insufficient balance.
    // There must be NO double-spend causing balance to go negative.
    const betPromisesScenario2 = [
      placeBet({ userId, choice: 'heads', amount: 3.0 }),
      placeBet({ userId, choice: 'heads', amount: 3.0 }),
      placeBet({ userId, choice: 'heads', amount: 3.0 }),
      placeBet({ userId, choice: 'heads', amount: 3.0 })
    ];

    const results2 = await Promise.allSettled(betPromisesScenario2);

    const succeeded2 = results2.filter(r => r.status === 'fulfilled');
    const failed2 = results2.filter(r => r.status === 'rejected');

    console.log(`Results: ${succeeded2.length} succeeded, ${failed2.length} failed.`);
    if (failed2.length > 0) {
      console.log('Rejection reasons for failed promises:');
      failed2.forEach((f, idx) => console.log(`  - Fail #${idx + 1}: ${(f as PromiseRejectedResult).reason}`));
    }
    console.log(`Final user balance in state: $${mockUsers[0].balance}`);

    // Verify 3 bets succeeded, 1 failed
    assert.strictEqual(succeeded2.length, 3, 'Exactly 3 bets should succeed (costing $9.00)');
    assert.strictEqual(failed2.length, 1, 'Exactly 1 bet should fail due to insufficient balance ($1.00 left)');

    const failureReason = (failed2[0] as PromiseRejectedResult).reason.message;
    assert.ok(failureReason.includes('অপর্যাপ্ত ব্যালেন্স'), 'Failure reason should be insufficient balance');

    // Verify balance is exactly $1.00 (not negative or incorrect due to race condition)
    const finalBalance = parseFloat(mockUsers[0].balance);
    assert.strictEqual(finalBalance, 1.00, 'Final balance must be exactly $1.00');

    console.log('✅ Scenario 2 (DB row locks / double-spend protection) verified successfully!');

    console.log('\n🎉 All concurrency and double-spend protection tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Concurrency tests failed with error:', error);
    process.exit(1);
  }
}

runTests();
