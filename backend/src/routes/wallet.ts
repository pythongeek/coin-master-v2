/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET ROUTES — /api/wallet/*
 * ═══════════════════════════════════════════════════════════════
 *
 *  Phase 2.4 endpoints:
 *    GET  /api/wallet/balance          → Coin balance + display in 3 currencies
 *    GET  /api/wallet/rates            → Current BDT/USDT/USD rates for 1 Coin
 *    GET  /api/wallet/history          → User's wallet_transactions history
 *    POST /api/wallet/topup           → Add Coins (play money, no real money)
 *    POST /api/wallet/preferred-currency → Set user's preferred display currency
 *
 *  All endpoints require authentication (authMiddleware).
 *
 *  PLAY-MONEY DISCLAIMER:
 *    No real deposits/withdrawals. The topup endpoint just adds play-money
 *    Coins to the user's wallet. Real-money integration would require a
 *    payment processor + KYC + regulatory compliance.
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload, adminMiddleware } from '../middleware/auth';
import { getAllCoinRates, type SupportedCurrency } from '../services/rate-fetcher';
import {
  getWalletBalance, getDisplayBalances, getWalletHistory,
  topUp, setPreferredCurrency,
} from '../services/wallet';
import {
  getBonusStatus, validateWithdrawal, createWithdrawalRequest,
} from '../services/bonus';

const router = Router();

// All wallet endpoints require auth
router.use(authMiddleware);

// ── GET /api/wallet/balance ───────────────────────────────────
router.get('/balance', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const wallet = await getWalletBalance(user.userId);
    const display = await getDisplayBalances(user.userId);
    res.json({
      success: true,
      wallet,
      display,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/wallet/rates ─────────────────────────────────────
router.get('/rates', async (_req: Request, res: Response) => {
  try {
    const rates = await getAllCoinRates();
    res.json({
      success: true,
      rates,
      base: 'COIN',
      note: '1 Coin = 1 USDT (peg). Other rates are from Binance P2P.',
      fetchedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/wallet/history ───────────────────────────────────
router.get('/history', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const history = await getWalletHistory(user.userId, limit);
    res.json({ success: true, history });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/wallet/topup ────────────────────────────────────
router.post('/topup', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const { currency, amount } = req.body;
    if (!currency || !amount) {
      return res.status(400).json({
        success: false,
        error: 'currency (BDT/USDT/USD) এবং amount দিতে হবে।',
      });
    }
    const validCurrencies: SupportedCurrency[] = ['BDT', 'USDT', 'USD'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        success: false,
        error: 'currency BDT, USDT, বা USD হতে হবে।',
      });
    }
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount একটি ধনাত্মক সংখ্যা হতে হবে।',
      });
    }
    if (numAmount > 1_000_000) {
      return res.status(400).json({
        success: false,
        error: 'amount ১,০০০,০০০ এর বেশি হতে পারবে না।',
      });
    }

    const result = await topUp({
      userId: user.userId,
      currency,
      amount: numAmount,
      source: 'user_topup',
      note: 'Self-service top-up via /api/wallet/topup',
    });

    res.json({
      success: true,
      ...result,
      message: `✅ ${amount} ${currency} ≈ ${result.topUp.amountCoins.toFixed(2)} Coin যোগ হয়েছে।`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/wallet/preferred-currency ──────────────────────
router.post('/preferred-currency', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const { currency } = req.body;
    if (!currency) {
      return res.status(400).json({ success: false, error: 'currency দিতে হবে।' });
    }
    const validCurrencies: SupportedCurrency[] = ['BDT', 'USDT', 'USD'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        success: false,
        error: 'currency BDT, USDT, বা USD হতে হবে।',
      });
    }
    await setPreferredCurrency(user.userId, currency);
    res.json({ success: true, preferredCurrency: currency });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────
//  Session 1 (roadmap-2026.md): bonus / withdrawal routes
//  These are mounted at /api/wallet via the index.ts import below.
// ─────────────────────────────────────────────────────────────────

// ── GET /api/wallet/bonus-status ────────────────────────────────
// Returns user's full bonus + wagering + withdrawal-eligibility state.
router.get('/bonus-status', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const status = await getBonusStatus(user.userId);
    res.json({ success: true, ...status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/wallet/withdraw ──────────────────────────────────
// Validate first; on success create a pending transactions row.
// Admin approves via /api/admin/withdrawals/:id/approve.
router.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const { amount, currency } = req.body ?? {};

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount একটি ধনাত্মক সংখ্যা হতে হবে।',
        reason: 'invalid_amount',
      });
    }

    // Run the 5-check validation
    const validation = await validateWithdrawal(user.userId, numAmount);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: validation.reasonBn,
        reason: validation.reason,
        missingCoins: validation.missingCoins,
      });
    }

    // Create the pending withdrawal transaction (debits withdrawable_balance immediately)
    const result = await createWithdrawalRequest(user.userId, numAmount, {
      currency: currency ?? 'COIN',
      source: 'user_withdraw_request',
    });

    res.json({
      success: true,
      withdrawalId: result.id,
      status: result.status,
      message: result.status === 'pending'
        ? '✅ উইথড্র রিকোয়েস্ট গৃহীত — অ্যাডমিন অনুমোদনের পর প্রসেস হবে।'
        : '✅ ছোট পরিমাণ — স্বয়ংক্রিয়ভাবে অনুমোদিত।',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  ADMIN: withdrawal approval queue
//  These are mounted at /api/admin via a separate router (see admin-withdrawals.ts)
// ─────────────────────────────────────────────────────────────────