import crypto from 'crypto';
import Module from 'module';

// ==========================================================
// 1. Mock modules before importing game-engine service
// ==========================================================
const originalProvablyFair = require('../services/provably-fair');
let mockOutcomeResult: 'heads' | 'tails' = 'heads';

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'bullmq') {
    return {
      Queue: class MockQueue {},
      Worker: class MockWorker {}
    };
  }
  if (id === './provably-fair' || id === '../services/provably-fair') {
    return {
      ...originalProvablyFair,
      resolveFlip: (seeds: any, choice: any, betAmount: any, houseEdge: any) => {
        const won = choice === mockOutcomeResult;
        const payout = won ? betAmount * (2 - (houseEdge / 100) * 2) : 0;
        return {
          result: mockOutcomeResult,
          rawHash: 'mock-hash',
          rawValue: mockOutcomeResult === 'heads' ? 0 : 1,
          serverSeedHash: seeds.serverSeedHash,
          payout,
          houseEdge
        };
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};

// ==========================================================
// 2. Database and local mocks setup
// ==========================================================
const mockUsers: any[] = [];
const mockBets: any[] = [];
const mockSettings: any[] = [];

// Seed default settings
mockSettings.push({ key: 'house_edge_percent', value: '2.00' });
mockSettings.push({ key: 'max_bet_amount', value: '100000.00' }); // allow large bets for testing limit
mockSettings.push({ key: 'min_bet_amount', value: '0.01' });
mockSettings.push({ key: 'max_win_amount', value: '50000.00' });

let mockQueryInterceptor: ((text: string, params: any[]) => Promise<any> | void) | null = null;
let snapshotUsers: string | null = null;
let snapshotBets: string | null = null;

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  if (mockQueryInterceptor) {
    const res = await mockQueryInterceptor(text, params);
    if (res !== undefined) return res;
  }

  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized === 'BEGIN') {
    snapshotUsers = JSON.stringify(mockUsers);
    snapshotBets = JSON.stringify(mockBets);
    return { rows: [] };
  }

  if (normalized === 'COMMIT') {
    snapshotUsers = null;
    snapshotBets = null;
    return { rows: [] };
  }

  if (normalized === 'ROLLBACK') {
    if (snapshotUsers !== null && snapshotBets !== null) {
      mockUsers.length = 0;
      mockUsers.push(...JSON.parse(snapshotUsers));
      mockBets.length = 0;
      mockBets.push(...JSON.parse(snapshotBets));
    }
    snapshotUsers = null;
    snapshotBets = null;
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT key, value FROM admin_settings')) {
    return { rows: mockSettings };
  }

  if (normalized.startsWith('SELECT balance FROM users WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [user] : [] };
  }

  if (normalized.startsWith('SELECT COUNT(*) as count FROM bets WHERE user_id = $1')) {
    const id = params[0];
    const count = mockBets.filter(b => b.user_id === id).length;
    return { rows: [{ count }] };
  }

  if (normalized.startsWith('UPDATE users SET balance = $1')) {
    const balance = Number(params[0]);
    const id = params[1];
    const user = mockUsers.find(u => u.id === id);
    if (user) {
      user.balance = balance;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO bets')) {
    const id = params[0];
    const user_id = params[1];
    const choice = params[2];
    const amount = Number(params[3]);
    const result = params[4];
    const won = params[5];
    const payout = Number(params[6]);
    const house_edge = Number(params[7]);
    const flip_hash = params[8];
    const bet = { id, user_id, choice, amount, result, won, payout, house_edge, flip_hash, created_at: new Date() };
    mockBets.push(bet);
    return { rows: [] };
  }

  return { rows: [] };
}

// Intercept DB module exports
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

// Mock Redis module exports
import * as redisModule from '../config/redis';
const mockRedis = {
  lockBet: async (userId: string, amount: number) => true,
  unlockBet: async (userId: string) => {},
  incrementWinStreak: async (userId: string) => 1,
  resetWinStreak: async (userId: string) => {},
};
(redisModule as any).lockBet = mockRedis.lockBet;
(redisModule as any).unlockBet = mockRedis.unlockBet;
(redisModule as any).incrementWinStreak = mockRedis.incrementWinStreak;
(redisModule as any).resetWinStreak = mockRedis.resetWinStreak;

// Import placeBet service after mocks are injected
import { placeBet } from '../services/game-engine';

async function runTests() {
  console.log('🧪 Starting Game Bet & Bankroll Limits Tests...');

  const userId = '33333333-4444-5555-6666-777777777777';

  // Seed user
  mockUsers.push({
    id: userId,
    balance: 100000.00,
    is_active: true
  });

  try {
    // 1. Test normal bet placement (wager 10 USDT)
    console.log('\nScenario 1: Testing normal bet placement...');
    mockOutcomeResult = 'heads'; // force heads so choice: 'heads' wins
    const bet1 = await placeBet({
      userId,
      choice: 'heads',
      amount: 10.00
    });
    console.log(`Bet completed. Won: ${bet1.won}, Payout: ${bet1.payout}, New Balance: ${bet1.newBalance}`);
    
    // Verify user balance matches calculation (won payout = 10 * 1.96 = 19.6, net change = +9.6)
    const user = mockUsers.find(u => u.id === userId);
    const expectedBalance = 100000.00 - 10.00 + 19.60;
    if (Math.abs(user.balance - expectedBalance) < 0.0001) {
      console.log('✅ Balance correctly updated in database.');
    } else {
      throw new Error(`Balance mismatch: expected ${expectedBalance}, got ${user.balance}`);
    }

    // Restore user balance
    user.balance = 100000.00;

    // 2. Test Max Win Cap rejection (wager 30,000 USDT)
    // 30,000 USDT at 2% house edge has a potential payout of 30,000 * 1.96 = 58,800 USDT which exceeds 50,000 USDT limit
    console.log('\nScenario 2: Testing Max Win Cap rejection...');
    try {
      await placeBet({
        userId,
        choice: 'heads',
        amount: 30000.00
      });
      throw new Error('Expected bet to be rejected due to max win cap, but it was processed');
    } catch (err: any) {
      if (err.message.includes('জয়ের সীমা')) {
        console.log('✅ Max Win Cap check verified: blocked bet exceeding potential payout limit.');
      } else {
        throw err;
      }
    }

    // Verify balance remains untouched
    if (user.balance === 100000.00) {
      console.log('✅ Balance remains unchanged after rejection.');
    } else {
      throw new Error(`Balance was modified after rejected bet: ${user.balance}`);
    }

    // 3. Test House Edge config changes and multiplier calculation
    console.log('\nScenario 3: Testing House Edge margin adjustment...');
    
    // Update settings: change house edge to 5%
    const edgeSetting = mockSettings.find(s => s.key === 'house_edge_percent');
    edgeSetting.value = '5.00';

    // Place bet with 1000.00, choice: 'heads'
    // Force outcome to heads so it wins
    mockOutcomeResult = 'heads';

    const bet2 = await placeBet({
      userId,
      choice: 'heads',
      amount: 1000.00
    });
    
    console.log(`Edge 5.0% - Wager: 1000.00, Won: ${bet2.won}, Result Payout: ${bet2.payout}`);
    
    // Potential payout at 5% edge: 1000 * 1.90 = 1900
    if (bet2.payout === 1900.00) {
      console.log('✅ House edge multiplier verified correctly as 1.90x.');
    } else {
      throw new Error(`Expected payout 1900.00, got: ${bet2.payout}`);
    }

    // Restore settings
    edgeSetting.value = '2.00';
    user.balance = 100000.00;

    // 4. Test Transaction rollback on DB fail
    console.log('\nScenario 4: Testing Transaction Rollback on DB error...');
    
    // Setup interceptor to throw on inserting bets (after balance was updated)
    mockQueryInterceptor = async (text: string, params: any[]) => {
      if (text.includes('INSERT INTO bets')) {
        throw new Error('Simulated database crash during bet insertion');
      }
      return undefined;
    };

    try {
      await placeBet({
        userId,
        choice: 'tails',
        amount: 10.00
      });
      throw new Error('Expected transaction to fail, but it succeeded');
    } catch (err: any) {
      if (err.message.includes('Simulated database crash')) {
        console.log('✅ Game engine correctly threw simulated insert error.');
      } else {
        throw err;
      }
    }

    // Verify rollback: balance should still be 100000.00
    const finalUser = mockUsers.find(u => u.id === userId);
    if (finalUser && finalUser.balance === 100000.00) {
      console.log('✅ Transaction Rollback verified: User balance remains unchanged.');
    } else {
      throw new Error(`Balance was updated despite transaction failure: ${finalUser ? finalUser.balance : 'undefined'}`);
    }

    // Reset interceptor
    mockQueryInterceptor = null;

    console.log('\n🎉 All game bet & bankroll limits tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
