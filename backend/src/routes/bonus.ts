/**
 * ═══════════════════════════════════════════════════════════════
 *  USER BONUS ROUTES — Browse + opt-in campaigns
 * ═══════════════════════════════════════════════════════════════
 *
 *  Endpoints:
 *    GET  /api/bonus/campaigns              — visible campaigns (filtered by eligibility)
 *    POST /api/bonus/campaigns/:id/claim   — opt-in claim
 *    GET  /api/bonus/me                     — list my bonuses with wagering progress
 *    GET  /api/bonus/me/history             — full history of my bonus claims
 *    GET  /api/bonus/me/stats               — aggregate stats (active, completed, total claimed)
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { authLimiter } from '../middleware/rate-limiter';
import { query } from '../config/database';
import {
  listCampaigns,
  getCampaign,
  claimCampaign,
  listUserBonuses,
} from '../services/bonus-campaigns';
import { getBonusStatus } from '../services/bonus';

const router = Router();

// ── List visible campaigns for this user ──────────────────────
router.get(
  '/campaigns',
  authLimiter,
  authMiddleware,
  async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const { rows } = await listCampaigns({
        visible: true,
        search: req.query.search as string,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      });

      // Annotate each with eligibility for this user
      const annotated = await Promise.all(
        rows.map(async (c) => {
          const elig = await (await import('../services/bonus-campaigns')).userIsEligible(userId, c);
          return { ...c, eligibility: elig };
        }),
      );
      res.json({ success: true, campaigns: annotated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Opt-in claim ──────────────────────────────────────────────
router.post(
  '/campaigns/:id/claim',
  authLimiter,
  authMiddleware,
  async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const result = await claimCampaign({
        userId,
        campaignId: req.params.id,
        source: 'opt_in',
        metadata: { ip: req.ip, user_agent: req.headers['user-agent'] },
      });

      if (!result.ok) {
        return res.status(400).json({ success: false, error: result.reason });
      }
      res.json({
        success: true,
        message: `🎉 ${result.amountCoins?.toFixed(2)} coins credited!`,
        bonusClaimId: result.bonusClaimId,
        amountCoins: result.amountCoins,
        wageringRequired: result.wageringRequired,
        expiresAt: result.expiresAt,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── My bonus status (overview) ────────────────────────────────
router.get(
  '/me',
  authLimiter,
  authMiddleware,
  async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const status = await getBonusStatus(userId);
      const claims = await listUserBonuses(userId);
      res.json({
        success: true,
        status,
        claims,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── My bonus history (all claims, completed + active) ─────────
router.get(
  '/me/history',
  authLimiter,
  authMiddleware,
  async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const r = await query(
        `SELECT bc.id, bc.campaign_id, cam.name AS campaign_name, cam.code AS campaign_code,
                bc.bonus_type, bc.amount_coins, bc.wagering_required, bc.wagering_required AS wagering_required_coins,
                bc.max_withdrawal_allowed, bc.expires_at, bc.claimed_at, bc.completed_at,
                bc.status, bc.grant_source, bc.metadata
         FROM bonus_claims bc
         LEFT JOIN bonus_campaigns cam ON cam.id = bc.campaign_id
         WHERE bc.user_id = $1
         ORDER BY bc.claimed_at DESC
         LIMIT 100`,
        [userId],
      );
      res.json({ success: true, history: r.rows });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── My aggregate stats ────────────────────────────────────────
router.get(
  '/me/stats',
  authLimiter,
  authMiddleware,
  async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

      const status = await getBonusStatus(userId);
      res.json({ success: true, stats: status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

export default router;