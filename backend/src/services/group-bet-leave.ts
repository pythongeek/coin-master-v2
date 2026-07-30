/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-LEAVE — Member-side leave + creator cancel flow (Phase 1 / Day 6)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Two flows:
 *
 *  A. Member leaves an OPEN room (status='open' only):
 *     - Refund their stake via `creditPayout(user, stake, 'withdrawable')`
 *     - DELETE their group_bet_member row
 *     - DECREMENT group_bet.current_members + total_pool
 *     - Refuse if status !== 'open' (i.e., room is ready/flipping/resolved)
 *
 *  B. Creator cancels their OWN room:
 *     - Allowed only when status IN ('open', 'ready')
 *     - Refunds ALL members (creator + N members)
 *     - Flips status to 'cancelled' via Day-1 state machine
 *     - When cancelling a 'ready' room, the creator forfeits no penalty
 *       (matches Phase 1 §5 spec)
 *
 *  Both flows write to:
 *    - group_bet_audit (action='leave' / 'creator_cancel')
 *    - audit_log (category='group_play', severity='info')
 *    - transactions(type='admin_adjustment', direction='credit') per refund
 *
 *  Both flows emit socket events via `emitGroupBetEvent`:
 *    - `group:leave` (single member left)
 *    - `group:cancelled` (full cancel)
 *    - `group:updated` (state changed)
 * ════════════════════════════════════════════════════════════════
 */

import { query, withTransaction } from '../config/database';
import { creditPayout } from './bonus';
import { transitionGroupStatus, GroupBetTransitionError } from './group-bet-state';
import { emitGroupBetEvent } from './socket-group-bet';

// ─── Errors ────────────────────────────────────────────────────
export class GroupBetLeaveError extends Error {
  code: 'GROUP_NOT_FOUND' | 'NOT_A_MEMBER' | 'CANNOT_LEAVE' | 'ROOM_NOT_OPEN' | 'NOT_CREATOR' | 'ALREADY_RESOLVED';
  constructor(code: GroupBetLeaveError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface LeaveResult {
  groupId: string;
  refundedAmount: number;
  remainingMembers: number;
  status: string;
  wasCreator: boolean;
}

// ─── A. Member leaves an OPEN room ─────────────────────────────
export async function leaveGroupBet(
  groupId: string,
  userId: string,
  ipAddress: string | null = null,
): Promise<LeaveResult> {
  let refunded = 0;
  let remainingMembers = 0;
  let status = 'open';
  let wasCreator = false;
  let shortCode: string | undefined;
  let payload: any;

  try {
    await withTransaction(async (txQuery) => {
      // 1. Lock the row + status check
      const r = await txQuery(
        `SELECT creator_id, status, current_members, total_pool::text AS total_pool,
                per_member_stake::text AS per_member_stake, creator_stake::text AS creator_stake,
                short_code
           FROM group_bet WHERE id = $1 FOR UPDATE`,
        [groupId],
      );
      if (!r.rows.length) throw new GroupBetLeaveError('GROUP_NOT_FOUND', 'Group not found.');
      const row = r.rows[0];

      if (row.status !== 'open') {
        throw new GroupBetLeaveError(
          'ROOM_NOT_OPEN',
          `Cannot leave a room in status '${row.status}'.`,
        );
      }
      status = row.status;
      shortCode = row.short_code;

      // 2. Find the member row
      const memberRow = await txQuery(
        `SELECT user_id, role, stake::text AS stake
           FROM group_bet_member
          WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
      if (!memberRow.rows.length) {
        throw new GroupBetLeaveError('NOT_A_MEMBER', 'You are not a member of this room.');
      }
      const stake = parseFloat(memberRow.rows[0].stake);
      wasCreator = memberRow.rows[0].role === 'creator';

      // 3. Refund the stake
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
              reason: 'group_bet_member_leave',
              groupBetId: groupId,
              role: memberRow.rows[0].role,
            }),
          ],
        );
        refunded = stake;
      }

      // 4. DELETE the member row + DECREMENT counts
      await txQuery(`DELETE FROM group_bet_member WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
      await txQuery(
        `UPDATE group_bet
            SET current_members = current_members - 1,
                total_pool = GREATEST(total_pool - $1, 0),
                updated_at = NOW()
          WHERE id = $2`,
        [stake.toFixed(8), groupId],
      );
      remainingMembers = row.current_members - 1;

      // 5. Audit mirror
      await txQuery(
        `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
         VALUES ($1, 'leave', $2, $3::jsonb)`,
        [groupId, userId, JSON.stringify({
          refunded: refunded.toFixed(8),
          remainingMembers,
          role: memberRow.rows[0].role,
        })],
      );
      payload = {
        refunded: refunded.toFixed(8),
        remainingMembers,
        role: memberRow.rows[0].role,
      };
    });
  } catch (e) {
    if (e instanceof GroupBetLeaveError) throw e;
    throw e;
  }

  // 6. Emit socket events (after commit — no risk of broadcasting a state that gets rolled back)
  emitGroupBetEvent('group:leave', {
    groupId,
    shortCode,
    status,
    currentMembers: remainingMembers,
    actorUserId: userId,
    meta: { refunded: refunded.toFixed(8), role: payload?.role },
  });
  emitGroupBetEvent('group:updated', {
    groupId,
    shortCode,
    status,
    currentMembers: remainingMembers,
  });

  return {
    groupId,
    refundedAmount: refunded,
    remainingMembers,
    status,
    wasCreator,
  };
}

// ─── B. Creator cancels their OWN room ─────────────────────────
export async function cancelGroupBet(
  groupId: string,
  creatorId: string,
  reason: string,
  ipAddress: string | null = null,
): Promise<{ refundedMembers: number; refundedTotal: number; status: string }> {
  let totalRefunded = 0;
  let memberCount = 0;
  let shortCode: string | undefined;
  let status = 'open';

  // 1. Refund all members
  await withTransaction(async (txQuery) => {
    const g = await txQuery(
      `SELECT creator_id, status, short_code FROM group_bet WHERE id = $1 FOR UPDATE`,
      [groupId],
    );
    if (!g.rows.length) throw new GroupBetLeaveError('GROUP_NOT_FOUND', 'Group not found.');
    const row = g.rows[0];
    if (row.creator_id !== creatorId) {
      throw new GroupBetLeaveError('NOT_CREATOR', 'Only the creator can cancel.');
    }
    if (!['open', 'ready'].includes(row.status)) {
      throw new GroupBetLeaveError(
        'ALREADY_RESOLVED',
        `Cannot cancel a room in status '${row.status}'.`,
      );
    }
    status = row.status;
    shortCode = row.short_code;

    const members = await txQuery(
      `SELECT user_id, role, stake::text AS stake
         FROM group_bet_member WHERE group_id = $1 ORDER BY joined_at ASC`,
      [groupId],
    );

    for (const m of members.rows) {
      const stake = parseFloat(m.stake);
      if (!(stake > 0)) continue;
      await creditPayout(m.user_id, stake, 'withdrawable', txQuery as any);
      await txQuery(
        `INSERT INTO transactions
           (user_id, type, amount, currency, direction, status, metadata)
         VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
        [
          m.user_id,
          stake.toFixed(8),
          JSON.stringify({
            pool: 'group_play',
            reason: 'group_bet_creator_cancel',
            groupBetId: groupId,
            role: m.role,
          }),
        ],
      );
      memberCount++;
      totalRefunded += stake;
    }

    // Audit mirror
    await txQuery(
      `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
       VALUES ($1, 'creator_cancel', $2, $3::jsonb)`,
      [groupId, creatorId, JSON.stringify({
        refundedMembers: memberCount,
        refundedTotal: totalRefunded.toFixed(8),
        reason: reason.slice(0, 200),
        fromStatus: status,
      })],
    );
  });

  // 2. Transition status → cancelled via Day-1 state machine
  try {
    await transitionGroupStatus(
      {
        groupId,
        actorId: creatorId,
        ipAddress,
        payload: {
          refundedMembers: memberCount,
          refundedTotal: totalRefunded.toFixed(8),
          reason,
          trigger: 'creator_cancel',
        },
      },
      {
        fromStatuses: ['open', 'ready'],
        toStatus: 'cancelled',
        action: 'creator_cancel',
        auditSeverity: 'info',
      },
    );
    status = 'cancelled';
  } catch (e) {
    // If state-machine refuses (race with admin force-cancel), still
    // surface the result — the refunds already succeeded.
    if (!(e instanceof GroupBetTransitionError)) throw e;
  }

  // 3. Emit socket events
  emitGroupBetEvent('group:cancelled', {
    groupId,
    shortCode,
    status,
    actorUserId: creatorId,
    meta: {
      refundedMembers: memberCount,
      refundedTotal: totalRefunded.toFixed(8),
      reason,
    },
  });
  emitGroupBetEvent('group:updated', {
    groupId,
    shortCode,
    status,
    currentMembers: memberCount,
  });

  return {
    refundedMembers: memberCount,
    refundedTotal: Number(totalRefunded.toFixed(8)),
    status,
  };
}

// ─── Manual freeze (admin-initiated via this service for users) ─
export function emitFreezeEvent(groupId: string, adminId: string, reason: string): void {
  emitGroupBetEvent('group:frozen', {
    groupId,
    actorUserId: adminId,
    meta: { reason: reason.slice(0, 200) },
  });
  emitGroupBetEvent('group:updated', {
    groupId,
    meta: { is_frozen: true },
  });
}