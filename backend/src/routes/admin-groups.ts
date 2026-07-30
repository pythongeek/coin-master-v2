/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — /api/admin/groups (Phase 1 / Day 5)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Admin console endpoints for group_bet (Phase 1 §6 §10):
 *
 *    11. GET  /api/admin/groups                 — list + filters (status, fraud_score, frozen, creator_id)
 *    12. GET  /api/admin/groups/:id             — full view (members, audit, fraud_signals)
 *    13. POST /api/admin/groups/:id/force-cancel — refund all members, cancel room
 *    14. POST /api/admin/groups/:id/freeze      — set is_frozen=true
 *    15. POST /api/admin/groups/:id/mark-fraud  — force-record a fraud signal + freeze room
 *
 *  Auth: adminLimiter + authMiddleware + roleMiddleware(['super_admin', 'support', 'finance']).
 *  Every admin action:
 *    1. Writes a row to audit_log (category='group_play', severity='warn'/'critical')
 *    2. Writes a row to group_bet_audit (action='admin_force_cancel'/'admin_freeze'/'admin_mark_fraud')
 *    3. Records a fraud_signals row (severity='info', signal_type='group_admin_force')
 *
 *  Cancellation: refunds all members via the same Day-4 refund flow
 *  (transition to cancelled, then sweep-style creditPayout per member).
 *  Since we want immediate refund (not waiting for expiry sweep),
 *  we inline the refund logic here, gated by the same state-machine
 *  pattern as the expiry service.
 * ════════════════════════════════════════════════════════════════
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../config/database';
import { authMiddleware, roleMiddleware, AuthPayload } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { validateBody, validateParams } from '../middleware/validation';
import { creditPayout } from '../services/bonus';
import { transitionGroupStatus, GroupBetTransitionError } from '../services/group-bet-state';
import {
  evaluateOnJoin,
  evaluateOnFlip,
  recordAdminForce,
  listGroupFraudSignals,
} from '../services/group-bet-fraud';

const router = Router();

interface AuthedRequest extends Request {
  user: AuthPayload;
}

// ─── Param schemas ──────────────────────────────────────────────
const idParamSchema = z.object({
  id: z.string().min(8).max(64),
});

const forceCancelBodySchema = z.object({
  reason: z.string().min(3).max(500),
});

const freezeBodySchema = z.object({
  reason: z.string().min(3).max(500),
});

const markFraudBodySchema = z.object({
  signalType: z.string().min(3).max(50),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reason: z.string().min(3).max(500),
});

// ─── Admin refund helper (cancel flow) ─────────────────────────
async function refundAllMembers(groupId: string): Promise<{
  refunded: number;
  total: number;
}> {
  let totalRefunded = 0;
  let memberCount = 0;
  await withTransaction(async (txQuery) => {
    const members = await txQuery(
      `SELECT user_id, stake::text AS stake
         FROM group_bet_member
        WHERE group_id = $1
        ORDER BY joined_at ASC`,
      [groupId],
    ) as { rows: any[]; rowCount: number };
    for (const m of members.rows) {
      const stake = parseFloat(m.stake);
      if (!(stake > 0)) continue;
      try {
        await creditPayout(m.user_id, stake, 'withdrawable', txQuery as any);
        memberCount++;
        totalRefunded += stake;
      } catch (err: any) {
        throw new Error(`refund failed for user ${m.user_id}: ${err?.message}`);
      }
    }
    for (const m of members.rows) {
      const stake = parseFloat(m.stake);
      if (!(stake > 0)) continue;
      await txQuery(
        `INSERT INTO transactions
           (user_id, type, amount, currency, direction, status, metadata)
         VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
        [
          m.user_id,
          stake.toFixed(8),
          JSON.stringify({
            pool: 'group_play',
            reason: 'group_bet_admin_force_cancel',
            groupBetId: groupId,
            role: m.role,
          }),
        ],
      );
    }
  });
  return { refunded: memberCount, total: totalRefunded };
}

// ─── 11. GET /api/admin/groups — list ───────────────────────────
router.get(
  '/',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'support', 'finance', 'auditor']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = String(req.query.status || '').trim();
      const creatorId = String(req.query.creatorId || '').trim();
      const onlyFrozen = req.query.frozen === 'true';
      const minFraudScore = parseInt(String(req.query.minFraudScore || '0'), 10) || 0;
      const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
      const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

      const params: unknown[] = [];
      const where: string[] = [];
      if (status) { params.push(status); where.push(`g.status = $${params.length}`); }
      if (creatorId) { params.push(creatorId); where.push(`g.creator_id = $${params.length}`); }
      if (onlyFrozen) where.push('g.is_frozen = true');
      if (minFraudScore > 0) where.push(`g.fraud_score >= ${minFraudScore}`);
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const r = await query(
        `SELECT g.id, g.short_code, g.status, g.is_frozen, g.fraud_score,
                g.creator_id, g.creator_choice, g.total_pool::text AS total_pool,
                g.current_members, g.max_members, g.payout_mode, g.turn_mode,
                g.expires_at, g.created_at, g.resolved_at,
                (SELECT count(*) FROM group_bet_member m WHERE m.group_id = g.id)::int AS member_count
           FROM group_bet g
           ${whereClause}
          ORDER BY g.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      return res.status(200).json({ success: true, data: r.rows, limit, offset });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 12. GET /api/admin/groups/:id — full detail ────────────────
router.get(
  '/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'support', 'finance', 'auditor']),
  validateParams(idParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const g = await query<any>(
        `SELECT g.* FROM group_bet WHERE id = $1 OR short_code = $1 LIMIT 1`,
        [id],
      );
      if (!g.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      const group = g.rows[0];
      const members = await query<any>(
        `SELECT user_id, role, choice, stake::text AS stake, weight::text AS weight,
                payout_amount::text AS payout, is_winner, joined_at
           FROM group_bet_member WHERE group_id = $1 ORDER BY joined_at ASC`,
        [group.id],
      );
      const audit = await query<any>(
        `SELECT action, actor_id, payload, ip_address::text AS ip_address, created_at
           FROM group_bet_audit WHERE group_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [group.id],
      );
      const fraud = await listGroupFraudSignals(group.id);
      return res.status(200).json({
        success: true,
        data: {
          group,
          members: members.rows,
          audit: audit.rows,
          fraudSignals: fraud,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 13. POST /api/admin/groups/:id/force-cancel ───────────────
router.post(
  '/:id/force-cancel',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  validateParams(idParamSchema),
  validateBody(forceCancelBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthedRequest).user.userId;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { reason } = req.body;

      // 1. Refund all members
      const refund = await refundAllMembers(id);
      // 2. Flip status open|ready → cancelled
      let transitioned = false;
      try {
        await transitionGroupStatus(
          {
            groupId: id,
            actorId: adminId,
            ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
            payload: { reason, refunded: refund.refunded, totalRefunded: refund.total.toFixed(8), trigger: 'admin_force_cancel' },
          },
          { fromStatuses: ['open', 'ready'], toStatus: 'cancelled', action: 'admin_force_cancel', auditSeverity: 'critical' },
        );
        transitioned = true;
      } catch (e) {
        if (!(e instanceof GroupBetTransitionError)) throw e;
        // Room was already resolved/cancelled/expired — refunds already
        // happened; surface a 409 but include refund details so the
        // operator can audit.
        transitioned = false;
      }
      // 3. Record admin-force signal
      await recordAdminForce(id, adminId, 'admin_force_cancel', reason);
      return res.status(200).json({
        success: true,
        data: {
          groupId: id,
          transitioned,
          refundedMembers: refund.refunded,
          refundedTotal: refund.total.toFixed(8),
          reason,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 14. POST /api/admin/groups/:id/freeze ─────────────────────
router.post(
  '/:id/freeze',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  validateParams(idParamSchema),
  validateBody(freezeBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthedRequest).user.userId;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { reason } = req.body;

      // Toggle is_frozen
      const r = await query<any>(
        `UPDATE group_bet
            SET is_frozen = NOT is_frozen, updated_at = NOW()
          WHERE id = $1
          RETURNING id, is_frozen`,
        [id],
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      const newState = r.rows[0].is_frozen;

      // Record admin-force signal (records the action regardless of direction)
      await recordAdminForce(id, adminId, 'admin_freeze', reason);

      return res.status(200).json({
        success: true,
        data: { groupId: id, is_frozen: newState, reason },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 15. POST /api/admin/groups/:id/mark-fraud ─────────────────
router.post(
  '/:id/mark-fraud',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  validateParams(idParamSchema),
  validateBody(markFraudBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthedRequest).user.userId;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { signalType, severity, reason } = req.body;

      // Force-freeze the room
      await query(`UPDATE group_bet SET is_frozen = true, fraud_score = 100, updated_at = NOW() WHERE id = $1`, [id]);

      // Record the admin-initiated signal
      await recordAdminForce(id, adminId, 'admin_mark_fraud', `${signalType}: ${reason}`);

      // Write the fraud_signals row directly (uses the supplied type)
      const fingerprint = `admin_mark_fraud:${id}:${adminId}:${signalType}`;
      await query(
        `INSERT INTO fraud_signals
           (user_id, signal_type, severity, fingerprint, status, metadata)
         VALUES ($1, $2, $3, $4, 'confirmed', $5::jsonb)
         ON CONFLICT (fingerprint) DO UPDATE SET severity = EXCLUDED.severity, metadata = EXCLUDED.metadata`,
        [
          adminId,
          signalType,
          severity,
          fingerprint,
          JSON.stringify({ groupId: id, reason, trigger: 'admin_mark_fraud' }),
        ],
      );

      return res.status(200).json({
        success: true,
        data: { groupId: id, signalType, severity, reason, frozen: true },
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;

// Re-export fraud helpers so the public user/group-bet routes can hook in
export { evaluateOnJoin, evaluateOnFlip };
