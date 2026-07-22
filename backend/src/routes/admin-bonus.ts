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

// ── Phase 1.6: per-user bonus audit trail ──────────────────────
// One-shot endpoint for the admin "Bonus Audit" panel. Returns the
// full timeline for a user: bonus claims, wagering state, recent
// withdrawals (from transactions table), fraud signals, and current
// risk score + tier. Single query group, no N+1.
router.get(
  '/bonus/user/:userId/audit',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const userId = String(req.params.userId);

      // 1. User base + risk state.
      // NOTE: suspicious_reason column doesn't exist in this DB
      // (skipped from v2.0 spec — flagged via is_flagged + audit_log instead).
      const userRow = await query(
        `SELECT id, username, email, created_at, is_flagged,
                risk_score, risk_tier,
                bonus_balance_coins, withdrawable_balance_coins,
                wagering_required_coins, wagering_completed_coins,
                total_bonus_claimed_coins, total_deposited_coins,
                kyc_status, kyc_country, self_excluded_until
           FROM users WHERE id = $1::uuid`,
        [userId],
      );
      if (userRow.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // 2. Bonus claims timeline.
      // bonus_claims has no per-claim wagering_completed column — it's
      // tracked at the user level. Show wagering_required + status only.
      const claims = await query(
        `SELECT id, bonus_type, amount_coins, wagering_required,
                max_withdrawal_allowed, expires_at, claimed_at, completed_at,
                status, metadata
           FROM bonus_claims
          WHERE user_id = $1::uuid
          ORDER BY claimed_at DESC`,
        [userId],
      );

      // 3. Recent withdrawals (from transactions table).
      const withdrawals = await query(
        `SELECT id, amount, status, created_at, completed_at, metadata
           FROM transactions
          WHERE user_id = $1::uuid AND type = 'withdrawal'
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId],
      );

      // 4. Recent deposits (for context — does the user actually fund?).
      const deposits = await query(
        `SELECT id, amount, status, created_at, completed_at
           FROM transactions
          WHERE user_id = $1::uuid AND type = 'deposit'
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId],
      );

      // 5. Fraud signals (last 90 days).
      const signals = await query(
        `SELECT id, signal_type, severity, status, detected_at, resolved_at, metadata
           FROM fraud_signals
          WHERE user_id = $1::uuid
            AND detected_at > NOW() - INTERVAL '90 days'
          ORDER BY detected_at DESC`,
        [userId],
      );

      // 6. Risk score breakdown.
      const risk = await query(
        `SELECT current_score, tier, score_breakdown, last_calculated, calculated_by
           FROM user_risk_scores WHERE user_id = $1::uuid`,
        [userId],
      );

      // 7. Devices this user has touched (Phase 1.1).
      const { getDevicesForUser } = await import('../services/device-fingerprint');
      const devices = await getDevicesForUser(userId);

      // 8. Fraud clusters (Phase 1.3).
      const { getClustersForUser } = await import('../services/graph-fraud');
      const clusters = await getClustersForUser(userId);

      // 9. Lifetime stats summary.
      const lifetime = await query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'bet')::int AS total_bets,
           COUNT(*) FILTER (WHERE type = 'win')::int AS total_wins,
           COALESCE(SUM(amount) FILTER (WHERE type = 'bet'), 0)::float AS total_wagered,
           COALESCE(SUM(amount) FILTER (WHERE type = 'win'), 0)::float AS total_won,
           COUNT(*) FILTER (WHERE type = 'bonus')::int AS bonus_credits_count,
           COALESCE(SUM(amount) FILTER (WHERE type = 'bonus'), 0)::float AS bonus_credits_total
           FROM transactions
          WHERE user_id = $1::uuid`,
        [userId],
      );

      res.json({
        success: true,
        user: userRow.rows[0],
        claims: claims.rows,
        withdrawals: withdrawals.rows,
        deposits: deposits.rows,
        signals: signals.rows,
        risk: risk.rows[0] ?? null,
        devices,
        clusters,
        lifetime: lifetime.rows[0],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// Phase 2.7 — bonus analytics dashboard
// Returns: daily claims (last 30d), top bonus types, conversion-to-withdrawal
// rate, average wagering completion, current payout liability.
router.get(
  '/analytics',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (_req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');

      // 1. Daily claims — last 30 days.
      const daily = (await query(
        `SELECT date_trunc('day', claimed_at)::date AS day,
                count(*)::int                                          AS claims,
                sum(amount_coins)::float8                              AS coins_granted,
                sum(amount_coins * wagering_required)::float8         AS wagering_required
           FROM bonus_claims
          WHERE claimed_at > NOW() - INTERVAL '30 days'
          GROUP BY day ORDER BY day ASC`,
      )).rows as Array<{ day: string; claims: number; coins_granted: number; wagering_required: number }>;

      // 2. Top bonus types — all-time counts + conversion.
      const topTypes = (await query(
        `SELECT bc.bonus_type,
                count(*)::int                                         AS claims,
                sum(bc.amount_coins)::float8                          AS coins_granted,
                count(*) FILTER (WHERE bc.status='completed')::int    AS completed,
                count(*) FILTER (WHERE bc.status='expired')::int      AS expired,
                avg(EXTRACT(EPOCH FROM (bc.completed_at - bc.claimed_at)))::float8
                  AS avg_completion_seconds
           FROM bonus_claims bc
          WHERE bc.claimed_at > NOW() - INTERVAL '30 days'
          GROUP BY bc.bonus_type ORDER BY claims DESC LIMIT 10`,
      )).rows as Array<{
        bonus_type: string; claims: number; coins_granted: number;
        completed: number; expired: number; avg_completion_seconds: number | null;
      }>;

      // 3. Conversion rate (% of bonus claims followed by at least one withdrawal).
      const conversion = (await query(
        `WITH bc AS (
           SELECT DISTINCT ON (user_id, bonus_type) user_id, bonus_type
             FROM bonus_claims
            WHERE claimed_at > NOW() - INTERVAL '30 days'
         ),
         wd AS (
           SELECT DISTINCT user_id FROM transactions
            WHERE type = 'withdrawal' AND completed_at IS NOT NULL
              AND created_at > NOW() - INTERVAL '60 days'
         )
         SELECT count(*)::int AS claim_users,
                count(*) FILTER (WHERE u.id IN (SELECT user_id FROM wd))::int AS withdrew_users
           FROM bc JOIN users u ON u.id = bc.user_id`,
      )).rows[0] as { claim_users: number; withdrew_users: number };

      // 4. Payout liability: active (un-completed, un-expired) bonus coins + wagering left.
      const liability = (await query(
        `SELECT sum(amount_coins)::float8                                             AS active_coins,
                count(*)::int                                                        AS active_claims
           FROM bonus_claims
          WHERE status IN ('pending','active') AND expires_at > NOW()`,
      )).rows[0] as { active_coins: number; active_claims: number };

      res.json({
        success: true,
        analytics: {
          dailyClaims: daily,
          topTypes,
          conversion: {
            claimUsers30d: conversion.claim_users,
            withdrewUsers30d: conversion.withdrew_users,
            rate: conversion.claim_users > 0
              ? conversion.withdrew_users / conversion.claim_users : 0,
          },
          liability: {
            activeCoins: Number(liability.active_coins) || 0,
            activeClaims: liability.active_claims,
          },
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

export default router;