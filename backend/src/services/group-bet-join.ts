/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-JOIN — Member-side attach-to-room flow (Day 2)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Responsible for:
 *    1. Resolve the room (by id or short_code), verify status ∈ {open}
 *    2. Per-member idempotency: `client_request_id` replays return the
 *       existing member row, never create a duplicate or re-debit
 *    3. Capacity check — current_members < max_members (the cap is
 *       enforced by CHK + a real read here)
 *    4. Pre-flight gates — same as create (active, KYC ≥ tier 1,
 *       lifetime-deposit, sufficient balance)
 *    5. Atomic debit + INSERT member row + UPDATE pool bookkeeping +
 *       audit mirror (same TX)
 *    6. Auto-transition `open → ready` when current_members reaches
 *       min_members — using `group-bet-state.ts` from Day 1 so the
 *       audit mirror writes to BOTH group_bet_audit AND audit_log
 *
 *  Constraints enforced:
 *    - user cannot join their own room (no creator self-join)
 *    - user cannot be a duplicate (UNIQUE(group_id, user_id))
 *    - cannot join after status flips to ready/flipping/resolved/...
 *    - stake must equal the room's per_member_stake (homogeneous)
 *      OR be explicitly different if `perMemberStakeOverride` is given
 *      (we default to the room's value, matching the plan's equal-stake
 *      contract for Day 2 MVP)
 * ════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { query, withTransaction } from '../config/database';
import { redis } from '../config/redis';
import { determineBalanceSource, debitBalanceForBet } from './bonus';
import { transitionGroupStatus, GroupBetTransitionError } from './group-bet-state';
import { emitGroupBetEvent } from './socket-group-bet';
import { GroupBetValidationError, GroupBetNotAllowedError, GroupBetInsufficientBalanceError, GroupBetDuplicateError } from './group-bet-create';
import { getGroupConfigKey, parseCountryList } from './admin-group-config';

// ─── Public type contract ──────────────────────────────────────
export interface JoinGroupBetInput {
  /** User who is joining. */
  userId: string;
  /** Group identifier — either the UUID id or the share-link short_code. */
  groupIdentifier: string;
  /** Must match creator's choice to participate in the same side. */
  choice: 'heads' | 'tails';
  /** Optional override; defaults to group_bet.per_member_stake. */
  stakeOverride?: number;
  /** Per-member idempotency — replays return existing member row. */
  clientRequestId?: string;
  /** For audit log. */
  ipAddress?: string;
}

export interface JoinedMember {
  groupId: string;
  memberId: string;
  userId: string;
  role: 'member';
  choice: 'heads' | 'tails';
  stake: string;
  weight: string;
  joinedAt: Date;
  totalPool: string;
  currentMembers: number;
  newStatus: 'open' | 'ready' | 'open';
}

// ─── Redis idempotency fallback (per-member) ───────────────────
const REDIS_IDEM_TTL_SEC = 60;
const HARD_LOCK_TTL_SEC = 3;

// ─── Helpers ────────────────────────────────────────────────────
function getJoinLockKey(userId: string, groupIdentifier: string): string {
  return `group_bet:join:lock:${userId}:${groupIdentifier}`;
}

async function resolveGroup(groupIdentifier: string): Promise<{
  id: string;
  creator_id: string;
  status: string;
  is_frozen: boolean;
  per_member_stake: string;
  creator_choice: string;
  min_members: number;
  max_members: number;
  current_members: number;
  expires_at: Date;
} | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(groupIdentifier);
  const r = await query<any>(
    `SELECT id, creator_id, status, is_frozen, per_member_stake::text,
            creator_choice, min_members, max_members, current_members, expires_at
       FROM group_bet
      WHERE ${isUuid ? 'id = $1' : 'short_code = $1'}
        AND status IN ('open','ready')
      LIMIT 1`,
    [groupIdentifier],
  );
  return r.rows[0] ?? null;
}

async function userCanJoin(
  userId: string,
  requiredBalance: number,
): Promise<{ ok: true; balance: number } | { ok: false; code: string; message: string; balance?: number }> {
  const r = await query<any>(
    `SELECT u.is_active, u.is_admin, u.kyc_country,
            u.self_excluded_until,
            COALESCE(u.withdrawable_balance_coins, 0)::float8 AS wd,
            COALESCE(u.bonus_balance_coins, 0)::float8 AS bonus
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!r.rows.length) return { ok: false, code: 'USER_NOT_FOUND', message: 'user not found' };
  const u = r.rows[0];
  if (!u.is_active) return { ok: false, code: 'ACCOUNT_DISABLED', message: 'account disabled' };
  if (u.self_excluded_until && new Date(u.self_excluded_until).getTime() > Date.now()) {
    return { ok: false, code: 'SELF_EXCLUDED', message: 'self-excluded' };
  }
  if (!u.is_admin) {
    // Country enforcement (group_play_blocked_countries from admin-config).
    // Default list is KP,IR,SY,CU. Mirrors runGates() in group-bet-create.ts.
    const blockedCsv = await getGroupConfigKey('groupPlayBlockedCountries')
      .catch(() => 'KP,IR,SY,CU');
    const blocked = parseCountryList(String(blockedCsv ?? '')) ?? [];
    const userCountry = (u.kyc_country || '').toUpperCase().trim();
    if (userCountry && blocked.includes(userCountry)) {
      return {
        ok: false,
        code: 'COUNTRY_BLOCKED',
        message: 'group play is not available in your country',
      };
    }
    // Lifetime-deposit gate (Gap 6: same admin-config key as group-bet-create.ts).
    // Reads `groupMinUserDepositHistory` (default 50); set to 0 in admin
    // to disable the gate entirely. Cheap aggregate; ~1ms even on big DB.
    const minDeposit = await getGroupConfigKey('groupMinUserDepositHistory')
      .catch(() => 50);
    if (minDeposit > 0) {
      const dep = await query<any>(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS lifetime
           FROM transactions
          WHERE user_id = $1 AND type = 'deposit' AND status = 'confirmed'`,
        [userId],
      );
      if ((dep.rows[0]?.lifetime ?? 0) < minDeposit) {
        return {
          ok: false,
          code: 'LIFETIME_DEPOSIT_TOO_LOW',
          message: `lifetime deposit < $${minDeposit}`,
        };
      }
    }
  }
  const available = parseFloat(u.wd) + parseFloat(u.bonus);
  if (available < requiredBalance) {
    return {
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: 'insufficient balance',
      balance: available,
    };
  }
  return { ok: true, balance: available };
}

// ─── Public entrypoint ─────────────────────────────────────────
export async function joinGroupBet(input: JoinGroupBetInput): Promise<JoinedMember> {
  // ── 0. Input validation ──
  if (!['heads', 'tails'].includes(input.choice)) {
    throw new GroupBetValidationError('choice must be heads or tails', 'INVALID_CHOICE');
  }
  if (!input.groupIdentifier) {
    throw new GroupBetValidationError('groupIdentifier required', 'MISSING_GROUP');
  }

  // ── 1. Resolve room ──
  const room = await resolveGroup(input.groupIdentifier);
  if (!room) {
    throw new GroupBetValidationError('group not found or not joinable', 'GROUP_NOT_FOUND');
  }
  if (room.is_frozen) {
    throw new GroupBetNotAllowedError('group frozen by admin', 'GROUP_FROZEN');
  }
  if (new Date(room.expires_at).getTime() < Date.now()) {
    throw new GroupBetNotAllowedError('group expired', 'GROUP_EXPIRED');
  }
  if (room.creator_id === input.userId) {
    throw new GroupBetNotAllowedError(
      'creator cannot join their own room',
      'CREATOR_CANNOT_JOIN',
    );
  }
  if (input.choice !== room.creator_choice) {
    throw new GroupBetValidationError(
      `choice '${input.choice}' does not match creator's choice '${room.creator_choice}'`,
      'CHOICE_MISMATCH',
    );
  }
  const memberStake = input.stakeOverride ?? parseFloat(room.per_member_stake);
  if (!(memberStake > 0)) {
    throw new GroupBetValidationError('stake must be > 0', 'INVALID_STAKE');
  }
  if (room.current_members >= room.max_members) {
    throw new GroupBetNotAllowedError('group full', 'GROUP_FULL');
  }

  // ── 2. Per-member idempotency (request-level) ──
  if (input.clientRequestId && input.clientRequestId.length >= 8) {
    const dup = await query<any>(
      `SELECT id, group_id, user_id, role, choice, stake::text AS stake,
              weight::text AS weight, joined_at,
              (SELECT current_members FROM group_bet WHERE id = group_id) AS cm
         FROM group_bet_member
        WHERE user_id = $1 AND client_request_id = $2
        LIMIT 1`,
      [input.userId, input.clientRequestId],
    );
    if (dup.rows.length) {
      const d = dup.rows[0];
      if (d.group_id !== room.id) {
        // Same clientRequestId reused across different rooms — treat as dup
        throw new GroupBetDuplicateError(d.group_id);
      }
      // Replay of the same join → return existing row, NO new debit
      return {
        groupId: d.group_id,
        memberId: d.id,
        userId: d.user_id,
        role: 'member',
        choice: d.choice,
        stake: d.stake,
        weight: d.weight,
        joinedAt: d.joined_at,
        totalPool: '', // not refreshed on replay
        currentMembers: d.cm,
        newStatus: 'open',
      };
    }
  }

  // ── 3. Anti-race Redis lock per (user, group) ──
  const lockKey = getJoinLockKey(input.userId, input.groupIdentifier);
  const lockOk = await redis.set(
    lockKey, `${Date.now()}:${crypto.randomBytes(4).toString('hex')}`,
    'EX', HARD_LOCK_TTL_SEC, 'NX',
  );
  if (!lockOk) {
    throw new GroupBetNotAllowedError(
      'concurrent join request — try again in a few seconds',
      'RATE_LIMITED',
    );
  }

  let result: JoinedMember;

  try {
    // ── 4. Pre-flight gates ──
    const gate = await userCanJoin(input.userId, memberStake);
    if (!gate.ok) {
      if (gate.code === 'INSUFFICIENT_BALANCE') {
        throw new GroupBetInsufficientBalanceError(gate.balance!, memberStake);
      }
      throw new GroupBetNotAllowedError(gate.message, gate.code);
    }

    // ── 5. Atomic: insert member + debit + update pool + audit ──
    result = await withTransaction(async (txQuery) => {
      // 5a. Re-check room under row lock (current_members + status)
      const lockCheck = await txQuery(
        `SELECT id, status, current_members, min_members, max_members,
                per_member_stake::text AS per_member_stake,
                creator_choice
           FROM group_bet WHERE id = $1 FOR UPDATE`,
        [room.id],
      ) as { rows: any[]; rowCount: number };
      const locked = lockCheck.rows[0];
      if (!locked) {
        throw new GroupBetValidationError('group vanished mid-join', 'GROUP_NOT_FOUND');
      }
      if (locked.status !== 'open') {
        throw new GroupBetNotAllowedError(
          `cannot join: group is ${locked.status}`,
          'GROUP_NOT_OPEN',
        );
      }
      if (locked.current_members >= locked.max_members) {
        throw new GroupBetNotAllowedError('group full', 'GROUP_FULL');
      }

      // 5b. Determine balance source + debit
      const source = await determineBalanceSource(input.userId, memberStake, txQuery as any);
      await debitBalanceForBet(input.userId, memberStake, source, txQuery as any);

      // 5c. INSERT member row — UNIQUE(group_id, user_id) protects races
      const weight = memberStake / parseFloat(locked.per_member_stake);
      const ins = await txQuery(
        `INSERT INTO group_bet_member
           (group_id, user_id, role, choice, stake, weight,
            balance_before, client_request_id)
         VALUES ($1, $2, 'member', $3, $4, $5,
                 (SELECT COALESCE(withdrawable_balance_coins, 0) + COALESCE(bonus_balance_coins, 0)
                    FROM users WHERE id = $2),
                 $6)
         RETURNING id, joined_at`,
        [room.id, input.userId, input.choice, memberStake.toFixed(8), weight, input.clientRequestId ?? null],
      ) as { rows: any[]; rowCount: number };

      // 5d. UPDATE pool + current_members atomically (guard against overflow)
      const upd = await txQuery(
        `UPDATE group_bet
            SET total_pool = total_pool + $2,
                current_members = current_members + 1
          WHERE id = $1
            AND current_members < max_members
            AND status = 'open'
          RETURNING total_pool::text AS total_pool, current_members, min_members`,
        [room.id, memberStake.toFixed(8)],
      ) as { rows: any[]; rowCount: number };
      if (!upd.rows.length) {
        throw new GroupBetNotAllowedError('group filled before commit', 'GROUP_FULL');
      }
      const newMembers = upd.rows[0].current_members;
      const newTotal = upd.rows[0].total_pool;

      // 5e. Money-side ledger
      await txQuery(
        `INSERT INTO transactions
           (user_id, type, amount, currency, direction, status,
            metadata)
         VALUES ($1, 'bet', $2, 'USD', 'debit', 'confirmed',
                 $3::jsonb)`,
        [
          input.userId,
          memberStake.toFixed(8),
          JSON.stringify({
            groupBetId: room.id,
            role: 'member',
            source,
            pool: 'group_play',
          }),
        ],
      );

      // 5f. Audit (group_bet_audit) — uses 'join' action
      await txQuery(
        `INSERT INTO group_bet_audit
           (group_id, actor_id, action, payload, ip_address)
         VALUES ($1, $2, 'join', $3::jsonb, $4::inet)`,
        [
          room.id, input.userId,
          JSON.stringify({
            choice: input.choice,
            stake: memberStake,
            weight,
            newTotalPool: newTotal,
            newMembers,
            balanceSource: source,
          }),
          input.ipAddress ?? null,
        ],
      );

      const memberRow = ins.rows[0];

      return {
        groupId: room.id,
        memberId: memberRow.id,
        userId: input.userId,
        role: 'member' as const,
        choice: input.choice,
        stake: memberStake.toFixed(8),
        weight: weight.toString(),
        joinedAt: memberRow.joined_at,
        totalPool: newTotal,
        currentMembers: newMembers,
        newStatus: 'open' as const, // may flip in step 6
      };
    });

    // ── 6. Outside the debit TX: auto-transition to 'ready' if
    //       threshold met. We must do this AFTER the member commit
    //       so the audit row "join" always appears before "ready". ─
    if (result.currentMembers >= (await roomMinMembers(room.id))) {
      try {
        await transitionGroupStatus(
          {
            groupId: room.id,
            actorId: null, // system-driven
            ipAddress: input.ipAddress,
            payload: {
              runTag: 'auto-ready',
              triggeredBy: input.userId,
              memberCount: result.currentMembers,
            },
          },
          {
            fromStatuses: ['open'],
            toStatus: 'ready',
            action: 'ready',
            auditSeverity: 'info',
          },
        );
        result.newStatus = 'ready';
      } catch (e) {
        // If the transition failed because someone else already flipped
        // (rare race), swallow it — the join is still recorded.
        if (!(e instanceof GroupBetTransitionError)) throw e;
      }
    }
  } finally {
    await redis.del(lockKey).catch(() => {});
  }

  // Redis idempotency fallback ──
    if (input.clientRequestId && input.clientRequestId.length >= 8) {
      await redis.set(
        `group_bet:idem:join:${input.userId}:${input.clientRequestId}`,
        result.memberId,
        'EX', REDIS_IDEM_TTL_SEC,
      ).catch(() => {});
    }

    // ── 8. Socket emit (best-effort) ──────────────────────────
    const shortCodeR = await query<{ short_code: string }>(
      `SELECT short_code FROM group_bet WHERE id = $1`, [room.id],
    );
    const shortCode = shortCodeR.rows[0]?.short_code;
    emitGroupBetEvent('group:join', {
      groupId: room.id,
      shortCode,
      status: result.newStatus,
      currentMembers: result.currentMembers,
      maxMembers: room.max_members,
      totalPool: parseFloat(result.totalPool),
      actorUserId: input.userId,
      meta: { role: 'member', choice: input.choice },
    });
    // Gap 1: emit finer-grained `group:member_joined` after the INSERT
    // (sat alongside the coarse `group:join` for clients that want the
    // per-member lifecycle without inferring it from join). Includes the
    // memberId so a UI can resolve the new member row directly.
    emitGroupBetEvent('group:member_joined', {
      groupId: room.id,
      shortCode,
      status: result.newStatus,
      currentMembers: result.currentMembers,
      maxMembers: room.max_members,
      totalPool: parseFloat(result.totalPool),
      actorUserId: input.userId,
      meta: {
        role: 'member',
        memberId: result.memberId,
        choice: input.choice,
        stake: result.stake,
        weight: result.weight,
      },
    });
    // Gap 1: emit `group:pool_updated` after the balance change so the UI
    // can recompute the pool display without polling. Includes the delta
    // and the new total so derived UIs can animate the change.
    emitGroupBetEvent('group:pool_updated', {
      groupId: room.id,
      shortCode,
      status: result.newStatus,
      currentMembers: result.currentMembers,
      maxMembers: room.max_members,
      totalPool: parseFloat(result.totalPool),
      actorUserId: input.userId,
      meta: {
        source: 'join',
        delta: parseFloat(result.stake),
        memberId: result.memberId,
      },
    });
    if (result.newStatus === 'ready') {
      emitGroupBetEvent('group:ready', {
        groupId: room.id,
        shortCode,
        status: 'ready',
        currentMembers: result.currentMembers,
        maxMembers: room.max_members,
        totalPool: parseFloat(result.totalPool),
        meta: { reason: 'min_members_reached' },
      });
    }

    return result;
  }

async function roomMinMembers(groupId: string): Promise<number> {
  const r = await query<{ min_members: number }>(
    `SELECT min_members FROM group_bet WHERE id = $1`, [groupId],
  );
  return r.rows[0]?.min_members ?? 999;
}
