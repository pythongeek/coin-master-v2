/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET SERVICE — Play-money Coin wallet (Phase 2.4)
 * ═══════════════════════════════════════════════════════════════
 *
 *  ARCHITECTURE (per design discussion 2026-06-29):
 *    - Internal unit: Coin (1 Coin = 1 USDT, pegged)
 *    - Display in 3 currencies: BDT, USDT, USD
 *    - Rates from Binance P2P via services/rate-fetcher
 *    - Play money: NO real-crypto deposits/withdrawals
 *
 *  USAGE:
 *    import { getWalletBalance, topUp, getDisplayBalances } from './wallet';
 *
 *    const balance = await getWalletBalance(userId);
 *    // → { balanceCoins: 10, preferredCurrency: 'USD', lastUpdated: ... }
 *
 *    const display = await getDisplayBalances(userId);
 *    // → { coins: 10, BDT: 1200, USDT: 10, USD: 10 }
 *
 *  TOP-UP (stub):
 *    User picks a currency, sees the equivalent Coin amount, confirms.
 *    We add the Coin amount to wallet_balance_coins, write a wallet_transactions
 *    row, and return the new balance. This is play money — no real money
 *    is moved. In production, this would integrate with a payment processor.
 *
 *  COMPATIBILITY NOTE:
 *    - The existing `users.balance` column is kept (used by game-engine.ts)
 *    - New `users.wallet_balance_coins` is the wallet view
 *    - For now, both columns are kept in sync by the top-up flow
 *    - The game-engine still reads from `users.balance` directly
 * ═══════════════════════════════════════════════════════════════
 */

import { query, withTransaction } from '../config/database';
import { v4 as uuidv4 } from 'uuid';
import {
  getAllCoinRates, coinsToCurrency, currencyToCoins,
  type SupportedCurrency,
} from './rate-fetcher';

// ── Public types ──────────────────────────────────────────────
export interface WalletBalance {
  userId: string;
  balanceCoins: number;
  preferredCurrency: SupportedCurrency;
  /** The user's last top-up currency, defaults to 'USD' */
  lastTopUpCurrency: SupportedCurrency | null;
  lastTopUpAt: Date | null;
}

export interface DisplayBalances {
  coins: number;
  /** Same number, shown in 3 currencies (rounded) */
  BDT: number;
  USDT: number;
  USD: number;
  /** Rate snapshot (so the UI can show "1 Coin = ৳120.5") */
  rates: Record<SupportedCurrency, number>;
  /** When rates were fetched */
  ratesFetchedAt: Date;
}

export interface TopUpRequest {
  userId: string;
  currency: SupportedCurrency;
  amount: number;          // amount in the chosen currency
  source?: string;         // default 'system'
  note?: string;
}

export interface TopUpResult {
  walletBalance: WalletBalance;
  displayBalances: DisplayBalances;
  topUp: {
    amountCoins: number;
    amountCurrency: number;
    currency: SupportedCurrency;
    rate: number;
    transactionId: string;
  };
}

// ── Service functions ──────────────────────────────────────────

/** Get wallet balance (Coin-only) for a user */
export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const r = await query(
    `SELECT
       wallet_balance_coins::float8 AS balance_coins,
       preferred_currency,
       last_topup_currency,
       last_topup_at
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!r.rows.length) {
    throw new Error('User not found');
  }
  const row = r.rows[0];
  return {
    userId,
    balanceCoins: parseFloat(row.balance_coins) || 0,
    preferredCurrency: row.preferred_currency as SupportedCurrency,
    lastTopUpCurrency: row.last_topup_currency as SupportedCurrency | null,
    lastTopUpAt: row.last_topup_at ? new Date(row.last_topup_at) : null,
  };
}

/** Get display balances: same Coin amount in 3 currencies + rates */
export async function getDisplayBalances(userId: string): Promise<DisplayBalances> {
  const wallet = await getWalletBalance(userId);
  const rates = await getAllCoinRates();
  return {
    coins: wallet.balanceCoins,
    BDT:    parseFloat((wallet.balanceCoins * rates.BDT).toFixed(2)),
    USDT:   parseFloat((wallet.balanceCoins * rates.USDT).toFixed(2)),
    USD:    parseFloat((wallet.balanceCoins * rates.USD).toFixed(2)),
    rates,
    ratesFetchedAt: new Date(),
  };
}

/** Set the user's preferred display currency */
export async function setPreferredCurrency(
  userId: string,
  currency: SupportedCurrency,
): Promise<void> {
  await query(
    `UPDATE users SET preferred_currency = $1, updated_at = NOW() WHERE id = $2`,
    [currency, userId],
  );
}

/** Top up the wallet with a currency amount (play money) */
export async function topUp(req: TopUpRequest): Promise<TopUpResult> {
  if (req.amount <= 0) {
    throw new Error('Top-up amount must be positive');
  }
  const validCurrencies: SupportedCurrency[] = ['BDT', 'USDT', 'USD'];
  if (!validCurrencies.includes(req.currency)) {
    throw new Error(`Unsupported currency: ${req.currency}`);
  }

  // Convert currency → Coins
  const amountCoins = await currencyToCoins(req.amount, req.currency);
  const rate = (await getAllCoinRates())[req.currency];
  const ratePerCoin = req.amount / amountCoins;  // for snapshot

  // Atomic: update users + insert wallet_transactions row
  const txId = uuidv4();
  await withTransaction(async (txQuery) => {
    // 1. Update wallet balance (and the gameplay balance column to keep in sync)
    await txQuery(
      `UPDATE users
       SET wallet_balance_coins = wallet_balance_coins + $1,
           balance = balance + $1,
           last_topup_currency = $2,
           last_topup_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [amountCoins, req.currency, req.userId],
    );

    // 2. Insert wallet_transactions row
    await txQuery(
      `INSERT INTO wallet_transactions
        (user_id, type, amount_coins, currency, amount_display, rate_snapshot, source, note, metadata)
       VALUES ($1, 'topup', $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
      [
        req.userId,
        amountCoins,
        req.currency,
        req.amount,
        ratePerCoin,
        req.source ?? 'system',
        req.note ?? null,
      ],
    );
  });

  // Return the new state
  const walletBalance = await getWalletBalance(req.userId);
  const displayBalances = await getDisplayBalances(req.userId);
  return {
    walletBalance,
    displayBalances,
    topUp: {
      amountCoins,
      amountCurrency: req.amount,
      currency: req.currency,
      rate: ratePerCoin,
      transactionId: txId,
    },
  };
}

/** Get wallet_transactions history for a user */
export async function getWalletHistory(userId: string, limit: number = 20) {
  const r = await query(
    `SELECT id, type, amount_coins, currency, amount_display, rate_snapshot,
            source, note, created_at
     FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

/**
 * Sync wallet_balance_coins with the gameplay balance column.
 * Used by a periodic job (TODO) to ensure both stay in sync even if
 * one path bypasses the other.
 */
export async function syncWalletAndGameplayBalance(userId: string): Promise<void> {
  await query(
    `UPDATE users
     SET wallet_balance_coins = balance,
         updated_at = NOW()
     WHERE id = $1 AND wallet_balance_coins != balance`,
    [userId],
  );
}