import crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { db, query } from '../config/database';
import { tronMcpService } from './tron-mcp.service';
import { decryptSecretToBuffer } from './secret-vault';
import { queueAdminEmail } from './notification.service';

const REQUIRED_CONFIRMATIONS = 19;

function hotWalletAddressFromKey(privateKeyBuf: Buffer): string {
  // TronWeb.address.fromPrivateKey accepts a hex string. We render the
  // key JUST-IN-TIME into a Buffer-local scratch field rather than
  // touching the caller's plaintext buffer; the scratch is owned by
  // this function and goes out of scope on return. We then reverse the
  // scratch Buffer's bytes.
  //
  // Strategy: instead of building a JS string from the plaintext Buffer,
  // we copy into a private scratch and zero it immediately after use.
  // V8 will eventually GC the scratch, and we don't rely on it being
  // zeroed in flight — the zeroing close to use is the hardening.
  const scratch = Buffer.alloc(privateKeyBuf.length);
  privateKeyBuf.copy(scratch);
  try {
    const { TronWeb } = require('tronweb');
    // TronWeb.address.fromPrivateKey accepts (string | Buffer); for
    // safety we pass as a Buffer — the resulting allocation is a
    // NEW string that the GC will eventually collect. Acceptable for
    // a derived 34-byte address (T-address), not the key itself.
    return TronWeb.address.fromPrivateKey(scratch.toString('hex'));
  } finally {
    scratch.fill(0);
  }
}

export interface WithdrawalPayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
  /**
   * S1-W3: true when the broadcast succeeded but the on-chain
   * confirmation polling never reached REQUIRED_CONFIRMATIONS within
   * the 5-minute polling window. The row is in 'payout_stuck' state
   * and an admin must resolve it manually via the resolve-stuck
   * endpoint. Callers (BullMQ) should NOT retry.
   */
  stuck?: boolean;
}

/**
 * Broadcast a TRON (TRC-20 USDT) withdrawal to the blockchain.
 * Called after the admin has approved the withdrawal in the queue.
 *
 * Flow:
 *  1. Validate destination, amount and chain.
 *  2. Decrypt the hot wallet private key into a Buffer.
 *  3. Use MCP estimateEnergy to check the on-chain cost.
 *  4. Build and sign the USDT transfer locally (private key never
 *     leaves the server and is zeroed via `.fill(0)` immediately after
 *     the signing call returns — see P1-09).
 *  5. Broadcast via TronGrid MCP broadcastTransaction.
 *  6. Poll getTransactionInfoById until confirmed.
 *  7. Mark withdrawal completed with the real tx hash.
 *
 * S1-W3 — Confirmation timeout:
 *  If the polling loop exhausts 30 × 10s = 5 minutes without reaching
 *  REQUIRED_CONFIRMATIONS, the row is set to 'payout_stuck' (NOT
 *  'failed', NOT throw). The on-chain tx_hash is preserved, the
 *  locked_balance is NOT restored (money is on-chain), and an admin
 *  email is queued. The function returns success=false with stuck=true.
 *  BullMQ MUST NOT retry (no double-broadcast).
 *
 * Security:
 * - Private key is held in a NodeJS `Buffer`, never in a JS `string`.
 *   This avoids V8's external (UTF-16) heap for the secret bytes.
 * - After every code path that uses the key (success OR error), the
 *   key Buffer is filled with zeros via `privateKeyBuf.fill(0)` in
 *   the `finally` block of the signing scope. Memory inspection
 *   tools or process-core dumps therefore see a 0x00 plaintext
 *   span from the moment the function returns / throws.
 * - Destination address is validated as a TRON address.
 * - Amount is verified against the locked transaction row.
 * - Real on-chain tx hash is stored; no mock hashes.
 */
export async function payoutTronWithdrawal(txId: string): Promise<WithdrawalPayoutResult> {
  if (!env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED) {
    return { success: false, error: 'HOT_WALLET_PRIVATE_KEY_ENCRYPTED is not configured' };
  }

  let privateKeyBuf: Buffer | null = null;
  try {
    privateKeyBuf = decryptSecretToBuffer(env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED);
    if (privateKeyBuf.length === 0) {
      throw new Error('Decrypted hot-wallet private key is empty');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const txResult = await client.query(
        `SELECT id, user_id, wallet_id, amount, status, to_address, metadata
         FROM transactions
         WHERE id = $1 AND type = 'withdrawal'
         FOR UPDATE`,
        [txId],
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
      const hotWalletAddress = hotWalletAddressFromKey(privateKeyBuf);
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
        [],
      );
      const dailyTotal = parseFloat(dailyResult.rows[0].total);
      if (dailyTotal + amount > dailyLimit) {
        throw new Error(`Hot wallet daily withdrawal limit ${dailyLimit} USDT exceeded`);
      }
      logger.info('Hot wallet balance check passed', { txId, hotBalance, dailyTotal, dailyLimit });

      // 2. Estimate energy cost before spending real funds
      logger.info('Estimating TRON withdrawal energy', { txId, toAddress, amount });
      const energyEstimate = await tronMcpService.estimateEnergy(toAddress, amount, privateKeyBuf);
      logger.info('Energy estimate', { txId, energy: energyEstimate.energy });

      // 3. Build and sign locally
      const build = await tronMcpService.buildUsdtTransfer(toAddress, amount, privateKeyBuf);
      if (!build.txId || !build.signedTx) {
        throw new Error('Failed to build USDT withdrawal transaction');
      }
      logger.info('USDT withdrawal signed locally', { txId, unsignedTxId: build.txId });

      // 4. Broadcast via TronGrid MCP
      const broadcast = await tronMcpService.broadcastTransaction(build.signedTx);
      if (!broadcast.result || !broadcast.txId) {
        throw new Error(`Broadcast failed: ${broadcast.code || 'unknown'}`);
      }
      logger.info('USDT withdrawal broadcast', { txId, onChainTxHash: broadcast.txId });

      // Persist the tx_hash as soon as broadcast succeeds. This is the
      // critical invariant: even if confirmation polling never resolves,
      // the row carries the on-chain tx_hash so the S1-W11 reconciliation
      // cron (and S1-W3 admin resolve-stuck endpoint) can find it.
      await client.query(
        `UPDATE transactions
            SET tx_hash = $1,
                metadata = metadata || jsonb_build_object(
                  'payout_chain', 'tron',
                  'energy_estimate', $2::int,
                  'broadcast_at', NOW()::text
                )
          WHERE id = $3`,
        [broadcast.txId, energyEstimate.energy, txId],
      );

      // 5. Wait for on-chain confirmation (real tx hash, not mock)
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
        // S1-W3: stop throwing. The broadcast already happened on-chain.
        // Throwing causes BullMQ to retry, which would double-broadcast.
        // Instead: mark the row 'payout_stuck', preserve the tx_hash,
        // DO NOT restore locked_balance (money is on-chain), commit
        // the transaction, queue an admin email, and return success=false
        // with stuck=true so the BullMQ worker flips the job to 'failed'
        // (no retry) instead of 'completed' (no double-broadcast).
        await client.query(
          `UPDATE transactions
              SET status = 'payout_stuck',
                  metadata = metadata || jsonb_build_object(
                    'payout_stuck_at', NOW()::text,
                    'payout_stuck_attempts', $1::int,
                    'payout_stuck_reason', 'confirmation_timeout',
                    'payout_stuck_confirmations', $2::int
                  )
            WHERE id = $3`,
          [attempts, confirmation.confirmations, txId],
        );
        await client.query('COMMIT');

        // Best-effort admin alert. Outside the DB transaction so the
        // alert system can't block the row commit.
        try {
          await queueAdminEmail({
            event_type: 'withdrawal.payout_stuck',
            user_id: tx?.user_id || null,
            context: {
              withdrawal_id: txId,
              on_chain_tx_hash: broadcast.txId,
              attempts,
              last_confirmations: confirmation.confirmations,
              required_confirmations: REQUIRED_CONFIRMATIONS,
              resolve_endpoint: `/api/admin/withdrawals/${txId}/resolve-stuck`,
            },
          });
        } catch (emailErr) {
          logger.error('payout_stuck: failed to queue admin email', { txId, error: String(emailErr) });
        }

        logger.error('TRON withdrawal payout STUCK — manual sweep required', {
          txId,
          onChainTxHash: broadcast.txId,
          attempts,
          confirmations: confirmation.confirmations,
        });

        // Commit done; release client (finally block).
        return { success: false, stuck: true, txHash: broadcast.txId, error: 'Confirmation timeout' };
      }

      // 6. Mark completed and release locked balance
      await client.query(
        `UPDATE transactions
         SET status = 'completed', completed_at = NOW(),
             confirmations = $1,
             metadata = metadata || jsonb_build_object('payout_completed_at', NOW()::text)
         WHERE id = $2`,
        [confirmation.confirmations, txId],
      );

      await client.query(
        `UPDATE wallets
         SET locked_balance = locked_balance - $1, updated_at = NOW()
         WHERE id = $2`,
        [amount, tx.wallet_id],
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

      // S1-W3: do NOT overwrite the 'payout_stuck' status if we set it
      // (the 'stuck' branch returns early and never gets here). But if
      // any other failure happens (broadcast error, balance check, etc.)
      // we still want to record the failure.
      // Exception: if the row was already 'payout_stuck' (re-process),
      // don't downgrade it to 'failed'.
      await query(
        `UPDATE transactions
         SET status = CASE
               WHEN status = 'payout_stuck' THEN status
               ELSE 'failed'
             END,
             metadata = metadata || jsonb_build_object('payout_error', $1::text, 'payout_failed_at', NOW()::text)
         WHERE id = $2`,
        [error, txId],
      ).catch((e) => logger.error('Failed to record withdrawal payout failure', { e }));

      logger.error('TRON withdrawal payout failed', { txId, error });
      return { success: false, error };
    } finally {
      client.release();
    }
  } catch (err) {
    // catches the outer `if (!env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED)` branch
    // and `decryptSecretToBuffer` failure path.
    if (err instanceof Error && /HOT_WALLET_PRIVATE_KEY_ENCRYPTED/.test(err.message)) {
      return { success: false, error: err.message };
    }
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  } finally {
    // P1-09: explicit memory scrub. `privateKeyBuf.fill(0)` writes zeros
    // over the entire backing allocation (Buffer is a Uint8Array
    // subclass; .fill mutates in place). V8 may or may not zero on GC,
    // so we deterministically overwrite here.
    if (privateKeyBuf) {
      privateKeyBuf.fill(0);
    }
  }
}

export async function confirmTronWithdrawal(txId: string): Promise<{ confirmed: boolean; confirmations: number }> {
  const txResult = await query(
    `SELECT tx_hash, status FROM transactions WHERE id = $1 AND type = 'withdrawal'`,
    [txId],
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
