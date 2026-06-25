import crypto from 'crypto';
import { Queue, Worker, Job } from 'bullmq';
import { db, query } from '../config/database';
import { redisConfig } from '../config/redis';

// Configure a withdrawal Queue
export const withdrawalQueue = new Queue('withdrawals', {
  connection: redisConfig
});

/**
 * Initiates a withdrawal request by performing safety checks, debited balances,
 * creating a transaction record, and enqueuing to BullMQ.
 */
export async function requestWithdrawal(
  userId: string,
  walletId: string,
  toAddress: string,
  amount: number
): Promise<{ requestId: string; status: string }> {
  // Validate basic parameters
  if (amount <= 0) {
    throw new Error('Withdrawal amount must be greater than zero');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Check user KYC and Self-exclusion
    const userResult = await client.query(
      'SELECT kyc_status, self_excluded_until FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];
    if (user.kyc_status !== 'verified') {
      throw new Error('KYC verification required for withdrawals');
    }

    if (user.self_excluded_until && new Date(user.self_excluded_until) > new Date()) {
      throw new Error('Account is self-excluded');
    }

    // 2. Fetch wallet and balance with row-level lock
    const walletResult = await client.query(
      'SELECT balance, locked_balance, chain, token_symbol FROM wallets WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [walletId, userId]
    );

    if (walletResult.rows.length === 0) {
      throw new Error('Wallet not found');
    }

    const wallet = walletResult.rows[0];
    const currentBalance = Number(wallet.balance);

    if (currentBalance < amount) {
      throw new Error('Insufficient balance');
    }

    // 3. Enforce withdrawal amount limits
    const currency = wallet.token_symbol;
    const chain = wallet.chain;
    
    // Check minimum withdrawal amount
    let minWithdrawal = 10; // default for stablecoins (USDT/USDC)
    if (currency === 'ETH') minWithdrawal = 0.01;
    else if (currency === 'SOL') minWithdrawal = 0.1;
    else if (currency === 'TRX') minWithdrawal = 100;

    if (amount < minWithdrawal) {
      throw new Error(`Amount is below minimum withdrawal limit of ${minWithdrawal} ${currency}`);
    }

    // Check daily withdrawal limit
    let maxDaily = 10000; // default for stablecoins (USDT/USDC)
    if (currency === 'ETH') maxDaily = 5;
    else if (currency === 'SOL') maxDaily = 100;
    else if (currency === 'TRX') maxDaily = 100000;

    const dailyResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1
         AND wallet_id = $2
         AND type = 'withdrawal'
         AND status IN ('pending', 'completed')
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [userId, walletId]
    );
    const dailyTotal = Number(dailyResult.rows[0].total);
    if (dailyTotal + amount > maxDaily) {
      throw new Error(`Daily withdrawal limit of ${maxDaily} ${currency} exceeded`);
    }

    // 4. Debit balance immediately & increase locked_balance
    await client.query(
      'UPDATE wallets SET balance = balance - $1, locked_balance = locked_balance + $1, updated_at = NOW() WHERE id = $2',
      [amount, walletId]
    );

    // 5. Create transaction record (status = 'pending')
    const txResult = await client.query(
      `INSERT INTO transactions (
        user_id, wallet_id, type, amount, status, to_address, metadata, created_at
      ) VALUES ($1, $2, 'withdrawal', $3, 'pending', $4, $5, NOW())
      RETURNING id`,
      [userId, walletId, amount, toAddress, JSON.stringify({ chain, currency })]
    );
    const txId = txResult.rows[0].id;

    await client.query('COMMIT');

    // 6. Enqueue job into BullMQ
    const delay = process.env.NODE_ENV === 'test' ? 0 : (parseInt(process.env.WITHDRAWAL_SECURITY_DELAY_MS || '0'));

    await withdrawalQueue.add('process-withdrawal', {
      txId,
      userId,
      walletId,
      toAddress,
      amount,
      chain,
      tokenSymbol: currency
    }, {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 }
    });

    return { requestId: txId, status: 'pending' };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Configure and start Worker
export const withdrawalWorker = new Worker('withdrawals', async (job: Job) => {
  const { txId, walletId, amount, chain } = job.data;

  try {
    // 1. Simulate blockchain payout / broadcast
    let txHash: string;
    if (chain === 'ethereum') {
      txHash = '0x' + crypto.randomUUID().replace(/-/g, '') + '000000000000';
    } else if (chain === 'solana') {
      txHash = crypto.randomUUID().replace(/-/g, '') + 'sol';
    } else if (chain === 'tron') {
      txHash = crypto.randomUUID().replace(/-/g, '') + 'tron';
    } else {
      txHash = crypto.randomUUID().replace(/-/g, '') + 'mock';
    }

    // 2. Perform DB updates in SQL transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Verify transaction is still pending
      const txCheck = await client.query('SELECT status FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
      if (txCheck.rows.length === 0 || txCheck.rows[0].status !== 'pending') {
        throw new Error('Transaction is not in pending state or not found');
      }

      // Update transaction to completed
      await client.query(
        `UPDATE transactions
         SET status = 'completed', tx_hash = $1, completed_at = NOW()
         WHERE id = $2`,
         [txHash, txId]
      );

      // Decrement locked_balance
      await client.query(
        `UPDATE wallets
         SET locked_balance = locked_balance - $1, updated_at = NOW()
         WHERE id = $2`,
         [amount, walletId]
      );

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    return { success: true, txHash };

  } catch (error: any) {
    console.error(`❌ Worker failed processing withdrawal job ${job.id}:`, error);

    // Update transaction to failed. Funds remain locked for manual review.
    try {
      await query(
        `UPDATE transactions
         SET status = 'failed', metadata = metadata || $1
         WHERE id = $2`,
        [JSON.stringify({ error: error.message || String(error) }), txId]
      );
    } catch (updateErr) {
      console.error('❌ Failed to update transaction status to failed:', updateErr);
    }

    throw error; // Re-throw to trigger attempts/backoff/failed state in BullMQ
  }
}, {
  connection: redisConfig,
  autorun: true
});
