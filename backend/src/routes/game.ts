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
import { validateBody } from '../middleware/validation';
import { betSchema, verifySchema } from '../schemas';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/game/bet — বেট ধরো
// ══════════════════════════════════════════════════════════════
router.post('/bet', validateBody(betSchema), async (req: Request, res: Response) => {
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
router.post('/verify', validateBody(verifySchema), (req: Request, res: Response) => {
  try {
    const { serverSeed, clientSeed, nonce, serverSeedHash, choice, targetMultiplier, houseEdge } = req.body;

    const result = verifyFlip({
      serverSeed,
      clientSeed,
      nonce,
      serverSeedHash,
      choice,
      targetMultiplier: targetMultiplier || 2.0,
      houseEdge: houseEdge || 2.0,
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/history/:userId — বেট হিস্ট্রি
// ══════════════════════════════════════════════════════════════
router.get('/history/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
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
