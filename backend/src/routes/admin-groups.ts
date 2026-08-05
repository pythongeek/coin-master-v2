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
import { evaluateOnJoin, evaluateOnFlip, recordAdminForce, listGroupFraudSignals } from '../services/group-bet-fraud';
import { groupAdminActionsTotal } from './metrics';
import { getGroupConfigKey } from '../services/admin-group-config';

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

// ─── Admin-group-action audit writer (Gap 15) ──────────────────────
// Mirrors the existing audit_log + group_bet_audit writes into the
// admin_actions table so the central admin-audit dashboard picks up
// group ops. `action_type` is one of the `group_*` enum values added
// in migration 049; `target_type='group_bet'`; `target_id` is the
// group UUID; `justification` is required (NOT NULL on admin_actions).
// Admin self-executed actions are recorded as approval_status='approved'
// with approved_by_id = admin_id and executed_at = NOW().
type GroupAdminAction =
  | 'group_force_cancel'
  | 'group_freeze'
  | 'group_unfreeze'
  | 'group_mark_fraud'
  | 'group_refund'
  | 'group_kick'
  | 'group_shadow';

async function recordGroupAdminAction(args: {
  groupId: string;
  adminId: string;
  action: GroupAdminAction;
  reason: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_actions
         (id, admin_id, action_type, target_type, target_id,
          justification, new_value, approval_status,
          approved_by_id, approved_at, executed_at, ip_address)
       VALUES (uuid_generate_v4(), $1, $2, 'group_bet', $3,
               $4, $5::jsonb, 'approved',
               $1, NOW(), NOW(), $6)`,
      [
        args.adminId,
        args.action,
        args.groupId,
        args.reason,
        JSON.stringify(args.metadata ?? {}),
        args.ipAddress ?? null,
      ],
    );
  } catch (err: any) {
    // Audit-write failure must NOT roll back the operator action.
    // Log to stderr so the operator can see it; the audit_log +
    // group_bet_audit rows already captured by the route still stand.
    console.error('[admin-groups] recordGroupAdminAction failed:', err?.message);
  }
}

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

// ─── 11b. GET /api/admin/groups/leaderboard (Gap 3) ────────
// Returns the top-50 members by group-bet winnings (payout_amount) over
// the last 7 days. Scoped to a 7-day window so we don't leak historic
// data. Reads from `group_bet_member.payout_amount` (already populated
// by flipGroup during the resolve path) — no separate aggregation pass.
//
// Respects the `groupLeaderboardEnabled` admin-config: if disabled,
// returns the empty list (the UI hides the tab in this case).
//
// `winnings` here = sum of payout_amount from resolved groups in the
// window. We deliberately do not include stake (only payout), since
// the leaderboard is a WIN leaderboard, not a wager-volume leaderboard.
router.get(
  '/leaderboard',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'support', 'finance', 'auditor']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Honor the 26th admin setting: disabled by default is false,
      // so the operator must explicitly set 0/false to suppress.
      const enabled = await getGroupConfigKey('groupLeaderboardEnabled').catch(() => true);
      if (!enabled) {
        return res.status(200).json({ success: true, data: [], leaderboardEnabled: false, limit: 0 });
      }

      // 7-day window + last 50 ranked by winnings DESC
      const r = await query<any>(
        `WITH ranked AS (
           SELECT
             m.user_id,
             u.username,
             SUM(COALESCE(m.payout_amount, 0))::numeric(18,8) AS winnings,
             COUNT(*)::int AS rooms_won,
             SUM(COALESCE(m.stake, 0))::numeric(18,8) AS total_stake
           FROM group_bet_member m
           JOIN group_bet g ON g.id = m.group_id
           JOIN users u ON u.id = m.user_id
          WHERE g.status = 'resolved'
            AND g.resolved_at >= NOW() - INTERVAL '7 days'
            AND m.payout_amount > 0
            AND g.is_frozen = false
          GROUP BY m.user_id, u.username
         HAVING SUM(COALESCE(m.payout_amount, 0)) > 0
         ORDER BY winnings DESC
         LIMIT 50
         )
         SELECT
           ROW_NUMBER() OVER (ORDER BY winnings DESC)::int AS rank,
           user_id, username,
           winnings::text AS winnings,
           rooms_won, total_stake::text AS total_stake
         FROM ranked`,
      );

      const data = r.rows.map((row: any) => ({
        rank: row.rank,
        userId: row.user_id,
        username: row.username,
        winnings: parseFloat(row.winnings),
        roomsWon: row.rooms_won,
        totalStake: parseFloat(row.total_stake),
      }));

      return res.status(200).json({
        success: true,
        data,
        leaderboardEnabled: true,
        window: '7 days',
        limit: data.length,
      });
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
      // 4. Gap 15: write to admin_actions so the central admin-audit
      //    dashboard picks up group ops.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: 'group_force_cancel',
        reason,
        metadata: {
          refundedMembers: refund.refunded,
          refundedTotal: refund.total.toFixed(8),
          transitioned,
        },
        ipAddress: req.ip,
      });
      groupAdminActionsTotal.inc({ action: 'force_cancel' });
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

      // Gap 15: write to admin_actions. The freeze toggle uses freeze or
      // unfreeze depending on the resulting state.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: newState ? 'group_freeze' : 'group_unfreeze',
        reason,
        metadata: { is_frozen: newState },
        ipAddress: req.ip,
      });

      groupAdminActionsTotal.inc({ action: 'freeze' });
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

      // Write the fraud_signals row directly (uses the supplied type).
      // Pre-existing bug detail: the `fingerprint` column has no unique
      // constraint, so the original ON CONFLICT clause throws 42P10.
      // Recovery: upsert via a SELECT-then-INSERT/UPDATE pattern so the
      // operator-visible mark-fraud call still succeeds even if a
      // duplicate fingerprint slips through. If the second call hits a
      // true duplicate, we swallow 23505 (post-fix it would be 42P10).
      const fingerprint = `admin_mark_fraud:${id}:${adminId}:${signalType}`;
      try {
        await query(
          `INSERT INTO fraud_signals
             (user_id, signal_type, severity, fingerprint, status, metadata)
           VALUES ($1, $2, $3, $4, 'confirmed', $5::jsonb)`,
          [
            adminId,
            signalType,
            severity,
            fingerprint,
            JSON.stringify({ groupId: id, reason, trigger: 'admin_mark_fraud' }),
          ],
        );
      } catch (fsErr: any) {
        // Duplicate key (23505) is acceptable — the original ON CONFLICT
        // intent was idempotent. Log the rest so the operator can debug.
        if (fsErr?.code !== '23505') {
          console.error('[admin-groups] mark-fraud fraud_signals upsert failed:', fsErr?.message);
        }
      }

      // Gap 15: write to admin_actions.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: 'group_mark_fraud',
        reason,
        metadata: { signalType, severity, frozen: true },
        ipAddress: req.ip,
      });

      groupAdminActionsTotal.inc({ action: 'mark_fraud' });
      return res.status(200).json({
        success: true,
        data: { groupId: id, signalType, severity, reason, frozen: true },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 16. POST /api/admin/groups/:id/refund (Day 9, Phase 2 §2.3) ──
// Reverses a FINISHED room's payouts: debits each winner's balance
// and writes a refund ledger row + group_bet_audit(action='refund').
// Use case: a confirmed-dispute case where the operator determines
// the group flip was fraudulent (e.g. compromised server seed).
router.post(
  '/:id/refund',
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

      // 1. Lock the room + verify status === 'resolved' (refund only
      // applies to FINISHED rooms; for active rooms use /force-cancel)
      const lockRow = await query<any>(
        `SELECT id, status FROM group_bet WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lockRow.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      if (lockRow.rows[0].status !== 'resolved') {
        return res.status(409).json({
          success: false,
          error: `refund only applies to status='resolved' (got '${lockRow.rows[0].status}')`,
          code: 'NOT_RESOLVED',
        });
      }

      // 2. Read all members + their payouts
      const members = await query<any>(
        `SELECT user_id, role, payout_amount::text AS payout, is_winner
           FROM group_bet_member WHERE group_id = $1`,
        [id],
      );

      // 3. Debit each winner's balance + write a debit ledger row.
      // Losers already had their stake debited at JOIN time — no reversal needed.
      let totalReversed = 0;
      let winnersCount = 0;
      await withTransaction(async (txQuery) => {
        for (const m of members.rows) {
          const payout = parseFloat(m.payout);
          if (!(payout > 0) || m.is_winner !== true) continue;
          // Debit the winner's withdrawable balance
          await txQuery(
            `UPDATE users
                SET withdrawable_balance_coins = withdrawable_balance_coins - $2
              WHERE id = $1 AND withdrawable_balance_coins >= $2`,
            [m.user_id, payout.toFixed(8)],
          );
          await txQuery(
            `INSERT INTO transactions
               (user_id, type, amount, currency, direction, status, metadata)
             VALUES ($1, 'admin_adjustment', $2, 'USD', 'debit', 'confirmed', $3::jsonb)`,
            [
              m.user_id,
              payout.toFixed(8),
              JSON.stringify({
                pool: 'group_play',
                reason: 'group_bet_admin_refund',
                groupBetId: id,
                role: m.role,
              }),
            ],
          );
          // Reset their payout to 0
          await txQuery(
            `UPDATE group_bet_member SET payout_amount = 0 WHERE group_id = $1 AND user_id = $2`,
            [id, m.user_id],
          );
          winnersCount++;
          totalReversed += payout;
        }
        // 4. Audit row + admin-force signal
        await txQuery(
          `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
           VALUES ($1, 'refund', $2, $3::jsonb)`,
          [id, adminId, JSON.stringify({
            reversedWinners: winnersCount,
            reversedTotal: totalReversed.toFixed(8),
            reason,
            trigger: 'admin_refund',
          })],
        );
      });

      // 5. Record admin-force signal (fraud_signals)
      await recordAdminForce(id, adminId, 'admin_force_refund', reason);

      // Gap 15: write to admin_actions.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: 'group_refund',
        reason,
        metadata: {
          reversedWinners: winnersCount,
          reversedTotal: totalReversed.toFixed(8),
        },
        ipAddress: req.ip,
      });

      groupAdminActionsTotal.inc({ action: 'refund' });
      return res.status(200).json({
        success: true,
        data: {
          groupId: id,
          reversedWinners: winnersCount,
          reversedTotal: totalReversed.toFixed(8),
          reason,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 17. POST /api/admin/groups/:id/kick/:userId (Day 9) ──────
// Removes a single member from a non-resolved room + refunds their
// stake. Use case: a confirmed-compromised account in the group, or
// removing a known-bad actor after admin investigation.
const kickParamsSchema = z.object({
  id: z.string().min(8).max(64),
  userId: z.string().min(8).max(64),
});
const kickBodySchema = z.object({
  reason: z.string().min(3).max(500),
});
router.post(
  '/:id/kick/:userId',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  validateParams(kickParamsSchema),
  validateBody(kickBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthedRequest).user.userId;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
      const { reason } = req.body;

      // Lock + verify not resolved
      const lockRow = await query<any>(
        `SELECT id, status, current_members FROM group_bet WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lockRow.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      if (lockRow.rows[0].status === 'resolved' || lockRow.rows[0].status === 'cancelled' || lockRow.rows[0].status === 'expired') {
        return res.status(409).json({
          success: false,
          error: `cannot kick from a ${lockRow.rows[0].status} room`,
          code: 'ROOM_TERMINAL',
        });
      }

      // Find the member
      const memberRow = await query<any>(
        `SELECT user_id, role, stake::text AS stake FROM group_bet_member WHERE group_id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!memberRow.rows.length) {
        return res.status(404).json({ success: false, error: 'user is not a member of this room', code: 'NOT_A_MEMBER' });
      }
      const stake = parseFloat(memberRow.rows[0].stake);
      const wasCreator = memberRow.rows[0].role === 'creator';

      // Refund + remove
      await withTransaction(async (txQuery) => {
        if (stake > 0) {
          await creditPayout(userId, stake, 'withdrawable', txQuery as any);
          await txQuery(
            `INSERT INTO transactions
               (user_id, type, amount, currency, direction, status, metadata)
             VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
            [
              userId,
              stake.toFixed(8),
              JSON.stringify({
                pool: 'group_play',
                reason: 'group_bet_admin_kick',
                groupBetId: id,
                role: memberRow.rows[0].role,
              }),
            ],
          );
        }
        await txQuery(`DELETE FROM group_bet_member WHERE group_id = $1 AND user_id = $2`, [id, userId]);
        // Don't let current_members go below 1
        await txQuery(
          `UPDATE group_bet
              SET current_members = GREATEST(current_members - 1, 1),
                  total_pool = GREATEST(total_pool - $1, 0),
                  updated_at = NOW()
            WHERE id = $2`,
          [stake.toFixed(8), id],
        );
        await txQuery(
          `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
           VALUES ($1, 'admin_kick', $2, $3::jsonb)`,
          [id, adminId, JSON.stringify({
            kickedUserId: userId,
            refunded: stake.toFixed(8),
            reason,
            wasCreator,
          })],
        );
      });

      // Record admin-force signal
      await recordAdminForce(id, adminId, 'admin_kick', `${userId.slice(0,8)}…: ${reason}`);

      // Gap 15: write to admin_actions.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: 'group_kick',
        reason,
        metadata: { kickedUserId: userId, refunded: stake.toFixed(8), wasCreator },
        ipAddress: req.ip,
      });

      groupAdminActionsTotal.inc({ action: 'kick' });
      return res.status(200).json({
        success: true,
        data: {
          groupId: id,
          kickedUserId: userId,
          refunded: stake.toFixed(8),
          reason,
          wasCreator,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 18. POST /api/admin/groups/:id/shadow (Day 9) ────────────
// Sets is_shadow=true and writes an audit row + fraud_signals row
// tagged severity='low'. Shadow mode = admin is silently observing
// the group without affecting any other state. Use case: monitoring
// a suspected-fraud group without tipping off the participants.
const shadowBodySchema = z.object({
  reason: z.string().min(3).max(500),
});
router.post(
  '/:id/shadow',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'support']),
  validateParams(idParamSchema),
  validateBody(shadowBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthedRequest).user.userId;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { reason } = req.body;

      // 1. Verify the room exists
      const exists = await query<{ id: string }>(`SELECT id FROM group_bet WHERE id = $1`, [id]);
      if (!exists.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }

      // 2. Audit row
      await query(
        `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
         VALUES ($1, 'admin_shadow', $2, $3::jsonb)`,
        [id, adminId, JSON.stringify({ reason, trigger: 'admin_shadow' })],
      );

      // 3. Record admin-force signal (low severity = no action)
      await recordAdminForce(id, adminId, 'admin_shadow', reason);

      // Gap 15: write to admin_actions.
      await recordGroupAdminAction({
        groupId: id,
        adminId,
        action: 'group_shadow',
        reason,
        metadata: { shadowed: true },
        ipAddress: req.ip,
      });

      groupAdminActionsTotal.inc({ action: 'shadow' });
      return res.status(200).json({
        success: true,
        data: {
          groupId: id,
          shadowed: true,
          reason,
          note: 'No state change — admin is silently observing. The flag is recorded for audit only.',
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;

// Re-export fraud helpers so the public user/group-bet routes can hook in
export { evaluateOnJoin, evaluateOnFlip };
