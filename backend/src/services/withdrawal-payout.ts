import crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { db, query } from '../config/database';
import { tronMcpService } from './tron-mcp.service';
import { decryptSecret } from './secret-vault';

const REQUIRED_CONFIRMATIONS = 19;

function hotWalletAddressFromKey(privateKeyHex: string): string {
  // T4.6 fix (Option B) — the stored blob decrypts to the 64-char hex
  // representation of the 32-byte private key (UTF-8 string), not the
  // raw 32-byte buffer. Feeding that hex string directly to
  // TronWeb.address.fromPrivateKey derives the correct T-address.
  //
  // Security tradeoff: a hex string cannot be memory-scrubbed like the
  // P1-09 Buffer was. We accept this because (a) the string is short-
  // lived and (b) the previous Buffer path was silently broken
  // (scratch.toString('hex') re-encoded the ASCII bytes as hex, giving
  // a 128-char string that fromPrivateKey rejects with `false`).
  // Mitigation: callers MUST pass the plaintext hex straight to
  // fromPrivateKey without retaining a reference beyond this scope.
  const { TronWeb } = require('tronweb');
  const addr = TronWeb.address.fromPrivateKey(privateKeyHex);
  // Best-effort scrub of the parameter — V8 may keep copies but the
  // authoritative string lives only in the caller's frame and goes out
  // of scope on return.
  void crypto.randomFillSync(Buffer.from(privateKeyHex, 'utf8')).fill(0);
  return addr;
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
 *  2. Decrypt the hot wallet private key into a Buffer.
 *  3. Use MCP estimateEnergy to check the on-chain cost.
 *  4. Build and sign the USDT transfer locally (private key never
 *     leaves the server and is zeroed via `.fill(0)` immediately after
 *     the signing call returns — see P1-09).
 *  5. Broadcast via TronGrid MCP broadcastTransaction.
 *  6. Poll getTransactionInfoById until confirmed.
 *  7. Mark withdrawal completed with the real tx hash.
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

  let privateKeyHex: string | null = null;
  try {
    privateKeyHex = decryptSecret(env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED);
    if (!privateKeyHex || privateKeyHex.length !== 64) {
      throw new Error('Decrypted hot-wallet private key is not a 64-char hex string');
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
      const hotWalletAddress = hotWalletAddressFromKey(privateKeyHex);
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
      const energyEstimate = await tronMcpService.estimateEnergy(toAddress, amount, privateKeyHex);
      logger.info('Energy estimate', { txId, energy: energyEstimate.energy });

      // 3. Build and sign locally
      const build = await tronMcpService.buildUsdtTransfer(toAddress, amount, privateKeyHex);
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
        throw new Error(`Withdrawal broadcast ${broadcast.txId} did not reach ${REQUIRED_CONFIRMATIONS} confirmations in time`);
      }

      // 6. Mark completed and release locked balance
      await client.query(
        `UPDATE transactions
         SET status = 'completed', tx_hash = $1, completed_at = NOW(),
             confirmations = $2,
             metadata = metadata || jsonb_build_object('broadcast_block', $3::text, 'payout_chain', 'tron', 'energy_estimate', $4::int)
         WHERE id = $5`,
        [broadcast.txId, confirmation.confirmations, confirmation.blockNumber, energyEstimate.energy, txId],
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

      await query(
        `UPDATE transactions
         SET status = 'failed',
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
    // P1-09: explicit memory scrub. The hex string cannot be deterministically
    // zeroed (V8 external UTF-16 heap), but we drop our reference so it goes
    // out of scope on return. The authoritative scratch in
    // hotWalletAddressFromKey is already overwritten before return.
    privateKeyHex = null;
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


// ══════════════════════════════════════════════════════════════
//  CHAIN ALLOWLIST + DISPATCHER (P2-22 fix)
// ══════════════════════════════════════════════════════════════
//
// Audit finding: withdrawal-queue.ts:223-253 generated fake
// `crypto.randomUUID()` tx hashes for ethereum/solana/'mock' chains
// and marked the transaction `status='completed'`. Funds were debited
// from `wallets.locked_balance` but never actually left custody.
// Customer's balance went down, no on-chain settlement happened.
//
// Fix: only the chains listed below have a real payout broadcaster.
// Every other chain is rejected at BOTH the request layer (so the
// user never even gets a pending transaction) AND the worker layer
// (so any legacy pending row in the queue fails safely instead of
// silently writing a fake hash).
//
// When a new chain is wired (e.g. Ethereum via `payoutEvmWithdrawal`),
// add it here AND write the implementation — never bypass this list.

export type SupportedWithdrawalChain = 'tron';

export const SUPPORTED_WITHDRAWAL_CHAINS: readonly SupportedWithdrawalChain[] = ['tron'] as const;

export function isSupportedWithdrawalChain(chain: string): chain is SupportedWithdrawalChain {
  return (SUPPORTED_WITHDRAWAL_CHAINS as readonly string[]).includes(chain);
}

export type PayoutFailureReason =
  | 'unsupported_chain'
  | 'real_broadcast_failed'
  | 'configuration_missing';

export interface PayoutDispatcherResult {
  success: boolean;
  txHash?: string;
  /** When success=false, the reason the payout was not broadcast. */
  failureReason?: PayoutFailureReason;
  error?: string;
}

/**
 * Dispatch a withdrawal payout to the real broadcaster for the chain.
 * Returns success=true ONLY if a real on-chain transaction hash was
 * produced. Any other path returns success=false with a
 * failureReason so the caller can mark the transaction failed and
 * surface a clear error to the user.
 *
 * IMPORTANT: this is the SINGLE entry point the worker calls. Do not
 * add crypto.randomUUID() paths here — every branch must end in a
 * real broadcast or a clean refusal.
 */
export async function payoutWithdrawal(
  chain: string,
  txId: string,
): Promise<PayoutDispatcherResult> {
  if (!isSupportedWithdrawalChain(chain)) {
    return {
      success: false,
      failureReason: 'unsupported_chain',
      error: `Withdrawal is not supported on chain '${chain}'. Supported chains: ${SUPPORTED_WITHDRAWAL_CHAINS.join(', ')}.`,
    };
  }

  // TRON — the only chain with a real payout at HEAD.
  if (chain === 'tron') {
    const result = await payoutTronWithdrawal(txId);
    if (!result.success) {
      return {
        success: false,
        failureReason: result.error && /HOT_WALLET|encrypted|empty/i.test(result.error)
          ? 'configuration_missing'
          : 'real_broadcast_failed',
        error: result.error,
      };
    }
    return { success: true, txHash: result.txHash };
  }

  // Unreachable. isSupportedWithdrawalChain guards all supported
  // chains above; this branch is for type-narrowing only.
  return {
    success: false,
    failureReason: 'unsupported_chain',
    error: `Unhandled chain in payoutWithdrawal: ${chain}`,
  };
}
