/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME ROUTES — গেমের API এন্ডপয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 *
 *  POST /api/game/bet         → বেট ধরো
 *  POST /api/game/verify      → নিজে ভেরিফাই করো
 *  GET  /api/game/history/:id → বেট হিস্ট্রি দেখো
 *  GET  /api/game/config      → বর্তমান গেম সেটিং দেখো
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { placeBet, getBetHistory } from '../services/game-engine';
import { verifyFlip } from '../services/provably-fair';
import { getConfig } from '../services/admin-config';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { betLimiterPerUser } from '../middleware/rate-limit';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/game/bet — বেট ধরো
// ══════════════════════════════════════════════════════════════
// SECURITY FIX: Previously required `userId` in request body, but the
// real game flow goes through socket-manager.ts which reads userId from
// the JWT. That meant the HTTP route was effectively dead code — any
// normal client (with a JWT but no body userId) would get a 400.
//
// Fix: apply authMiddleware so we can read `req.user.userId` from the
// JWT, matching the socket handler's behavior. The body no longer needs
// userId; if it's there, it's ignored (auth is the source of truth).
// H3 FIX: apply per-user rate limit AFTER authMiddleware so the bucket
// is keyed by `req.user.userId` (not IP). 30 bets/min per user. See
// middleware/rate-limit.ts for the rationale.
router.post('/bet', authMiddleware, betLimiterPerUser, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    if (!user?.userId) {
      return res.status(401).json({ success: false, error: 'লগইন করুন। টোকেন পাওয়া যায়নি।' });
    }

    const { choice, amount, multiplier, clientSeed } = req.body;

    if (!choice || !amount) {
      return res.status(400).json({
        success: false,
        error: 'choice (heads/tails), amount — সব দিতে হবে।'
      });
    }

    if (!['heads', 'tails'].includes(choice)) {
      return res.status(400).json({
        success: false,
        error: 'choice শুধু "heads" অথবা "tails" হতে পারে।'
      });
    }

    // Phase 2.3: multiplier is now required (was hardcoded 1.96 in v1)
    if (multiplier === undefined || multiplier === null) {
      return res.status(400).json({
        success: false,
        error: 'multiplier (1.01 – 1000) — দিতে হবে।'
      });
    }
    const m = parseFloat(multiplier);
    if (isNaN(m) || m < 1.01 || m > 1000) {
      return res.status(400).json({
        success: false,
        error: 'multiplier 1.01 এবং 1000 এর মধ্যে হতে হবে।'
      });
    }

    const result = await placeBet({
      userId: user.userId,
      choice,
      amount: parseFloat(amount),
      multiplier: m,
      clientSeed,
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/game/verify — নিজে ভেরিফাই করো
//
//  ইউজার গেম শেষে দেখতে পারবে রেজাল্টটি সত্যিই ফেয়ার ছিল কিনা।
//  তাকে শুধু serverSeed, clientSeed, nonce দিতে হবে।
// ══════════════════════════════════════════════════════════════
router.post('/verify', (req: Request, res: Response) => {
  try {
    const { serverSeed, clientSeed, nonce, serverSeedHash } = req.body;

    if (!serverSeed || !clientSeed || nonce === undefined || !serverSeedHash) {
      return res.status(400).json({
        success: false,
        error: 'serverSeed, clientSeed, nonce, serverSeedHash — সব দিতে হবে।'
      });
    }

    const result = verifyFlip({
      serverSeed,
      clientSeed,
      nonce: parseInt(nonce),
      serverSeedHash,
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/history/:userId — বেট ইতিহাস
//
//  C1 FIX: previously this was unauthenticated and let anyone fetch
//  any user's full bet history (IDOR). Now requires a JWT AND the
//  caller must be the owner OR an admin. The /verify endpoint stays
//  public — it's used by the Provably Fair widget to re-derive a
//  known seed without auth.
// ══════════════════════════════════════════════════════════════
router.get('/history/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const self = (req as Request & { user: AuthPayload }).user;

    if (self.userId !== userId && !self.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'অন্যের বেট ইতিহাস দেখার অনুমতি নেই।',
      });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const history = await getBetHistory(userId, limit);
    res.json({ success: true, data: history });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/config — বর্তমান গেম কনফিগ (পাবলিক)
//  শুধু ইউজারের জন্য প্রয়োজনীয় তথ্য
// ══════════════════════════════════════════════════════════════
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    res.json({
      success: true,
      data: {
        houseEdgePercent: config.houseEdgePercent,
        minBetAmount: config.minBetAmount,
        maxBetAmount: config.maxBetAmount,
        rainEnabled: config.rainEnabled,
        squadEnabled: config.squadEnabled,
        coinSpinDurationMs: config.coinSpinDurationMs,
        maintenanceMode: config.maintenanceMode,
        maintenanceMessage: config.maintenanceMessage,
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
