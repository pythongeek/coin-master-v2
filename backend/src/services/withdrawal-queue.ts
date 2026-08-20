import { Queue, Worker, Job } from 'bullmq';
import { logger } from '../config/logger';
import { db, query } from '../config/database';
import { redisConfig } from '../config/redis';
import { reconcileUser } from './reconciliation-engine';
import { getKycSettings } from './kyc-settings';

// Configure a withdrawal Queue
export const withdrawalQueue = new Queue('withdrawals', {
  connection: redisConfig
});

function isKycVerified(kycStatus: string): boolean {
  return kycStatus === 'verified' || kycStatus === 'approved';
}

/**
 * Initiates a withdrawal request by performing safety checks, debited balances,
 * creating a transaction record, and enqueuing to BullMQ.
 */
export async function requestWithdrawal(
  userId: string,
  walletId: string,
  toAddress: string,
  amount: number,
  memo?: string
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
      'SELECT kyc_status, kyc_tier, self_excluded_until, is_active FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];
    if (!user.is_active) {
      throw new Error('Account is inactive');
    }

    const kycSettings = await getKycSettings();
    if (kycSettings.requiredForWithdrawal && !isKycVerified(user.kyc_status)) {
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

    // S1 fix: validate destination address format before touching balance.
    // Without this, a typo or wrong-chain address would lose the user's funds.
    const { validateAddress } = await import('../utils/address-validator');
    const addrCheck = validateAddress(toAddress, wallet.chain);
    if (!addrCheck.ok) {
      throw new Error('Invalid destination address for ' + wallet.chain + ': ' + addrCheck.error);
    }

    // P2-22: refuse the request outright if the destination chain is not
    // in the supported-withdrawal allowlist. This prevents the legacy
    // fake-tx-hash bug from ever producing a 'pending' row in the first
    // place — the user gets a clear 4xx and their balance is never
    // touched. The queue's worker layer enforces the same allowlist as
    // defense in depth for any legacy pending rows.
    const { isSupportedWithdrawalChain, SUPPORTED_WITHDRAWAL_CHAINS } = await import('./withdrawal-payout');
    if (!isSupportedWithdrawalChain(wallet.chain)) {
      throw new Error(
        'Withdrawal is not supported on chain \'' + wallet.chain + '\'. ' +
        'Supported chains: ' + SUPPORTED_WITHDRAWAL_CHAINS.join(', ') + '. ' +
        'Your balance is unchanged.'
      );
    }

    // KYC tier-based limits (P1 fix).
    // Tiers: tier0 = unverified (no withdrawals); tier1 = basic; tier2 = ID; tier3 = full.
    const tier = (user.kyc_tier || '').toLowerCase();
    const tierLevel = tier === 'tier3' || tier === '3' ? 3 : tier === 'tier2' || tier === '2' ? 2 : tier === 'tier1' || tier === '1' ? 1 : 0;
    if (tierLevel === 0) {
      if (kycSettings.requiredForWithdrawal) {
        throw new Error('KYC verification required for withdrawals. Please complete verification first.');
      } else {
        // Even with KYC disabled, unverified users get tight limits
        if (amount > 50) {
          throw new Error('Unverified users can withdraw max 50 USDT. Complete KYC to unlock higher limits.');
        }
      }
    } else if (tierLevel === 1) {
      if (amount > 50) throw new Error('Tier 1 limit: 50 USDT per withdrawal. Complete Tier 2 to increase.');
    } else if (tierLevel === 2) {
      if (amount > 1000) throw new Error('Tier 2 limit: 1000 USDT per withdrawal. Complete Tier 3 to increase.');
    } else if (tierLevel === 3) {
      if (amount > 10000) throw new Error('Tier 3 limit: 10000 USDT per withdrawal.');
    }

    // Daily limit (sum of pending + completed withdrawals today)
    const tierDailyLimits: Record<number, number> = { 0: 50, 1: 100, 2: 5000, 3: 50000 };
    const dailyMax = tierDailyLimits[tierLevel];
    if (dailyMax > 0) {
      const todayRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS total
         FROM transactions
         WHERE user_id = $1
           AND type = 'withdrawal'
           AND status IN ('pending', 'confirmed')
           AND created_at >= date_trunc('day', NOW())`,
        [userId]
      );
      const todayTotal = todayRes.rows[0].total;
      if (todayTotal + amount > dailyMax) {
        throw new Error('Daily withdrawal limit exceeded. Used ' + todayTotal.toFixed(2) + '/' + dailyMax + ' USDT today. Tier ' + tierLevel + ' limit.');
      }
    }

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
      [userId, walletId, amount, toAddress, JSON.stringify({ chain, currency, memo: memo || null })]
    );
    const txId = txResult.rows[0].id;

    // Run reconciliation check
    await reconcileUser(userId, client);

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
  const { txId, walletId, amount, chain, userId, toAddress } = job.data;

  // P2-22: replace the legacy fake-hash path. The worker used to call
  // crypto.randomUUID() and write the result to transactions.tx_hash with
  // status='completed' for ethereum/solana/'mock' chains — debiting
  // wallets.locked_balance without ever broadcasting on-chain. The fix
  // is to call payoutWithdrawal (the single entry point) which returns
  // success=true ONLY if a real on-chain transaction was produced.
  const { payoutWithdrawal, isSupportedWithdrawalChain, SUPPORTED_WITHDRAWAL_CHAINS } = await import('./withdrawal-payout');

  try {
    // 1. Belt-and-suspenders: refuse to process unsupported chains. The
    // request layer already rejects these, but legacy rows might still
    // be in the queue from before this fix.
    if (!isSupportedWithdrawalChain(chain)) {
      await markWithdrawalFailed(
        txId,
        walletId,
        amount,
        userId,
        `unsupported_chain: chain='${chain}' supported=[${SUPPORTED_WITHDRAWAL_CHAINS.join(',')}]`,
      );
      // BullMQ: mark resolved (success:true) so the job does not retry —
      // retries would just fail the same way. Funds are returned to
      // available_balance so the user can re-request on a supported chain.
      return { success: false, failureReason: 'unsupported_chain', txId };
    }

    // 2. Dispatch to the real broadcaster. This awaits the actual chain
    // call (or returns an error like 'configuration_missing' if the
    // chain's hot-wallet key is not set).
    const result = await payoutWithdrawal(chain, txId);

    if (!result.success) {
      await markWithdrawalFailed(
        txId,
        walletId,
        amount,
        userId,
        `${result.failureReason || 'unknown'}: ${result.error || 'no error message'}`,
      );
      return { success: false, failureReason: result.failureReason, error: result.error, txId };
    }

    // 3. Success — payoutWithdrawal already wrote tx_hash and marked the
    // transaction 'completed' inside payoutTronWithdrawal. We just need
    // to decrement locked_balance and run reconciliation.
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Verify the transaction is still in 'completed' state (payoutTronWithdrawal
      // wrote it). If something else touched it in the meantime, abort.
      const txCheck = await client.query(
        `SELECT status, tx_hash FROM transactions WHERE id = $1 FOR UPDATE`,
        [txId],
      );
      if (txCheck.rows.length === 0) {
        throw new Error('Transaction disappeared after payout');
      }
      if (txCheck.rows[0].status !== 'completed' || !txCheck.rows[0].tx_hash) {
        throw new Error(
          `Payout claimed success but transaction is status='${txCheck.rows[0].status}' ` +
          `tx_hash='${txCheck.rows[0].tx_hash || ''}'`,
        );
      }

      // Decrement locked_balance (the matching 'completed' row was already
      // written by payoutTronWithdrawal under FOR UPDATE).
      await client.query(
        `UPDATE wallets
         SET locked_balance = locked_balance - $1, updated_at = NOW()
         WHERE id = $2`,
        [amount, walletId],
      );

      await reconcileUser(userId, client);

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    logger.info('Withdrawal worker completed', { txId, chain, walletId, amount, txHash: result.txHash });
    return { success: true, txHash: result.txHash };
  } catch (error: any) {
    console.error(`❌ Worker failed processing withdrawal job ${job.id}:`, error);

    // Best-effort: mark the transaction failed and return funds to
    // available_balance. If the DB is down, the job will retry via
    // BullMQ's exponential backoff (3 attempts, 60s base).
    try {
      await markWithdrawalFailed(
        txId,
        walletId,
        amount,
        userId,
        `worker_exception: ${error.message || String(error)}`,
      );
    } catch (markErr) {
      console.error('❌ Failed to mark withdrawal failed:', markErr);
    }

    throw error; // Re-throw to trigger attempts/backoff/failed state in BullMQ
  }
}, {
  connection: redisConfig,
  autorun: true
});

/**
 * P2-22: helper that marks a transaction 'failed', returns the locked
 * amount to the user's available balance, and writes an audit_log entry.
 * Used when the worker cannot broadcast a real transaction (unsupported
 * chain, missing config, broadcaster error).
 */
async function markWithdrawalFailed(
  txId: string,
  walletId: string,
  amount: number,
  userId: string,
  reason: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Mark transaction failed (with FOR UPDATE so we don't race against a
    // concurrent TRON payout that is mid-broadcast).
    await client.query(
      `UPDATE transactions
       SET status = 'failed',
           metadata = metadata || jsonb_build_object(
             'payout_failure', $1::text,
             'payout_failed_at', NOW()::text
           )
       WHERE id = $2 AND status = 'pending'`,
      [reason, txId],
    );

    // Return locked_balance to balance so the user can re-request on a
    // supported chain. We leave locked_balance alone for the case where
    // the transaction is already 'completed' (TRON payout finished
    // between the broadcast and this call) — the WHERE clause above
    // filters those out.
    await client.query(
      `UPDATE wallets
       SET locked_balance = locked_balance - $1,
           balance = balance + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [amount, walletId],
    );

    // Audit log: this is the record that makes the failure traceable.
    // Without it, the user's funds would appear to vanish and the admin
    // would have no signal that the withdrawal was rejected.
    await client.query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('withdrawal', 'payout.unbroadcast_refund', 'warn', $1::uuid, $2::jsonb)`,
      [
        userId,
        JSON.stringify({
          txId,
          walletId,
          amount,
          reason,
          refundedToBalance: true,
        }),
      ],
    );

    await reconcileUser(userId, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
