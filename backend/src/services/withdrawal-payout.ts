import crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { db, query } from '../config/database';
import { tronMcpService } from './tron-mcp.service';
import { decryptSecret } from './secret-vault';

const REQUIRED_CONFIRMATIONS = 19;

function hotWalletAddressFromKey(privateKey: string): string {
  const { TronWeb } = require('tronweb');
  return TronWeb.address.fromPrivateKey(privateKey);
}

export interface WithdrawalPayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Broadcast a TRON (TRC-20 USDT) withdrawal to the blockchain.
 * Called after the admin has approved the withdrawal in the queue.
 *
 * Flow:
 *  1. Validate destination, amount and chain.
 *  2. Decrypt the hot wallet private key.
 *  3. Use MCP estimateEnergy to check the on-chain cost.
 *  4. Build and sign the USDT transfer locally (private key never leaves the server).
 *  5. Broadcast via TronGrid MCP broadcastTransaction.
 *  6. Poll getTransactionInfoById until confirmed.
 *  7. Mark withdrawal completed with the real tx hash.
 *
 * Security:
 * - Private key is decrypted only in memory for signing.
 * - Destination address is validated as a TRON address.
 * - Amount is verified against the locked transaction row.
 * - Real on-chain tx hash is stored; no mock hashes.
 */
export async function payoutTronWithdrawal(txId: string): Promise<WithdrawalPayoutResult> {
  if (!env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED) {
    return { success: false, error: 'HOT_WALLET_PRIVATE_KEY_ENCRYPTED is not configured' };
  }

  let privateKey: string;
  try {
    privateKey = decryptSecret(env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED);
  } catch (err) {
    return { success: false, error: 'Failed to decrypt hot wallet private key' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT id, user_id, wallet_id, amount, status, to_address, metadata
       FROM transactions
       WHERE id = $1 AND type = 'withdrawal'
       FOR UPDATE`,
      [txId]
    );

    if (txResult.rows.length === 0) {
      throw new Error('Withdrawal transaction not found');
    }

    const tx = txResult.rows[0];
    if (tx.status !== 'confirmed') {
      throw new Error(`Withdrawal is in ${tx.status} state; only confirmed withdrawals can be paid out`);
    }

    const toAddress = tx.to_address;
    if (!toAddress || !toAddress.startsWith('T') || toAddress.length !== 34) {
      throw new Error('Invalid TRON destination address');
    }

    const amount = parseFloat(tx.amount);
    if (amount <= 0) {
      throw new Error('Invalid withdrawal amount');
    }

    const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : (tx.metadata || {});
    if (metadata.chain !== 'tron') {
      throw new Error('This payout function only handles TRON withdrawals');
    }

    // Ensure MCP session is ready
    await tronMcpService.start();

    // 1. Hot wallet balance and daily limit checks to prevent drain
    const hotWalletAddress = hotWalletAddressFromKey(privateKey);
    const hotBalance = await tronMcpService.getUsdtBalance(hotWalletAddress);
    if (new Decimal(hotBalance).lessThan(amount)) {
      throw new Error(`Hot wallet USDT balance insufficient: ${hotBalance} available, ${amount} requested`);
    }

    const dailyLimit = parseFloat(String(env.HOT_WALLET_DAILY_WITHDRAWAL_LIMIT));
    const dailyResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE type = 'withdrawal'
         AND status = 'completed'
         AND metadata->>'payout_chain' = 'tron'
         AND completed_at >= NOW() - INTERVAL '24 hours'`,
      []
    );
    const dailyTotal = parseFloat(dailyResult.rows[0].total);
    if (dailyTotal + amount > dailyLimit) {
      throw new Error(`Hot wallet daily withdrawal limit ${dailyLimit} USDT exceeded`);
    }
    logger.info('Hot wallet balance check passed', { txId, hotBalance, dailyTotal, dailyLimit });

    // 2. Estimate energy cost before spending real funds
    logger.info('Estimating TRON withdrawal energy', { txId, toAddress, amount });
    const energyEstimate = await tronMcpService.estimateEnergy(toAddress, amount, privateKey);
    logger.info('Energy estimate', { txId, energy: energyEstimate.energy });

    // 2. Build and sign locally
    const build = await tronMcpService.buildUsdtTransfer(toAddress, amount, privateKey);
    if (!build.txId || !build.signedTx) {
      throw new Error('Failed to build USDT withdrawal transaction');
    }
    logger.info('USDT withdrawal signed locally', { txId, unsignedTxId: build.txId });

    // 3. Broadcast via TronGrid MCP
    const broadcast = await tronMcpService.broadcastTransaction(build.signedTx);
    if (!broadcast.result || !broadcast.txId) {
      throw new Error(`Broadcast failed: ${broadcast.code || 'unknown'}`);
    }
    logger.info('USDT withdrawal broadcast', { txId, onChainTxHash: broadcast.txId });

    // 4. Wait for on-chain confirmation (real tx hash, not mock)
    let confirmation = await tronMcpService.confirmTransaction(broadcast.txId, REQUIRED_CONFIRMATIONS);
    let attempts = 0;
    while (!confirmation.confirmed && attempts < 30) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      confirmation = await tronMcpService.confirmTransaction(broadcast.txId, REQUIRED_CONFIRMATIONS);
      attempts++;
      logger.info('Withdrawal confirmation polling', {
        txId,
        onChainTxHash: broadcast.txId,
        confirmations: confirmation.confirmations,
        attempt: attempts,
      });
    }

    if (!confirmation.confirmed) {
      throw new Error(`Withdrawal broadcast ${broadcast.txId} did not reach ${REQUIRED_CONFIRMATIONS} confirmations in time`);
    }

    // 5. Mark completed and release locked balance
    await client.query(
      `UPDATE transactions
       SET status = 'completed', tx_hash = $1, completed_at = NOW(),
           confirmations = $2,
           metadata = metadata || jsonb_build_object('broadcast_block', $3::text, 'payout_chain', 'tron', 'energy_estimate', $4::int)
       WHERE id = $5`,
      [broadcast.txId, confirmation.confirmations, confirmation.blockNumber, energyEstimate.energy, txId]
    );

    await client.query(
      `UPDATE wallets
       SET locked_balance = locked_balance - $1, updated_at = NOW()
       WHERE id = $2`,
      [amount, tx.wallet_id]
    );

    await client.query('COMMIT');

    logger.info('TRON withdrawal paid out and confirmed', {
      txId,
      onChainTxHash: broadcast.txId,
      toAddress,
      amount,
      confirmations: confirmation.confirmations,
    });

    return { success: true, txHash: broadcast.txId };
  } catch (err) {
    await client.query('ROLLBACK');
    const error = err instanceof Error ? err.message : String(err);

    await query(
      `UPDATE transactions
       SET status = 'failed',
           metadata = metadata || jsonb_build_object('payout_error', $1::text, 'payout_failed_at', NOW()::text)
       WHERE id = $2`,
      [error, txId]
    ).catch((e) => logger.error('Failed to record withdrawal payout failure', { e }));

    logger.error('TRON withdrawal payout failed', { txId, error });
    return { success: false, error };
  } finally {
    client.release();
  }
}

export async function confirmTronWithdrawal(txId: string): Promise<{ confirmed: boolean; confirmations: number }> {
  const txResult = await query(
    `SELECT tx_hash, status FROM transactions WHERE id = $1 AND type = 'withdrawal'`,
    [txId]
  );

  if (txResult.rows.length === 0) {
    throw new Error('Withdrawal transaction not found');
  }

  const tx = txResult.rows[0];
  if (!tx.tx_hash || tx.status !== 'completed') {
    return { confirmed: false, confirmations: 0 };
  }

  await tronMcpService.start();
  const confirmation = await tronMcpService.confirmTransaction(tx.tx_hash, REQUIRED_CONFIRMATIONS);
  return { confirmed: confirmation.confirmed, confirmations: confirmation.confirmations };
}
