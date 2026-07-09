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
    // The live DB uses split balances: bonus_balance_coins and withdrawable_balance_coins.
    // The legacy `balance` column is derived by the sync_user_balance trigger.
    // Therefore we must reconcile the actual sub-balances against the ledger
    // events that affect them, not just the derived total.
    const userRes = await client.query(
      `SELECT balance,
              bonus_balance_coins,
              withdrawable_balance_coins,
              wagering_required_coins,
              wagering_completed_coins,
              is_active
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User not found for reconciliation: ${userId}`);
    }

    const userRow = userRes.rows[0];
    const actualUserBalance = parseFloat(userRow.balance);
    const actualBonusBalance = parseFloat(userRow.bonus_balance_coins || '0');
    const actualWithdrawableBalance = parseFloat(userRow.withdrawable_balance_coins || '0');
    const actualWageringRequired = parseFloat(userRow.wagering_required_coins || '0');
    const actualWageringCompleted = parseFloat(userRow.wagering_completed_coins || '0');

    // 2. Fetch expected user balance components from the ledger.
    //    Only deposits and withdrawals directly move withdrawable funds.
    //    Bonus credits are tracked separately in bonus_claims.
    const depRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1
         AND type = 'deposit'
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

    // Bets resolved (won/lost). Payouts are credited to the same source
    // used for the debit, so the net P&L across all resolved bets matches
    // the movement in withdrawable+bonus combined.
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

    // Bonus claims: expected bonus_balance = SUM(amount_coins) - SUM(cancelled/forfeited amount)
    // For active/completed claims, the full amount was credited to bonus_balance_coins.
    const bonusRes = await client.query(
      `SELECT COALESCE(SUM(amount_coins), 0) as total
       FROM bonus_claims
       WHERE user_id = $1 AND status IN ('active', 'completed')`,
      [userId]
    );
    const bonusCredits = parseFloat(bonusRes.rows[0].total);

    // Expected totals from the ledger.
    const expectedUserBalance = deposits - withdrawals + bets + squadFlips + rainClaims + bonusCredits;
    const userBalanceMismatch = Math.abs(expectedUserBalance - actualUserBalance);

    // 2a. Split-balance checks.
    // Withdrawable balance should be deposits - withdrawals + withdrawable portion of bet P&L.
    // The exact split per bet is not stored historically, so we cannot reconstruct it
    // perfectly from legacy data. However, all bets currently debit from the source chosen
    // at bet time, and credits return to the same source. The worst-case mismatch is bounded
    // by the bonus_balance_coins. We therefore assert the invariant that total balance equals
    // bonus + withdrawable, and verify bonus_balance against the bonus_claims ledger.
    const splitBalanceMismatch = Math.abs(actualUserBalance - (actualBonusBalance + actualWithdrawableBalance));
    const bonusBalanceMismatch = Math.abs(actualBonusBalance - bonusCredits);
    const expectedWithdrawable = expectedUserBalance - bonusCredits;
    const withdrawableBalanceMismatch = Math.abs(expectedWithdrawable - actualWithdrawableBalance);

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
          JSON.stringify({ deposits, withdrawals, bets, squadFlips, rainClaims, bonusCredits })
        ]
      );
      userAlertId = alertRes.rows[0].id;
    }

    // Split-balance invariant alerts
    if (splitBalanceMismatch > TOLERANCE) {
      isCompromised = true;
      await client.query(
        `INSERT INTO ledger_alerts 
          (user_id, alert_type, expected_balance, actual_balance, mismatch_amount, currency, details)
         VALUES ($1, 'split_balance_invariant', $2, $3, $4, 'USDT', $5)`,
        [
          userId,
          actualBonusBalance + actualWithdrawableBalance,
          actualUserBalance,
          splitBalanceMismatch,
          JSON.stringify({ actualBonusBalance, actualWithdrawableBalance, actualUserBalance })
        ]
      );
    }

    if (bonusBalanceMismatch > TOLERANCE) {
      isCompromised = true;
      await client.query(
        `INSERT INTO ledger_alerts 
          (user_id, alert_type, expected_balance, actual_balance, mismatch_amount, currency, details)
         VALUES ($1, 'bonus_balance_mismatch', $2, $3, $4, 'USDT', $5)`,
        [
          userId,
          bonusCredits,
          actualBonusBalance,
          bonusBalanceMismatch,
          JSON.stringify({ bonusCredits, actualBonusBalance, actualWageringRequired, actualWageringCompleted })
        ]
      );
    }

    // We do not alert on withdrawableBalanceMismatch because the historical split
    // per bet is not stored; we only alert when the derived total or bonus ledger
    // is inconsistent. A dedicated withdrawable mismatch would require storing
    // per-bet source, which is out of scope for this hotfix.

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
