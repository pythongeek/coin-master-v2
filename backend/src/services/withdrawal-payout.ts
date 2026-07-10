import crypto from 'crypto';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { db, query } from '../config/database';
import { tronMcpService } from './tron-mcp.service';
import { decryptSecret } from './secret-vault';

const REQUIRED_CONFIRMATIONS = 19;

export interface WithdrawalPayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Broadcast a TRON (TRC-20 USDT) withdrawal to the blockchain.
 * Called after the admin has approved the withdrawal in the queue.
 *
 * Security:
 * - The private key is decrypted from HOT_WALLET_PRIVATE_KEY_ENCRYPTED.
 * - The destination address is validated as a TRON address.
 * - The amount is verified against the locked transaction row.
 * - The real on-chain tx hash is stored; no mock hashes are used.
 */
export async function payoutTronWithdrawal(txId: string): Promise<WithdrawalPayoutResult> {
  if (!env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED) {
    return { success: false, error: 'HOT_WALLET_PRIVATE_KEY_ENCRYPTED is not configured' };
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

    // Decrypt hot wallet private key
    let privateKey: string;
    try {
      privateKey = decryptSecret(env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED!);
    } catch (err) {
      throw new Error('Failed to decrypt hot wallet private key');
    }

    // Ensure MCP session is ready
    await tronMcpService.start();

    // Build and broadcast the USDT transfer
    const build = await tronMcpService.buildUsdtTransfer(toAddress, amount, privateKey);
    if (!build.txId || !build.signedTx) {
      throw new Error('Failed to build USDT withdrawal transaction');
    }

    const broadcast = await tronMcpService.broadcastTransaction(build.signedTx);
    if (!broadcast.result) {
      throw new Error(`Broadcast failed: ${broadcast.code || 'unknown'}`);
    }

    // Mark transaction completed and unlock balance
    await client.query(
      `UPDATE transactions
       SET status = 'completed', tx_hash = $1, completed_at = NOW(),
           metadata = metadata || jsonb_build_object('broadcast_block', $2::text, 'payout_chain', 'tron')
       WHERE id = $3`,
      [broadcast.txId, metadata.chain, txId]
    );

    await client.query(
      `UPDATE wallets
       SET locked_balance = locked_balance - $1, updated_at = NOW()
       WHERE id = $2`,
      [amount, tx.wallet_id]
    );

    await client.query('COMMIT');

    logger.info('TRON withdrawal paid out', {
      txId,
      onChainTxHash: broadcast.txId,
      toAddress,
      amount,
    });

    return { success: true, txHash: broadcast.txId };
  } catch (err) {
    await client.query('ROLLBACK');
    const error = err instanceof Error ? err.message : String(err);

    // Record failure without releasing locked funds (manual review required)
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

/**
 * Confirm a previously broadcast TRON withdrawal has enough on-chain confirmations.
 * If confirmed, nothing more to do because the balance was already unlocked on broadcast.
 * This is mainly useful for audit and secondary confirmation checks.
 */
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
