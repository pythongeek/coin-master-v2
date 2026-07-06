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
import { getActiveSeed } from '../services/server-seed';
import { validateBody } from '../middleware/validation';
import { gameLimiter } from '../middleware/rate-limiter';
import { betSchema, verifySchema } from '../schemas';
import { fraudGuard } from '../middleware/fraud-guard';
import { authMiddleware, AuthPayload } from '../middleware/auth';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/game/bet — বেট ধরো
// ══════════════════════════════════════════════════════════════
router.post('/bet', gameLimiter, validateBody(betSchema), fraudGuard, async (req: Request, res: Response) => {
  try {
    const { userId, choice, amount, clientSeed, targetMultiplier } = req.body;

    const result = await placeBet({
      userId,
      choice,
      amount,
      clientSeed,
      targetMultiplier
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
router.post('/verify', gameLimiter, validateBody(verifySchema), (req: Request, res: Response) => {
  try {
    const { serverSeed, clientSeed, nonce, serverSeedHash, choice, targetMultiplier, houseEdge, jackpotHitChance } = req.body;

    const result = verifyFlip({
      serverSeed,
      clientSeed,
      nonce: Number(nonce),
      serverSeedHash,
      choice,
      targetMultiplier: targetMultiplier || 2.0,
      houseEdge: houseEdge || 2.0,
    });

    // Jackpot verification calculation
    const hitChance = Number(jackpotHitChance || 10000);
    const crypto = require('crypto');
    const jackpotSignature = `${clientSeed}:${nonce}:jackpot`;
    const jackpotHash = crypto.createHmac('sha256', serverSeed).update(jackpotSignature).digest('hex');
    const rawJackpotVal = parseInt(jackpotHash.slice(0, 8), 16);
    const jackpotRoll = rawJackpotVal % hitChance;
    const jackpotWon = jackpotRoll === 777;

    const extendedData = {
      ...result,
      jackpot: {
        signature: jackpotSignature,
        hash: jackpotHash,
        roll: jackpotRoll,
        hitChance,
        won: jackpotWon,
        explanation: `HMAC-SHA256("${serverSeed}", "${jackpotSignature}") = ${jackpotHash.slice(0,8)}... → Mod ${hitChance} = ${jackpotRoll} (${jackpotWon ? 'WON JACKPOT! 🎉' : 'No jackpot hit'})`
      }
    };

    res.json({ success: true, data: extendedData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/jackpot — বর্তমান প্রোগ্রেসিভ জ্যাকপট পুল দেখো
// ══════════════════════════════════════════════════════════════
router.get('/jackpot', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    res.json({
      success: true,
      data: {
        jackpotPool: config.jackpotPool,
        jackpotMinBet: config.jackpotMinBet,
        jackpotContributionPercent: config.jackpotContributionPercent,
        jackpotEnabled: config.jackpotEnabled,
        jackpotHitChance: config.jackpotHitChance,
        jackpotStartPool: config.jackpotStartPool
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/seed — Active provably-fair server seed hash
// ══════════════════════════════════════════════════════════════
router.get('/seed', async (_req: Request, res: Response) => {
  try {
    const seed = await getActiveSeed();
    if (!seed) {
      return res.status(503).json({ success: false, error: 'No active seed available' });
    }
    res.json({
      success: true,
      data: {
        seedId: seed.id,
        serverSeedHash: seed.serverSeedHash,
        activeBets: seed.activeBets,
        rotationThreshold: seed.rotationThreshold,
        activatedAt: seed.activatedAt,
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/history/:userId — বেট হিস্ট্রি
// ══════════════════════════════════════════════════════════════
// C1 FIX: ownership guard. /api/game/history/:userId requires auth +
// caller must be the owner OR an admin. /verify stays public for Provably
// Fair re-derivation.
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
    const history = await getBetHistory(userId as string, limit);
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
