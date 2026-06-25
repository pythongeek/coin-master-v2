import crypto from 'crypto';
import Module from 'module';

// ==========================================================
// 1. Mock BullMQ before importing withdrawal-queue service
// ==========================================================
class MockQueue {
  name: string;
  static instances: MockQueue[] = [];
  jobs: { name: string; data: any; opts: any }[] = [];

  constructor(name: string, opts?: any) {
    this.name = name;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: any, opts?: any) {
    const job = { name, data, opts };
    this.jobs.push(job);
    return { id: `mock-job-${crypto.randomUUID()}`, data };
  }
}

class MockWorker {
  name: string;
  processor: Function;
  static instances: MockWorker[] = [];

  constructor(name: string, processor: Function, opts?: any) {
    this.name = name;
    this.processor = processor;
    MockWorker.instances.push(this);
  }

  async close() {
    // no-op
  }
}

// Intercept require('bullmq') using Node.js Module loader
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'bullmq') {
    return {
      Queue: MockQueue,
      Worker: MockWorker
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

// ==========================================================
// 2. Database and local mocks setup
// ==========================================================
const mockUsers: any[] = [];
const mockWallets: any[] = [];
const mockTransactions: any[] = [];

let mockQueryInterceptor: ((text: string, params: any[]) => Promise<any> | void) | null = null;

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  if (mockQueryInterceptor) {
    const res = await mockQueryInterceptor(text, params);
    if (res !== undefined) return res;
  }
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized.startsWith('SELECT kyc_status, self_excluded_until')) {
    const userId = params[0];
    const user = mockUsers.find(u => u.id === userId);
    return { rows: user ? [user] : [] };
  }

  if (normalized.startsWith('SELECT balance, locked_balance, chain, token_symbol FROM wallets')) {
    const walletId = params[0];
    const userId = params[1];
    const wallet = mockWallets.find(w => w.id === walletId && w.user_id === userId);
    return { rows: wallet ? [wallet] : [] };
  }

  if (normalized.startsWith('SELECT COALESCE(SUM(amount), 0) as total FROM transactions')) {
    const userId = params[0];
    const walletId = params[1];
    const txs = mockTransactions.filter(t => 
      t.user_id === userId && 
      t.wallet_id === walletId && 
      t.type === 'withdrawal' && 
      ['pending', 'completed'].includes(t.status)
    );
    const total = txs.reduce((acc, curr) => acc + Number(curr.amount), 0);
    return { rows: [{ total }] };
  }

  if (normalized.startsWith('UPDATE wallets SET balance = balance - $1, locked_balance = locked_balance + $1')) {
    const amount = Number(params[0]);
    const walletId = params[1];
    const wallet = mockWallets.find(w => w.id === walletId);
    if (wallet) {
      wallet.balance = Number(wallet.balance) - amount;
      wallet.locked_balance = Number(wallet.locked_balance) + amount;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('INSERT INTO transactions')) {
    const id = crypto.randomUUID();
    const user_id = params[0];
    const wallet_id = params[1];
    const type = 'withdrawal';
    const amount = Number(params[2]);
    const status = 'pending';
    const to_address = params[3];
    const metadata = params[4];
    const tx = { id, user_id, wallet_id, type, amount, status, to_address, metadata, created_at: new Date() };
    mockTransactions.push(tx);
    return { rows: [{ id }] };
  }

  if (normalized.startsWith('SELECT status FROM transactions WHERE id = $1')) {
    const txId = params[0];
    const tx = mockTransactions.find(t => t.id === txId);
    return { rows: tx ? [tx] : [] };
  }

  if (normalized.startsWith('UPDATE transactions SET status = \'completed\'')) {
    const txHash = params[0];
    const txId = params[1];
    const tx = mockTransactions.find(t => t.id === txId);
    if (tx) {
      tx.status = 'completed';
      tx.tx_hash = txHash;
      tx.completed_at = new Date();
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE wallets SET locked_balance = locked_balance - $1')) {
    const amount = Number(params[0]);
    const walletId = params[1];
    const wallet = mockWallets.find(w => w.id === walletId);
    if (wallet) {
      wallet.locked_balance = Number(wallet.locked_balance) - amount;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE transactions SET status = \'failed\'')) {
    const metadataJson = params[0];
    const txId = params[1];
    const tx = mockTransactions.find(t => t.id === txId);
    if (tx) {
      tx.status = 'failed';
      tx.metadata = metadataJson;
    }
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

// Override NODE_ENV to test to bypass delay
process.env.NODE_ENV = 'test';

// Import service after mocking
import { requestWithdrawal } from '../services/withdrawal-queue';

async function runTests() {
  console.log('🧪 Starting Withdrawal Queue & BullMQ Worker Tests...');

  const userId = '11111111-2222-3333-4444-555555555555';
  const walletId = '88888888-9999-aaaa-bbbb-cccccccccccc';

  // Seed initial user and wallet
  mockUsers.push({
    id: userId,
    kyc_status: 'unverified',
    self_excluded_until: null,
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

  try {
    // 1. Test KYC requirement
    console.log('\nScenario 1: Testing KYC check...');
    try {
      await requestWithdrawal(userId, walletId, '0xRecipientAddress', 25.00);
      throw new Error('Expected KYC error but none was thrown');
    } catch (err: any) {
      if (err.message.includes('KYC verification required')) {
        console.log('✅ KYC check verified: blocked unverified user.');
      } else {
        throw err;
      }
    }

    // Update user to verified, but self-excluded
    const user = mockUsers.find(u => u.id === userId);
    user.kyc_status = 'verified';
    user.self_excluded_until = new Date(Date.now() + 3600000); // 1 hour exclusion

    // 2. Test self-exclusion block
    console.log('\nScenario 2: Testing Self-Exclusion check...');
    try {
      await requestWithdrawal(userId, walletId, '0xRecipientAddress', 25.00);
      throw new Error('Expected self-exclusion error but none was thrown');
    } catch (err: any) {
      if (err.message.includes('Account is self-excluded')) {
        console.log('✅ Self-exclusion block verified.');
      } else {
        throw err;
      }
    }

    // Remove self-exclusion
    user.self_excluded_until = null;

    // 3. Test insufficient balance
    console.log('\nScenario 3: Testing insufficient balance check...');
    try {
      await requestWithdrawal(userId, walletId, '0xRecipientAddress', 150.00);
      throw new Error('Expected insufficient balance error but none was thrown');
    } catch (err: any) {
      if (err.message.includes('Insufficient balance')) {
        console.log('✅ Insufficient balance check verified.');
      } else {
        throw err;
      }
    }

    // 4. Test below minimum limit
    console.log('\nScenario 4: Testing minimum withdrawal limit check...');
    try {
      await requestWithdrawal(userId, walletId, '0xRecipientAddress', 5.00); // stablecoin min is 10
      throw new Error('Expected minimum limit error but none was thrown');
    } catch (err: any) {
      if (err.message.includes('below minimum withdrawal limit')) {
        console.log('✅ Minimum withdrawal check verified.');
      } else {
        throw err;
      }
    }

    // 5. Test successful request enqueuing
    console.log('\nScenario 5: Testing successful withdrawal enqueuing...');
    const result = await requestWithdrawal(userId, walletId, '0xRecipientAddress', 40.00);
    console.log(`Withdrawal request success. RequestID: ${result.requestId}`);

    // Verify database state: balance deducted, locked balance credited
    const wallet = mockWallets.find(w => w.id === walletId);
    if (wallet.balance === 60.00 && wallet.locked_balance === 40.00) {
      console.log('✅ Wallet balance debited and locked balance updated successfully.');
    } else {
      throw new Error(`Wallet balance state mismatch: balance = ${wallet.balance}, locked = ${wallet.locked_balance}`);
    }

    // Verify transaction record
    const pendingTx = mockTransactions.find(t => t.id === result.requestId);
    if (pendingTx && pendingTx.status === 'pending' && pendingTx.amount === 40.00) {
      console.log('✅ Transaction record inserted as pending.');
    } else {
      throw new Error(`Pending transaction check failed: ${JSON.stringify(pendingTx)}`);
    }

    // Verify BullMQ job enqueued
    const mockQueue = MockQueue.instances[0];
    if (mockQueue && mockQueue.jobs.length === 1 && mockQueue.jobs[0].data.txId === result.requestId) {
      console.log('✅ BullMQ queue job verified: withdrawal job enqueued successfully.');
    } else {
      throw new Error('Withdrawal job was not found in the BullMQ queue');
    }

    // 6. Test Worker processing success
    console.log('\nScenario 6: Testing BullMQ Worker processing payout...');
    const mockWorker = MockWorker.instances[0];
    if (!mockWorker) {
      throw new Error('Worker was not initialized');
    }

    const job = mockQueue.jobs[0];
    // Trigger worker processor manually
    await mockWorker.processor({
      id: 'mock-job-id',
      data: job.data
    } as any);

    // Verify transaction completed
    const completedTx = mockTransactions.find(t => t.id === result.requestId);
    if (completedTx && completedTx.status === 'completed' && completedTx.tx_hash) {
      console.log(`✅ Worker complete verified: tx updated to completed with hash ${completedTx.tx_hash}`);
    } else {
      throw new Error(`Completed transaction check failed: ${JSON.stringify(completedTx)}`);
    }

    // Verify locked balance released
    if (wallet.locked_balance === 0.00) {
      console.log('✅ Worker complete verified: locked balance released to 0.');
    } else {
      throw new Error(`Locked balance not released: ${wallet.locked_balance}`);
    }

    // 7. Test Worker processing failure (funds remain locked)
    console.log('\nScenario 7: Testing Worker failure processing payout...');
    
    // Create new withdrawal request
    const failResult = await requestWithdrawal(userId, walletId, '0xFailRecipient', 30.00);
    if (wallet.balance === 30.00 && wallet.locked_balance === 30.00) {
      console.log('✅ Second withdrawal debited successfully.');
    }

    const failJob = mockQueue.jobs[1];
    
    mockQueryInterceptor = async (text: string, params: any[]) => {
      if (text.includes('UPDATE transactions') && text.includes('completed')) {
        throw new Error('Mock broadcast blockchain node connection timed out');
      }
    };

    // Run processor, expect throw
    try {
      await mockWorker.processor({
        id: 'mock-fail-job-id',
        data: failJob.data
      } as any);
      throw new Error('Expected worker processor to throw due to simulated timeout');
    } catch (err: any) {
      if (err.message.includes('Mock broadcast blockchain node connection timed out')) {
        console.log('✅ Worker correctly threw exception during processing.');
      } else {
        throw err;
      }
    }

    // Restore query mock
    mockQueryInterceptor = null;

    // Verify database state: status is failed, balance is still locked for manual review
    const failedTx = mockTransactions.find(t => t.id === failResult.requestId);
    if (failedTx && failedTx.status === 'failed' && JSON.parse(failedTx.metadata || '{}').error) {
      console.log('✅ Failed transaction record updated to failed status with error metadata.');
    } else {
      throw new Error(`Failed transaction state check failed: ${JSON.stringify(failedTx)}`);
    }

    if (wallet.locked_balance === 30.00) {
      console.log('✅ Worker failure verified: funds remain securely held in locked_balance.');
    } else {
      throw new Error(`Locked balance should remain 30.00, got: ${wallet.locked_balance}`);
    }

    // 9. Test withdrawal request validation for deactivated/inactive accounts
    console.log('\nScenario 9: Testing withdrawal request validation for deactivated/inactive accounts...');
    // Seed an inactive user
    const inactiveUserId = 'inactive-user-uuid-1111-2222';
    const inactiveWalletId = 'inactive-wallet-uuid-3333-4444';
    
    mockUsers.push({
      id: inactiveUserId,
      kyc_status: 'verified',
      self_excluded_until: null,
      is_active: false
    });

    mockWallets.push({
      id: inactiveWalletId,
      user_id: inactiveUserId,
      chain: 'ethereum',
      token_symbol: 'USDT',
      balance: 100.00,
      locked_balance: 0.00
    });

    try {
      await requestWithdrawal(inactiveUserId, inactiveWalletId, '0xRecipientAddress', 25.00);
      throw new Error('Expected inactive user withdrawal to be blocked but it succeeded');
    } catch (err: any) {
      if (err.message.includes('Account is inactive')) {
        console.log('✅ Withdrawal deactivation check verified: inactive account withdrawal blocked.');
      } else {
        throw err;
      }
    }

    console.log('\n🎉 All withdrawal queue & BullMQ worker tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
