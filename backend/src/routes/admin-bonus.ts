/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN BONUS CAMPAIGN ROUTES — Full CRUD + grant + stats
 * ═══════════════════════════════════════════════════════════════
 *
 *  Endpoints:
 *    GET    /api/admin/bonus-campaigns           — list all campaigns
 *    POST   /api/admin/bonus-campaigns           — create new
 *    GET    /api/admin/bonus-campaigns/:id       — read one
 *    PATCH  /api/admin/bonus-campaigns/:id       — update
 *    DELETE /api/admin/bonus-campaigns/:id       — delete
 *    POST   /api/admin/bonus-campaigns/:id/grant — manual grant to user(s)
 *    GET    /api/admin/bonus-campaigns/stats/summary — global stats
 *    GET    /api/admin/bonus-campaigns/:id/claims    — list claims
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { adminBonusCampaignSchema } from '../schemas';
import { validateBody } from '../middleware/validation';
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  claimCampaign,
  grantCampaignByEvent,
  getCampaignStats,
  type CampaignInput,
} from '../services/bonus-campaigns';

const router = Router();

// ── List ──────────────────────────────────────────────────────
router.get(
  '/bonus-campaigns',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const { rows, total } = await listCampaigns({
        type: req.query.type as any,
        active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
        search: req.query.search as string,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
        offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      });
      res.json({ success: true, campaigns: rows, total });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Stats summary ─────────────────────────────────────────────
router.get(
  '/bonus-campaigns/stats/summary',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support', 'auditor']),
  async (_req: Request, res: Response) => {
    try {
      const stats = await getCampaignStats();
      res.json({ success: true, stats });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Read one ──────────────────────────────────────────────────
router.get(
  '/bonus-campaigns/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const c = await getCampaign(String(req.params.id));
      if (!c) return res.status(404).json({ success: false, error: 'Campaign not found.' });
      res.json({ success: true, campaign: c });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Create ────────────────────────────────────────────────────
router.post(
  '/bonus-campaigns',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  validateBody(adminBonusCampaignSchema),
  async (req: Request, res: Response) => {
    try {
      const admin = (req as Request & { user: AuthPayload }).user;
      const input: CampaignInput = { ...req.body, created_by: admin.userId };
      const c = await createCampaign(input);
      res.status(201).json({ success: true, campaign: c });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Update ────────────────────────────────────────────────────
router.patch(
  '/bonus-campaigns/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  async (req: Request, res: Response) => {
    try {
      const admin = (req as Request & { user: AuthPayload }).user;
      const c = await updateCampaign(String(req.params.id), req.body, admin.userId);
      if (!c) return res.status(404).json({ success: false, error: 'Campaign not found.' });
      res.json({ success: true, campaign: c });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Delete ────────────────────────────────────────────────────
router.delete(
  '/bonus-campaigns/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const admin = (req as Request & { user: AuthPayload }).user;
      const ok = await deleteCampaign(String(req.params.id), admin.userId);
      if (!ok) return res.status(404).json({ success: false, error: 'Campaign not found.' });
      res.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Manual grant to user(s) ───────────────────────────────────
router.post(
  '/bonus-campaigns/:id/grant',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support']),
  async (req: Request, res: Response) => {
    try {
      const admin = (req as Request & { user: AuthPayload }).user;
      const body = req.body as { userIds?: string[]; amount?: number; note?: string };
      const userIds: string[] = Array.isArray(body.userIds) ? body.userIds : [];
      const amountOverride: number | undefined = typeof body.amount === 'number' ? body.amount : undefined;
      const note: string | undefined = body.note;
      if (!userIds.length) {
        return res.status(400).json({ success: false, error: 'userIds required.' });
      }

      const results: Array<{ userId: string; ok: boolean; reason?: string; bonusClaimId?: string; amount?: number }> = [];
      for (const userId of userIds) {
        const r = await claimCampaign({
          userId,
          campaignId: String(req.params.id),
          amountOverride,
          source: 'admin',
          metadata: { granted_by: admin.userId, note },
        });
        results.push({
          userId,
          ok: r.ok,
          reason: r.reason,
          bonusClaimId: r.bonusClaimId,
          amount: r.amountCoins,
        });
      }
      const failed = results.filter(r => !r.ok);
      res.json({
        success: failed.length === 0,
        granted: results.filter(r => r.ok).length,
        failed: failed.length,
        results,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Trigger auto-grant for testing ────────────────────────────
router.post(
  '/bonus-campaigns/trigger/:event',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body as { userId?: string };
      if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
      const event = String(req.params.event) as 'signup' | 'deposit' | 'rain' | 'vip_tier';
      const granted = await grantCampaignByEvent(event, userId, (req.body as { amount?: number }).amount);
      res.json({ success: true, grantedCount: granted.length, granted });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── List claims for a campaign ────────────────────────────────
router.get(
  '/bonus-campaigns/:id/claims',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const limit = Math.min(parseInt((req.query.limit as string) || '50'), 200);
      const offset = parseInt((req.query.offset as string) || '0');
      const r = await query(
        `SELECT bcc.id, bcc.user_id, u.username, bcc.amount_coins,
                bcc.wagering_required_coins, bcc.wagering_completed_coins,
                bcc.status, bcc.claimed_at, bcc.completed_at,
                bcc.metadata
         FROM bonus_campaign_claims bcc
         JOIN users u ON u.id = bcc.user_id
         WHERE bcc.campaign_id = $1
         ORDER BY bcc.claimed_at DESC
         LIMIT $2 OFFSET $3`,
        [String(req.params.id), limit, offset],
      );
      const count = await query(
        'SELECT COUNT(*)::int AS total FROM bonus_campaign_claims WHERE campaign_id = $1',
        [String(req.params.id)],
      );
      res.json({ success: true, claims: r.rows, total: count.rows[0].total });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

export default router;