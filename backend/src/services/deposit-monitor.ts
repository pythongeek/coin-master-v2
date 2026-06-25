import { db, query } from '../config/database';
import crypto from 'crypto';

const CONFIRMATIONS_REQUIRED_EVM = 12;
const CONFIRMATIONS_REQUIRED_SOL = 1;

export interface DepositEvent {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: number;
  chain: 'ethereum' | 'solana';
}

/**
 * Handle new block event (or simulation) to increment confirmations
 */
export async function processNewBlock(chain: 'ethereum' | 'solana'): Promise<void> {
  const result = await query(
    `SELECT id, user_id, wallet_id, amount, confirmations, required_confirmations, tx_hash, status 
     FROM transactions 
     WHERE status = 'confirming' AND metadata->>'chain' = $1`,
    [chain]
  );

  for (const tx of result.rows) {
    const nextConfirmations = tx.confirmations + 1;
    
    if (nextConfirmations >= tx.required_confirmations) {
      // Complete transaction and credit balance
      await completeDeposit(tx.id, tx.wallet_id, tx.user_id, parseFloat(tx.amount));
      console.log(`📡 Tx ${tx.tx_hash} completed after ${nextConfirmations} confirmations.`);
    } else {
      // Just update confirmation count
      await query(
        'UPDATE transactions SET confirmations = $1 WHERE id = $2',
        [nextConfirmations, tx.id]
      );
      console.log(`📡 Tx ${tx.tx_hash} confirmation updated: ${nextConfirmations}/${tx.required_confirmations}`);
    }
  }
}

/**
 * Create a new incoming deposit transaction log (starts as confirming)
 */
export async function registerIncomingDeposit(event: DepositEvent): Promise<string> {
  // 1. Locate the derived wallet in the database
  const walletResult = await query(
    'SELECT id, user_id FROM wallets WHERE deposit_address = $1 AND chain = $2',
    [event.toAddress, event.chain]
  );

  if (walletResult.rows.length === 0) {
    throw new Error(`Deposit address ${event.toAddress} not recognized for chain ${event.chain}`);
  }

  const wallet = walletResult.rows[0];
  const requiredConfs = event.chain === 'ethereum' ? CONFIRMATIONS_REQUIRED_EVM : CONFIRMATIONS_REQUIRED_SOL;

  // Check if transaction was already registered
  const existing = await query(
    'SELECT id, status FROM transactions WHERE tx_hash = $1 AND type = $2',
    [event.txHash, 'deposit']
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const txId = crypto.randomUUID();

  // If Solana, required confirmations is 1, so register confirming then immediately complete
  if (requiredConfs === 1) {
    await query(
      `INSERT INTO transactions (
        id, user_id, wallet_id, type, amount, status, tx_hash, confirmations, required_confirmations, 
        from_address, to_address, metadata
      ) VALUES ($1, $2, $3, 'deposit', $4, 'confirming', $5, 0, $6, $7, $8, $9)`,
      [
        txId,
        wallet.user_id,
        wallet.id,
        event.amount,
        event.txHash,
        requiredConfs,
        event.fromAddress,
        event.toAddress,
        JSON.stringify({ chain: event.chain, currency: 'USDT' }),
      ]
    );

    // Complete transaction immediately
    await completeDeposit(txId, wallet.id, wallet.user_id, event.amount);
  } else {
    // EVM: Start as confirming with 1 confirmation
    await query(
      `INSERT INTO transactions (
        id, user_id, wallet_id, type, amount, status, tx_hash, confirmations, required_confirmations, 
        from_address, to_address, metadata
      ) VALUES ($1, $2, $3, 'deposit', $4, 'confirming', $5, 1, $6, $7, $8, $9)`,
      [
        txId,
        wallet.user_id,
        wallet.id,
        event.amount,
        event.txHash,
        requiredConfs,
        event.fromAddress,
        event.toAddress,
        JSON.stringify({ chain: event.chain, currency: 'USDT' }),
      ]
    );
  }

  return txId;
}

/**
 * Mark a transaction completed and credit user wallets safely (Serializable/Locked)
 */
async function completeDeposit(
  txId: string,
  walletId: string,
  userId: string,
  amount: number
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock wallet row to prevent balance race conditions
    await client.query(
      'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE',
      [walletId]
    );

    // 2. Update wallet balance
    await client.query(
      `UPDATE wallets 
       SET balance = balance + $1, updated_at = NOW() 
       WHERE id = $2`,
      [amount, walletId]
    );

    // 3. Update users table virtual balance for backward-compatibility with game engine
    await client.query(
      `UPDATE users 
       SET balance = balance + $1, updated_at = NOW() 
       WHERE id = $2`,
      [amount, userId]
    );

    // 4. Set transaction status to completed
    await client.query(
      `UPDATE transactions 
       SET status = 'completed', completed_at = NOW() 
       WHERE id = $1`,
      [txId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to complete deposit transaction:', err);
    throw err;
  } finally {
    client.release();
  }
}
