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
import { query } from '../config/database';
import { validateBody } from '../middleware/validation';
import { gameLimiter } from '../middleware/rate-limiter';
import { betSchema, verifySchema } from '../schemas';
import { fraudGuard } from '../middleware/fraud-guard';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import {
  checkBetIdempotency,
  incrementSessionBetCount,
  getSessionBetCap,
  recordSessionWin,
  unlockBet,
} from '../config/redis';
import { getAdminSetting, getAdminSettingNumber } from '../services/admin-settings.service';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/game/bet — বেট ধরো
//  Industry-standard fraud controls layered before placeBet:
//   1. authMiddleware — only logged-in users
//   2. gameLimiter     — IP-level global rate limit
//   3. fraudGuard      — block flagged users + IP whitelist bypass
//   4. validateBody(betSchema) — strict zod validation incl. clientRequestId
//   5. checkBetIdempotency     — replay protection (60s window)
//   6. incrementSessionBetCount — per-user session cap (default 30/min)
//   7. placeBet       — the actual game-engine service (with row lock)
// ══════════════════════════════════════════════════════════════
router.post('/bet', gameLimiter, authMiddleware, validateBody(betSchema), fraudGuard, async (req: Request, res: Response) => {
  try {
    const { choice, amount, clientSeed, targetMultiplier, clientRequestId } = req.body;
    const userId = (req as Request & { user: AuthPayload }).user.userId;

    // 5. Idempotency replay protection (best-effort when clientRequestId provided).
    if (clientRequestId) {
      const dup = await checkBetIdempotency(userId, clientRequestId);
      if (dup) {
        return res.status(409).json({
          success: false,
          error: 'Duplicate bet (same clientRequestId in flight). Try again in 60s.',
          code: 'DUPLICATE_BET',
        });
      }
    }

    // 6. Per-user session cap (industry standard: bounded bet rate).
    const cap = await getSessionBetCap();
    const sessionCount = await incrementSessionBetCount(userId);
    if (sessionCount > cap) {
      // Defence-in-depth: re-unlock if lockBet already acquired (it hasn't
      // yet because placeBet acquires it). This is just a guard against
      // session-cap being lower than a locked bet's threshold.
      await unlockBet(userId);
      return res.status(429).json({
        success: false,
        error: `Too many bets — session cap is ${cap}/minute. Wait a bit before retrying.`,
        code: 'SESSION_CAP',
      });
    }

    const result = await placeBet({
      userId,
      choice,
      amount,
      clientSeed,
      targetMultiplier,
    });

    // Post-bet: record win rate for anomaly detection. Just observe;
    // let the AI risk engine pick up on it during recalculateRisk().
    if (result.won) {
      const w = await recordSessionWin(userId);
      const winRate = w.total > 5 && w.wins / w.total > 0.7 ? 'high' : 'normal';
      if (winRate === 'high') {
        // Don't block — just signal. The AI engine watches this column.
        // (Logging at info-level; admin-eyes only.)
        console.warn(`[bet] high win rate user=${userId.slice(0, 8)} wins/total=${w.wins}/${w.total}`);
      }
    }

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
//  GET /api/game/health — সার্ভিস স্বাস্থ্য পরীক্ষা (পাবলিক)
//  ফ্রন্টএন্ড /api/game/* পাথগুলো চালু আছে কিনা যাচাই করার জন্য।
//  এছাড়াও active seed + jackpot pool + maintenance mode স্ট্যাটাস।
// ══════════════════════════════════════════════════════════════
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    let activeSeedExists = false;
    let activeSeedActiveBets = 0;
    try {
      const seed = await getActiveSeed();
      if (seed) {
        activeSeedExists = true;
        activeSeedActiveBets = (seed as { activeBets?: number }).activeBets ?? 0;
      }
    } catch { /* no active seed is fine for the health check */ }
    res.json({
      success: true,
      data: {
        ok: true,
        maintenanceMode: config.maintenanceMode,
        activeSeedExists,
        activeSeedActiveBets,
        jackpotPool: config.jackpotPool,
        gameEnabled: !config.maintenanceMode,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/nonce — ক্লায়েন্টদের জন্য নম্বর-ওয়ান ননস
//  Provably Fair যাচাইয়ের জন্য প্রয়োজন: প্রতিটি বেটের একটি
//  অনন্য nonce থাকতে হবে, এবং ক্লায়েন্ট seed + nonce সার্ভার seed-এর
//  সাথে মিলে HMAC-SHA256 তৈরি করে রোল। এই এন্ডপয়েন্ট শুধু
//  গেম/প্রুভলি-ফেয়ার যাচাইকারীদের সুবিধার জন্য; placeBet নিজেই
//  reserveNonce() দিয়ে সার্ভার-সাইড nonce ইস্যু করে।
// ══════════════════════════════════════════════════════════════
router.get('/nonce', async (_req: Request, res: Response) => {
  try {
    const { v4: uuidv4 } = await import('uuid');
    const seed = await getActiveSeed();
    if (!seed) {
      return res.status(503).json({ success: false, error: 'No active seed' });
    }
    // Return a client-suggestable nonce token (uuid v4) + the active
    // seed hash so the client can pre-verify the next bet. The server
    // will still allocate the real nonce via reserveNonce() at bet time.
    res.json({
      success: true,
      data: {
        clientNonce: uuidv4(),
        serverSeedHash: seed.serverSeedHash,
        activeBets: (seed as { activeBets?: number }).activeBets ?? 0,
        rotationThreshold: seed.rotationThreshold ?? 1000,
        note: 'This nonce is a client-side hint; the server allocates the real nonce at bet time via reserveNonce().',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/game/recent — সাম্প্রতিক বিজয়ী বেটগুলোর পাবলিক ফিড
//  BigWinsPanel এবং Provably Fair যাচাইকারীদের জন্য।
//  PII-safe: returns user_id masked + game metadata only.
// ══════════════════════════════════════════════════════════════
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) || '20', 10) || 20));
    // Only show wins, recent first, de-identified (masked user_id only).
    const rows = (await query(
      `SELECT id::text AS bet_id,
              substring(user_id::text, 1, 8) AS user_id_masked,
              amount, payout, won, choice, result, win_chance,
              created_at, resolved_at, flip_hash
         FROM bets
        WHERE won = true
          AND status = 'resolved'
          AND amount >= 1
        ORDER BY created_at DESC
        LIMIT $1::int`,
      [limit],
    )).rows;
    res.json({
      success: true,
      data: {
        count: rows.length,
        recent: rows,
        note: 'PII-safe: user_id is masked to the first 8 chars.',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
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
