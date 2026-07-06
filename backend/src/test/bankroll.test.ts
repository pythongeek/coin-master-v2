/**
 * Game Bet & Bankroll Limits Tests
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/bankroll.test.ts
 *
 * The setup file installs mocks at the Module.prototype.require level so
 * that downstream requires (db, redis, server-seed, provably-fair, ...)
 * pick up the in-memory implementations.
 */

// The setup file has already installed the mocks via --require.
// Pull in the shared mock state for assertions.
import {
  resetAllMocks,
  MOCK_USERS,
  MOCK_SETTINGS,
  MOCK_BETS,
  setQueryInterceptor,
} from './helpers/test-mocks';

resetAllMocks();

// Seed default settings
MOCK_SETTINGS.push({ key: 'house_edge_percent', value: '2.00' });
MOCK_SETTINGS.push({ key: 'max_bet_amount', value: '100000.00' });
MOCK_SETTINGS.push({ key: 'min_bet_amount', value: '0.01' });
MOCK_SETTINGS.push({ key: 'max_win_amount', value: '50000.00' });

// Require (not import) so the module is loaded AFTER the setup hook installed
// the Module.prototype.require interceptor.
const { placeBet } = require('../services/game-engine');

async function runTests() {
  console.log('🧪 Starting Game Bet & Bankroll Limits Tests...');

  const userId = '33333333-4444-5555-6666-777777777777';

  MOCK_USERS.push({
    id: userId,
    balance: 100000.00,
    withdrawable_balance_coins: 100000.00,
    is_active: true,
  });

  try {
    // 1. Test normal bet placement (wager 10 USDT)
    console.log('\nScenario 1: Testing normal bet placement...');
    (global as any).__SET_MOCK_OUTCOME__('heads');
    const bet1 = await placeBet({
      userId,
      choice: 'heads',
      amount: 10.00,
    });
    console.log(`Bet completed. Won: ${bet1.won}, Payout: ${bet1.payout}, New Balance: ${bet1.newBalance}`);

    const user = MOCK_USERS.find((u) => u.id === userId)!;
    const expectedBalance = 100000.00 - 10.00 + 19.60;
    if (Math.abs(user.balance - expectedBalance) < 0.0001) {
      console.log('✅ Balance correctly updated in database.');
    } else {
      throw new Error(`Balance mismatch: expected ${expectedBalance}, got ${user.balance}`);
    }

    user.balance = 100000.00;
    user.withdrawable_balance_coins = 100000.00;

    // 2. Test Max Win Cap rejection
    console.log('\nScenario 2: Testing Max Win Cap rejection...');
    try {
      await placeBet({
        userId,
        choice: 'heads',
        amount: 30000.00,
      });
      throw new Error('Expected bet to be rejected due to max win cap, but it was processed');
    } catch (err: any) {
      if (err.message.includes('জয়ের সীমা')) {
        console.log('✅ Max Win Cap check verified: blocked bet exceeding potential payout limit.');
      } else {
        throw err;
      }
    }

    if (user.balance === 100000.00) {
      console.log('✅ Balance remains unchanged after rejection.');
    } else {
      throw new Error(`Balance was modified after rejected bet: ${user.balance}`);
    }

    // 3. Test House Edge config changes
    console.log('\nScenario 3: Testing House Edge margin adjustment...');
    const edgeSetting = MOCK_SETTINGS.find((s) => s.key === 'house_edge_percent')!;
    edgeSetting.value = '5.00';
    (global as any).__SET_MOCK_OUTCOME__('heads');

    const bet2 = await placeBet({
      userId,
      choice: 'heads',
      amount: 1000.00,
    });

    console.log(`Edge 5.0% - Wager: 1000.00, Won: ${bet2.won}, Result Payout: ${bet2.payout}`);
    if (bet2.payout === 1900.00) {
      console.log('✅ House edge multiplier verified correctly as 1.90x.');
    } else {
      throw new Error(`Expected payout 1900.00, got: ${bet2.payout}`);
    }

    edgeSetting.value = '2.00';
    user.balance = 100000.00;
    user.withdrawable_balance_coins = 100000.00;

    // 4. Test Transaction rollback on DB fail
    console.log('\nScenario 4: Testing Transaction Rollback on DB error...');
    setQueryInterceptor(async (text: string) => {
      if (text.includes('INSERT INTO bets')) {
        throw new Error('Simulated database crash during bet insertion');
      }
    });

    try {
      await placeBet({
        userId,
        choice: 'tails',
        amount: 10.00,
      });
      throw new Error('Expected transaction to fail, but it succeeded');
    } catch (err: any) {
      if (err.message.includes('Simulated database crash')) {
        console.log('✅ Game engine correctly threw simulated insert error.');
      } else {
        throw err;
      }
    }

    const finalUser = MOCK_USERS.find((u) => u.id === userId);
    if (finalUser && finalUser.balance === 100000.00) {
      console.log('✅ Transaction Rollback verified: User balance remains unchanged.');
    } else {
      throw new Error(`Balance was updated despite transaction failure: ${finalUser ? finalUser.balance : 'undefined'}`);
    }

    setQueryInterceptor(null);

    if (MOCK_BETS.length >= 2) {
      console.log('✅ Bets were persisted to the mock database.');
    }

    console.log('\n🎉 All game bet & bankroll limits tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed: ${errorMsg}`);
    console.error((err as Error).stack);
    process.exit(1);
  }
}

runTests();