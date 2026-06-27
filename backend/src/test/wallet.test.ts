import crypto from 'crypto';
import Module from 'module';

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
  if (id === 'bullmq') {
    return {
      Queue: class MockQueue {},
      Worker: class MockWorker {}
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

// ==========================================
// 1. Database and Redis Mocks
// ==========================================
const mockUsers: any[] = [];
const mockWallets: any[] = [];
const mockTransactions: any[] = [];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  if (normalized.startsWith('INSERT INTO users')) {
    const id = params[0];
    const username = params[1];
    const balance = params[2] || 0.00;
    if (!mockUsers.find(u => u.id === id)) {
      mockUsers.push({ id, username, balance });
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT balance FROM users') || normalized.startsWith('SELECT id, username, email, wallet_address, balance, is_admin, created_at FROM users')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [user] : [] };
  }

  if (normalized.startsWith('UPDATE users SET balance = balance + $1')) {
    const amount = Number(params[0]);
    const userId = params[1];
    const user = mockUsers.find(u => u.id === userId);
    if (user) {
      user.balance = Number(user.balance) + amount;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT deposit_address, deposit_address_index FROM wallets WHERE user_id = $1')) {
    const userId = params[0];
    const chain = params[1];
    // Filter by IS NULL to check native wallets status
    const wallet = mockWallets.find(w => w.user_id === userId && w.chain === chain && w.token_address === null);
    return { rows: wallet ? [wallet] : [] };
  }

  if (normalized.startsWith('SELECT balance FROM wallets WHERE id = $1') || normalized.startsWith('SELECT balance, locked_balance FROM wallets WHERE id = $1')) {
    const walletId = params[0];
    const wallet = mockWallets.find(w => w.id === walletId);
    return { rows: wallet ? [wallet] : [] };
  }

  if (normalized.startsWith('INSERT INTO wallets')) {
    let id, user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address, balance;
    balance = 0.00;

    if (normalized.includes('(id,')) {
      // From merchant-payment.ts (mock wallet setup)
      id = params[0];
      user_id = params[1];
      chain = params[2];
      token_symbol = params[3];
      deposit_address = null;
      deposit_address_index = null;
      token_address = null;
    } else {
      // From wallet-derivation.ts (HD derivation inserts)
      id = crypto.randomUUID();
      user_id = params[0];
      chain = params[1];
      
      token_symbol = 'ETH';
      if (normalized.includes("'USDT'")) token_symbol = 'USDT';
      else if (normalized.includes("'USDC'")) token_symbol = 'USDC';
      else if (normalized.includes("'SOL'")) token_symbol = 'SOL';
      else if (normalized.includes("'TRX'")) token_symbol = 'TRX';

      deposit_address = params[2];
      deposit_address_index = params[3];
      token_address = params[4] || null;
    }

    // Check if wallet constraint UNIQUE(user_id, chain, token_address) is met
    const duplicate = mockWallets.find(w => w.user_id === user_id && w.chain === chain && w.token_address === token_address);
    if (duplicate) {
      // simulate ON CONFLICT DO UPDATE SET deposit_address
      duplicate.deposit_address = deposit_address;
      return { rows: [duplicate] };
    }

    const newWallet = { id, user_id, chain, token_symbol, deposit_address, deposit_address_index, balance, locked_balance: 0, token_address };
    mockWallets.push(newWallet);
    return { rows: [newWallet] };
  }

  if (normalized.startsWith('UPDATE wallets SET balance = balance + $1')) {
    const amount = Number(params[0]);
    const walletId = params[1];
    const wallet = mockWallets.find(w => w.id === walletId);
    if (wallet) {
      wallet.balance = Number(wallet.balance) + amount;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT id, user_id, wallet_id, amount, status FROM transactions WHERE reference_id = $1') || 
      normalized.startsWith('SELECT id, user_id, wallet_id, amount, confirmations, required_confirmations, tx_hash, status FROM transactions WHERE status = \'confirming\'')) {
    if (normalized.includes('confirming')) {
      const chain = params[0];
      const txs = mockTransactions.filter(t => t.status === 'confirming' && JSON.parse(t.metadata || '{}').chain === chain);
      return { rows: txs };
    }
    const refId = params[0];
    const tx = mockTransactions.find(t => t.reference_id === refId);
    return { rows: tx ? [tx] : [] };
  }

  if (normalized.startsWith('SELECT status, confirmations') || normalized.startsWith('SELECT status FROM transactions') || normalized.startsWith('SELECT status, completed_at FROM transactions') || normalized.startsWith('SELECT id, user_id, wallet_id, amount, status FROM transactions WHERE id = $1')) {
    const txId = params[0];
    const tx = mockTransactions.find(t => t.id === txId);
    return { rows: tx ? [tx] : [] };
  }

  if (normalized.startsWith('INSERT INTO transactions')) {
    let id, user_id, wallet_id, type, amount, status, tx_hash, confirmations, required_confirmations, from_address, to_address, metadata, reference_id, reference_type;
    
    if (params.length === 9) {
      // From deposit-monitor.ts
      id = params[0];
      user_id = params[1];
      wallet_id = params[2];
      type = 'deposit';
      amount = params[3];
      status = 'confirming';
      tx_hash = params[4];
      required_confirmations = params[5];
      confirmations = required_confirmations === 1 ? 0 : 1; // Solana starts 0 before completion, EVM/Tron starts 1
      from_address = params[6];
      to_address = params[7];
      metadata = params[8];
    } else {
      // From merchant-payment.ts
      id = crypto.randomUUID();
      user_id = params[0];
      wallet_id = params[1];
      type = 'deposit';
      amount = params[2];
      status = 'pending';
      reference_id = params[3];
      reference_type = 'deposit_merchant';
      metadata = params[4];
    }
    const tx = { id, user_id, wallet_id, type, amount, status, tx_hash, confirmations, required_confirmations, from_address, to_address, metadata, reference_id, reference_type, completed_at: null };
    mockTransactions.push(tx);
    return { rows: [tx] };
  }

  if (normalized.startsWith('UPDATE transactions SET confirmations = $1')) {
    const confs = params[0];
    const txId = params[1];
    const tx = mockTransactions.find(t => t.id === txId);
    if (tx) {
      tx.confirmations = confs;
    }
    return { rows: [] };
  }

  if (normalized.startsWith('UPDATE transactions SET status = \'completed\'')) {
    const txId = params[0];
    const tx = mockTransactions.find(t => t.id === txId);
    if (tx) {
      tx.status = 'completed';
      tx.completed_at = new Date();
    }
    return { rows: [] };
  }

  if (normalized.startsWith('SELECT id, user_id FROM wallets WHERE deposit_address = $1')) {
    const depositAddress = params[0];
    const chain = params[1];
    const currency = params[2];
    const wallet = mockWallets.find(w => 
      w.deposit_address.toLowerCase() === depositAddress.toLowerCase() && 
      w.chain === chain && 
      w.token_symbol === currency
    );
    return { rows: wallet ? [{ id: wallet.id, user_id: wallet.user_id }] : [] };
  }

  if (normalized.startsWith('SELECT balance FROM wallets WHERE user_id = $1 AND chain = $2')) {
    const userId = params[0];
    const chain = params[1];
    const wallet = mockWallets.find(w => w.user_id === userId && w.chain === chain);
    return { rows: wallet ? [wallet] : [] };
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

// Intercept Redis module exports
import * as redisModule from '../config/redis';
let addressIndices: any = {};
const mockRedis = {
  incr: async (key: string) => {
    addressIndices[key] = (addressIndices[key] || 0) + 1;
    return addressIndices[key];
  },
  get: async (key: string) => null,
  set: async (key: string, val: string) => 'OK',
};
(redisModule as any).redis = mockRedis;

// ==========================================
// 2. Real Imports and Test Execution
// ==========================================
import { deriveEVMWallet, deriveSolanaWallet, deriveTronWallet, getOrCreateUserWallet } from '../services/wallet-derivation';
import { verifyBinanceWebhook, signBinanceRequest } from '../services/merchant-payment';
import { registerIncomingDeposit, processNewBlock } from '../services/deposit-monitor';
import * as bip39 from 'bip39';

async function runTests() {
  console.log('🧪 Starting Wallet & Payment Integration Tests...');

  const mnemonic = bip39.generateMnemonic();
  const mockUserId = '22222222-3333-4444-5555-666666666666';

  try {
    // 1. Test EVM Derivation
    console.log('\nTesting EVM Derivation...');
    const evmWallet = deriveEVMWallet(mnemonic, 1);
    console.log(`Derived EVM address (index 1): ${evmWallet.address}`);
    if (evmWallet.address.startsWith('0x') && evmWallet.address.length === 42) {
      console.log('✅ EVM Address Derivation valid.');
    } else {
      throw new Error(`Invalid EVM address format: ${evmWallet.address}`);
    }

    // Consistency check
    const evmWallet2 = deriveEVMWallet(mnemonic, 1);
    if (evmWallet.address !== evmWallet2.address) {
      throw new Error('EVM addresses are inconsistent for the same index');
    }
    console.log('✅ EVM consistency verified.');

    // 2. Test Solana Derivation
    console.log('\nTesting Solana Derivation...');
    const solWallet = await deriveSolanaWallet(mnemonic, 1);
    console.log(`Derived Solana address (index 1): ${solWallet.address}`);
    if (solWallet.address.length >= 32 && solWallet.address.length <= 44) {
      console.log('✅ Solana Address Derivation valid.');
    } else {
      throw new Error(`Invalid Solana address format: ${solWallet.address}`);
    }

    // Consistency check
    const solWallet2 = await deriveSolanaWallet(mnemonic, 1);
    if (solWallet.address !== solWallet2.address) {
      throw new Error('Solana addresses are inconsistent for the same index');
    }
    console.log('✅ Solana consistency verified.');

    // 3. Test Tron Derivation
    console.log('\nTesting Tron Derivation...');
    const tronWallet = deriveTronWallet(mnemonic, 1);
    console.log(`Derived Tron address (index 1): ${tronWallet.address}`);
    if (tronWallet.address.startsWith('T') && tronWallet.address.length === 34) {
      console.log('✅ Tron Address Derivation valid.');
    } else {
      throw new Error(`Invalid Tron address format: ${tronWallet.address}`);
    }

    // Consistency check
    const tronWallet2 = deriveTronWallet(mnemonic, 1);
    if (tronWallet.address !== tronWallet2.address) {
      throw new Error('Tron addresses are inconsistent for the same index');
    }
    console.log('✅ Tron consistency verified.');

    // 4. Test Binance Signature calculations
    console.log('\nTesting Binance Webhook Signature Verification...');
    const mockPayload = JSON.stringify({ bizType: 'PAY', data: { status: 'PAY_SUCCESS', merchantTradeNo: '12345' } });
    const mockNonce = 'randomnonce123';
    const mockTimestamp = Date.now();
    const mockSecret = 'mock_binance_secret';

    const sig = signBinanceRequest(mockPayload, mockNonce, mockTimestamp, mockSecret);
    const verified = verifyBinanceWebhook(mockPayload, sig, mockNonce, String(mockTimestamp));
    if (verified) {
      console.log('✅ Binance signature verification verified.');
    } else {
      throw new Error('Binance signature verification failed');
    }

    // 5. Test database integration and confirmation monitors
    console.log('\nTesting Database Integration & Confirmation Monitors...');
    
    // Prepare mock user
    await mockQuery(
      `INSERT INTO users (id, username, balance) 
       VALUES ($1, $2, 0.00) 
       ON CONFLICT (id) DO NOTHING`,
      [mockUserId, 'test_financial_user_2']
    );

    // Derive active user wallets
    const derivedEVM = await getOrCreateUserWallet(mockUserId, 'ethereum');
    console.log(`✅ Derived EVM native and stablecoin wallets: ${derivedEVM.address}`);

    const derivedSolana = await getOrCreateUserWallet(mockUserId, 'solana');
    console.log(`✅ Derived Solana native and stablecoin wallets: ${derivedSolana.address}`);

    const derivedTron = await getOrCreateUserWallet(mockUserId, 'tron');
    console.log(`✅ Derived Tron native and stablecoin wallets: ${derivedTron.address}`);

    // Verify all wallets inserted
    const walletCount = mockWallets.filter(w => w.user_id === mockUserId).length;
    if (walletCount === 8) { // 3 EVM (ETH, USDT, USDC) + 3 Solana (SOL, USDT, USDC) + 2 Tron (TRX, USDT)
      console.log('✅ Wallet provisioning verified: 8 user wallets inserted (native + stablecoins).');
    } else {
      throw new Error(`Expected 8 wallets for user, got ${walletCount}`);
    }

    // Register incoming EVM USDT deposit (requires 12 confirmations)
    console.log('\nRegistering incoming EVM USDT transaction...');
    const evmTxHash = '0x' + crypto.randomUUID().replace(/-/g, '') + '000000000000';
    const txId = await registerIncomingDeposit({
      txHash: evmTxHash,
      fromAddress: '0x1234567890123456789012345678901234567890',
      toAddress: derivedEVM.address,
      amount: 150.00,
      chain: 'ethereum',
      currency: 'USDT'
    });

    // Check it starts confirming with 1 confirmation
    const txCheck = await mockQuery('SELECT status, confirmations, required_confirmations FROM transactions WHERE id = $1', [txId]);
    const tx = txCheck.rows[0];
    if (tx.status === 'confirming' && tx.confirmations === 1 && tx.required_confirmations === 12) {
      console.log('✅ Incoming EVM USDT Tx initialized as confirming with 1/12 confirmations.');
    } else {
      throw new Error(`Invalid initial state for EVM Tx: ${JSON.stringify(tx)}`);
    }

    // Mine 11 more blocks (completes EVM USDT)
    for (let i = 0; i < 11; i++) {
      await processNewBlock('ethereum');
    }

    const txCheckCompleted = await mockQuery('SELECT status FROM transactions WHERE id = $1', [txId]);
    if (txCheckCompleted.rows[0].status === 'completed') {
      console.log('✅ EVM USDT Tx successfully marked completed after 12 confirmations.');
    } else {
      throw new Error(`Expected completed status, got: ${txCheckCompleted.rows[0].status}`);
    }

    // Register incoming Tron TRC20 USDT deposit (requires 3 confirmations)
    console.log('\nRegistering incoming Tron TRC20 USDT transaction...');
    const tronTxHash = crypto.randomUUID().replace(/-/g, '') + 'tron';
    const tronTxId = await registerIncomingDeposit({
      txHash: tronTxHash,
      fromAddress: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      toAddress: derivedTron.address,
      amount: 300.00,
      chain: 'tron',
      currency: 'USDT'
    });

    const tronCheck = await mockQuery('SELECT status, confirmations, required_confirmations FROM transactions WHERE id = $1', [tronTxId]);
    if (tronCheck.rows[0].status === 'confirming' && tronCheck.rows[0].confirmations === 1 && tronCheck.rows[0].required_confirmations === 3) {
      console.log('✅ Tron TRC20 USDT Tx initialized confirming with 1/3 confirmations.');
    }

    // Mine 1 block (reaches 2/3)
    await processNewBlock('tron');
    // Mine 2nd block (reaches 3/3, completes)
    await processNewBlock('tron');

    const tronCheckCompleted = await mockQuery('SELECT status FROM transactions WHERE id = $1', [tronTxId]);
    if (tronCheckCompleted.rows[0].status === 'completed') {
      console.log('✅ Tron TRC20 USDT Tx successfully marked completed after 3 confirmations.');
    } else {
      throw new Error('Expected completed status for Tron TRC20 transaction');
    }

    // Register EVM USDC deposit (requires 12 confirmations)
    console.log('\nRegistering incoming EVM USDC transaction...');
    const evmUSDCTxHash = '0x' + crypto.randomUUID().replace(/-/g, '') + 'usdc';
    const evmUSDCTxId = await registerIncomingDeposit({
      txHash: evmUSDCTxHash,
      fromAddress: '0x1234567890123456789012345678901234567890',
      toAddress: derivedEVM.address,
      amount: 75.00,
      chain: 'ethereum',
      currency: 'USDC'
    });

    const usdcCheck = await mockQuery('SELECT status, confirmations FROM transactions WHERE id = $1', [evmUSDCTxId]);
    if (usdcCheck.rows[0].status === 'confirming' && usdcCheck.rows[0].confirmations === 1) {
      console.log('✅ EVM USDC Tx initialized confirming.');
    }

    // Mine 11 blocks to complete EVM USDC
    for (let i = 0; i < 11; i++) {
      await processNewBlock('ethereum');
    }

    const usdcCheckCompleted = await mockQuery('SELECT status FROM transactions WHERE id = $1', [evmUSDCTxId]);
    if (usdcCheckCompleted.rows[0].status === 'completed') {
      console.log('✅ EVM USDC Tx completed after 12 blocks.');
    }

    // Check balances
    const usdtEVMWallet = mockWallets.find(w => w.user_id === mockUserId && w.chain === 'ethereum' && w.token_symbol === 'USDT');
    const usdcEVMWallet = mockWallets.find(w => w.user_id === mockUserId && w.chain === 'ethereum' && w.token_symbol === 'USDC');
    const usdtTronWallet = mockWallets.find(w => w.user_id === mockUserId && w.chain === 'tron' && w.token_symbol === 'USDT');

    if (usdtEVMWallet.balance === 150 && usdcEVMWallet.balance === 75 && usdtTronWallet.balance === 300) {
      console.log('✅ Stablecoin wallet balances verified (EVM USDT, EVM USDC, Tron USDT credited correctly).');
    } else {
      throw new Error(`Balance mismatch: EVM USDT = ${usdtEVMWallet.balance}, EVM USDC = ${usdcEVMWallet.balance}, Tron USDT = ${usdtTronWallet.balance}`);
    }

    console.log('\n🎉 All local & database stablecoin multi-chain tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
