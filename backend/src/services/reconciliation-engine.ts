import { PoolClient } from 'pg';
import { db } from '../config/database';

export interface ReconciliationResult {
  userId: string;
  isValid: boolean;
  userBalance: {
    expected: number;
    actual: number;
    mismatch: number;
  };
  walletBalances: Array<{
    walletId: string;
    tokenSymbol: string;
    chain: string;
    expectedBalance: number;
    actualBalance: number;
    balanceMismatch: number;
    expectedLockedBalance: number;
    actualLockedBalance: number;
    lockedMismatch: number;
  }>;
  frozen: boolean;
}

const TOLERANCE = 1e-8;

/**
 * Reconciles the balances of a user and their wallets against transaction, bet, squad, and rain logs.
 * If any critical mismatch is found, logs an alert in ledger_alerts and freezes the user account.
 * 
 * @param userId - The user ID to reconcile.
 * @param existingClient - Optional PoolClient for running inside an existing database transaction.
 */
export async function reconcileUser(userId: string, existingClient?: PoolClient): Promise<ReconciliationResult> {
  const client = existingClient || await db.connect();
  
  try {
    if (!existingClient) {
      await client.query('BEGIN');
    }

    // 1. Fetch user actual balance with FOR UPDATE
    const userRes = await client.query(
      'SELECT balance, is_active FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User not found for reconciliation: ${userId}`);
    }

    const userRow = userRes.rows[0];
    const actualUserBalance = parseFloat(userRow.balance);

    // 2. Fetch expected user balance components.
    //
    // The merged schema uses status = 'completed' for finished
    // transactions, but the live DB uses 'confirmed' (the pre-merge
    // schema's vocabulary). Including both keeps the reconcile in
    // sync with either data set — see the related fix in
    // `auth.ts` register (writes a 'bonus' tx with status='confirmed'
    // for the welcome bonus) and the constraint update that
    // allowed both values in `transactions_status_check`.
    //
    // The merged code's reconcileUser originally only counted
    // `deposits`, missing the welcome `bonus` transactions written
    // by the register flow. Without the bonus being part of the
    // expected balance, every fresh user with a $10 welcome bonus
    // would be flagged as compromised (actual=10, expected=0) and
    // frozen on their first bet. We add bonus to the sum here so
    // the welcome credit is part of the user's legitimate balance.
    const depRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1
         AND type IN ('deposit', 'bonus')
         AND status IN ('completed', 'confirmed')`,
      [userId]
    );
    const deposits = parseFloat(depRes.rows[0].total);

    // Withdrawals pending/confirming/completed/failed
    const wdRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1
         AND type = 'withdrawal'
         AND status IN ('pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled')`,
      [userId]
    );
    const withdrawals = parseFloat(wdRes.rows[0].total);

    // Bets resolved (won/lost)
    const betRes = await client.query(
      "SELECT COALESCE(SUM(payout - amount), 0) as total FROM bets WHERE user_id = $1 AND status = 'resolved'",
      [userId]
    );
    const bets = parseFloat(betRes.rows[0].total);

    // Squad flips completed
    const squadRes = await client.query(
      `SELECT COALESCE(SUM(sm.payout - sq.bet_amount_each), 0) as total 
       FROM squad_members sm 
       JOIN squads sq ON sm.squad_id = sq.id 
       WHERE sm.user_id = $1 AND sq.status = 'finished'`,
      [userId]
    );
    const squadFlips = parseFloat(squadRes.rows[0].total);

    // Rain claims
    const rainRes = await client.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM rain_claims WHERE user_id = $1",
      [userId]
    );
    const rainClaims = parseFloat(rainRes.rows[0].total);

    const expectedUserBalance = deposits - withdrawals + bets + squadFlips + rainClaims;
    const userBalanceMismatch = Math.abs(expectedUserBalance - actualUserBalance);

    let isCompromised = false;
    let userAlertId: string | null = null;

    if (userBalanceMismatch > TOLERANCE) {
      isCompromised = true;
      // Log user balance mismatch alert
      const alertRes = await client.query(
        `INSERT INTO ledger_alerts 
          (user_id, alert_type, expected_balance, actual_balance, mismatch_amount, currency, details)
         VALUES ($1, 'user_balance_mismatch', $2, $3, $4, 'USDT', $5)
         RETURNING id`,
        [
          userId,
          expectedUserBalance,
          actualUserBalance,
          expectedUserBalance - actualUserBalance,
          JSON.stringify({ deposits, withdrawals, bets, squadFlips, rainClaims })
        ]
      );
      userAlertId = alertRes.rows[0].id;
    }

    // 3. Fetch user wallets with FOR UPDATE
    const walletsRes = await client.query(
      'SELECT id, chain, token_symbol, balance, locked_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    const walletBalances: ReconciliationResult['walletBalances'] = [];

    for (const wallet of walletsRes.rows) {
      const walletId = wallet.id;
      const tokenSymbol = wallet.token_symbol;
      const chain = wallet.chain;
      const actualWalletBalance = parseFloat(wallet.balance);
      const actualWalletLockedBalance = parseFloat(wallet.locked_balance);

      // Fetch expected wallet balance components
      // Per-wallet expected deposits. The merged code's wallet-level
      // reconcile has the same status filter issue as the user-level
      // reconcile above — it uses 'completed' (merged vocab) but the
      // live DB uses 'confirmed'. Including both keeps the wallet
      // reconcile correct regardless of which generator wrote the row.
      const wDepRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE wallet_id = $1
           AND type IN ('deposit', 'bonus')
           AND status IN ('completed', 'confirmed')`,
        [walletId]
      );
      const walletDeposits = parseFloat(wDepRes.rows[0].total);

      const wWdRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE wallet_id = $1
           AND type = 'withdrawal'
           AND status IN ('pending', 'confirming', 'completed', 'confirmed', 'failed', 'cancelled')`,
        [walletId]
      );
      const walletWithdrawals = parseFloat(wWdRes.rows[0].total);

      const expectedWalletBalance = walletDeposits - walletWithdrawals;
      const balanceMismatch = Math.abs(expectedWalletBalance - actualWalletBalance);

      // Fetch expected locked balance. Withdrawals are "locked"
      // when they're in-flight (pending/confirming) or failed
      // (revert possible). Settled states (completed/confirmed)
      // are NOT locked. The original merged code listed
      // 'pending, confirming, failed' here; we kept that list
      // and avoided adding 'completed/confirmed' (which would
      // be wrong — those are settled withdrawals, not locked).
      const wLockedRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE wallet_id = $1
           AND type = 'withdrawal'
           AND status IN ('pending', 'confirming', 'failed')`,
        [walletId]
      );
      const expectedWalletLockedBalance = parseFloat(wLockedRes.rows[0].total);
      const lockedMismatch = Math.abs(expectedWalletLockedBalance - actualWalletLockedBalance);

      if (balanceMismatch > TOLERANCE) {
        isCompromised = true;
        await client.query(
          `INSERT INTO ledger_alerts 
            (user_id, alert_type, expected_balance, actual_balance, mismatch_amount, currency, wallet_id, details)
           VALUES ($1, 'wallet_balance_mismatch', $2, $3, $4, $5, $6, $7)`,
          [
            userId,
            expectedWalletBalance,
            actualWalletBalance,
            expectedWalletBalance - actualWalletBalance,
            tokenSymbol,
            walletId,
            JSON.stringify({ walletDeposits, walletWithdrawals, chain, tokenSymbol })
          ]
        );
      }

      if (lockedMismatch > TOLERANCE) {
        isCompromised = true;
        await client.query(
          `INSERT INTO ledger_alerts 
            (user_id, alert_type, expected_balance, actual_balance, mismatch_amount, currency, wallet_id, details)
           VALUES ($1, 'wallet_locked_balance_mismatch', $2, $3, $4, $5, $6, $7)`,
          [
            userId,
            expectedWalletLockedBalance,
            actualWalletLockedBalance,
            expectedWalletLockedBalance - actualWalletLockedBalance,
            tokenSymbol,
            walletId,
            JSON.stringify({ expectedWalletLockedBalance, actualWalletLockedBalance, chain, tokenSymbol })
          ]
        );
      }

      walletBalances.push({
        walletId,
        tokenSymbol,
        chain,
        expectedBalance: expectedWalletBalance,
        actualBalance: actualWalletBalance,
        balanceMismatch,
        expectedLockedBalance: expectedWalletLockedBalance,
        actualLockedBalance: actualWalletLockedBalance,
        lockedMismatch
      });
    }

    // 4. Freeze account if compromised and it is currently active
    let frozen = false;
    if (isCompromised && userRow.is_active) {
      await client.query(
        'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1',
        [userId]
      );
      frozen = true;
    }

    if (!existingClient) {
      await client.query('COMMIT');
    }

    return {
      userId,
      isValid: !isCompromised,
      userBalance: {
        expected: expectedUserBalance,
        actual: actualUserBalance,
        mismatch: userBalanceMismatch
      },
      walletBalances,
      frozen
    };

  } catch (error) {
    if (!existingClient) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (!existingClient) {
      client.release();
    }
  }
}
