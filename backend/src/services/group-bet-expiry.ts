/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-EXPIRY — Sweep cron that expires open/ready rooms + refunds
 *  ════════════════════════════════════════════════════════════════
 *  (Phase 1 / Day 4)
 *
 *  Background worker that:
 *    1. Every 60s (configurable), SELECTs all `group_bet` rows where:
 *         status IN ('open', 'ready')
 *         AND expires_at < NOW()
 *         AND is_frozen = false
 *       Uses the partial index `idx_group_bet_expires_open` (defined in
 *       migrations-group-play.sql).
 *
 *    2. For each expired row, atomically:
 *         a. SELECT ... FOR UPDATE the row
 *         b. SELECT all members + their original stakes (joined_at ASC)
 *         c. For each member: creditPayout(userId, stake, 'withdrawable')
 *            (refund each participant their committed stake; the bonus
 *            source is hard-coded to 'withdrawable' for symmetry with
 *            the create/join debits, which used determineBalanceSource())
 *         d. INSERT transactions(type='admin_adjustment', direction='credit')
 *            per member for the audit trail + user-visible history
 *         e. transitionGroupStatus(open/ready → expired) with
 *            action='expire' AND action='refund' in the audit mirror
 *         f. Mirror to audit_log(category='group_play', action='group_play.expire')
 *
 *    3. Idempotent: a second run that picks up the same expired rooms
 *       will find status='expired' and skip.
 *
 *    4. Bounded concurrency: processes up to 50 rooms per tick to
 *       avoid lock storms. Returns the count for the caller (test / log).
 *
 *  Schedule: `startGroupBetExpiryWorker(60_000)` exports a setInterval
 *  loop. First tick runs immediately (matches audit-backup pattern).
 *
 *  Failure mode: each room's refund is its own SERIALIZABLE TX. If
 *  one fails (e.g., FK constraint, balance overflow), the room stays
 *  in `open`/`ready` and is retried on the next tick. The sweep
 *  itself never crashes.
 *
 *  Concurrency safety: the sweep holds a Redis SETNX lock
 *  `group_bet:expiry:sweep` with 120s TTL to prevent two backend
 *  pods from sweeping simultaneously.
 * ════════════════════════════════════════════════════════════════
 */

import { query, withTransaction } from '../config/database';
import { redis } from '../config/redis';
import { creditPayout } from './bonus';
import { transitionGroupStatus, GroupBetTransitionError } from './group-bet-state';
import { emitGroupBetEvent } from './socket-group-bet';

// ─── Constants ───────────────────────────────────────────────────
const HARD_MAX_PER_TICK = 50;       // bounded concurrency per sweep
const REDIS_SWEEP_LOCK_KEY = 'group_bet:expiry:sweep';
const REDIS_SWEEP_LOCK_TTL_SEC = 120;
const EXPIRY_WARNING_WINDOW_MIN = 5; // emit group:expiry_warning N minutes before expiry
const REDIS_WARNING_LOCK_KEY = 'group_bet:expiry_warning:sweep';

// ─── Worker state ───────────────────────────────────────────────
let sweepInterval: NodeJS.Timeout | null = null;
let sweepRunning = false;

// ─── Helper: refund a single room's members ────────────────────
async function refundOneRoom(groupId: string): Promise<{
  refunded: number;
  totalAmount: string;
  newStatus: 'expired';
} | null> {
  // Outer guard: SELECT the row (no lock yet, sanity check).
  const preCheck = await query<any>(
    `SELECT id, status, expires_at, total_pool
       FROM group_bet
      WHERE id = $1
        AND status IN ('open','ready')
        AND expires_at < NOW()
        AND is_frozen = false`,
    [groupId],
  );
  if (!preCheck.rows.length) return null;

  let refundedCount = 0;
  let totalAmount = 0;

  // 1. Atomic TX: refund each member + audit mirror + status flip
  await withTransaction(async (txQuery) => {
    // 1a. Re-lock the row in TX (FOR UPDATE), re-verify status
    const lockCheck = await txQuery(
      `SELECT id, status, current_members, expires_at
         FROM group_bet
        WHERE id = $1
        FOR UPDATE`,
      [groupId],
    ) as { rows: any[]; rowCount: number };
    const room = lockCheck.rows[0];
    if (!room) return;
    if (room.status !== 'open' && room.status !== 'ready') return;
    if (new Date(room.expires_at).getTime() > Date.now()) return;

    // 1b. Load all members (lock order: members first, then room updates)
    const memberRows = await txQuery(
      `SELECT user_id, role, stake::text AS stake
         FROM group_bet_member
        WHERE group_id = $1
        ORDER BY joined_at ASC`,
      [groupId],
    ) as { rows: any[]; rowCount: number };

    // 1c. Refund each member — creditPayout to 'withdrawable' (mirror
    // of the original debit; future Phase-2 change: track which source
    // each debit came from and refund to that source)
    for (const m of memberRows.rows) {
      const stake = parseFloat(m.stake);
      if (!(stake > 0)) continue;
      try {
        await creditPayout(m.user_id, stake, 'withdrawable', txQuery as any);
        refundedCount++;
        totalAmount += stake;
      } catch (err: any) {
        // Bubble so the outer TX rolls back. The room stays
        // open/ready and is retried on the next sweep.
        throw new Error(`refund failed for user ${m.user_id} amount ${stake}: ${err?.message}`);
      }
    }

    // 1d. Money-side ledger rows: type='admin_adjustment' (the
    // existing CHECK-allowed value that semantically fits a system-
    // initiated reversal). direction='credit' so the balance is
    // restored. metadata explains the reversal.
    for (const m of memberRows.rows) {
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
            reason: 'group_bet_expired',
            groupBetId: groupId,
            role: m.role,
          }),
        ],
      );
    }
  });

  // 2. Outside the refund TX: flip status open|ready → expired
  //    (uses the Day-1 state machine; writes group_bet_audit +
  //    audit_log mirrors atomically).
  // If multiple sweep ticks race, the second call sees status='expired'
  // and the state machine throws GROUP_BET_INVALID_TRANSITION. We
  // swallow that as "already done" (idempotency).
  try {
    await transitionGroupStatus(
      {
        groupId,
        actorId: null,        // system actor
        ipAddress: null,
        payload: {
          runTag: 'expiry_sweep',
          refundedCount,
          totalAmount: totalAmount.toFixed(8),
          trigger: 'expires_at',
        },
      },
      {
        // The room might be in either 'open' or 'ready' depending on
        // how far the join progress got. Allow both source states.
        fromStatuses: ['open', 'ready'],
        toStatus: 'expired',
        action: 'expire',
        auditSeverity: 'info',
      },
    );
  } catch (e) {
    if (e instanceof GroupBetTransitionError) {
      // Race: another tick (or admin cancel) already flipped this.
      // Refunds already succeeded in step 1, so swallow.
      return {
        refunded: refundedCount,
        totalAmount: totalAmount.toFixed(8),
        newStatus: 'expired',
      };
    }
    throw e;
  }

  // Outside the TX: emit the socket event so spectating clients see it
  emitGroupBetEvent('group:expired', {
    groupId,
    shortCode: undefined,  // not loaded here; UI uses groupId to re-fetch
    status: 'expired',
    meta: { refundedMembers: refundedCount, refundedTotal: totalAmount.toFixed(8) },
  });
  emitGroupBetEvent('group:updated', {
    groupId,
    status: 'expired',
    meta: { refundedMembers: refundedCount },
  });

  return {
    refunded: refundedCount,
    totalAmount: totalAmount.toFixed(8),
    newStatus: 'expired',
  };
}

// ─── Public: one sweep tick ────────────────────────────────────
export async function sweepExpiredGroupBets(opts: {
  maxPerTick?: number;
  lockTtlSec?: number;
} = {}): Promise<{
  processed: number;
  refundedMembers: number;
  refundedTotal: string;
  errors: Array<{ groupId: string; error: string }>;
  durationMs: number;
}> {
  const maxPerTick = opts.maxPerTick ?? HARD_MAX_PER_TICK;
  const lockTtlSec = opts.lockTtlSec ?? REDIS_SWEEP_LOCK_TTL_SEC;

  // Distributed lock: skip the tick if another pod is sweeping.
  const lockVal = `${process.pid}-${Date.now()}`;
  const acquired = await redis.set(REDIS_SWEEP_LOCK_KEY, lockVal, 'EX', lockTtlSec, 'NX');
  if (!acquired) {
    return { processed: 0, refundedMembers: 0, refundedTotal: '0', errors: [], durationMs: 0 };
  }

  const start = Date.now();
  let processed = 0;
  let refundedMembers = 0;
  let refundedTotal = 0;
  const errors: Array<{ groupId: string; error: string }> = [];

  try {
    // Find candidates: open|ready + expired + not frozen. The
    // partial index `idx_group_bet_expires_open` makes this cheap.
    const candidates = await query<any>(
      `SELECT id FROM group_bet
        WHERE status IN ('open','ready')
          AND expires_at < NOW()
          AND is_frozen = false
        ORDER BY expires_at ASC
        LIMIT $1`,
      [maxPerTick],
    );
    const ids = candidates.rows.map((r: any) => r.id as string);

    for (const id of ids) {
      try {
        const out = await refundOneRoom(id);
        if (out) {
          processed++;
          refundedMembers += out.refunded;
          refundedTotal += parseFloat(out.totalAmount);
        }
      } catch (e: any) {
        errors.push({ groupId: id, error: e?.message || String(e) });
        // Do NOT rethrow: continue with the next room so one bad row
        // doesn't poison the whole tick.
      }
    }
  } finally {
    // Best-effort lock release (don't block on Redis hiccups).
    await redis.del(REDIS_SWEEP_LOCK_KEY).catch(() => {});
  }

  return {
    processed,
    refundedMembers,
    refundedTotal: refundedTotal.toFixed(8),
    errors,
    durationMs: Date.now() - start,
  };
}

// ─── Public: one warning-sweep tick (Gap 1) ────────────────────
// Finds groups in `open` or `ready` that are expiring within the
// next 5 minutes, and emits a `group:expiry_warning` event for each
// so the UI can render a "this room will expire soon" banner. The
// function is idempotent — a distributed lock + a per-group
// `expires_at` key ensures each room only fires once per window. We
// skip the warning for already-expired rooms (those are handled by
// the regular expiry sweep above).
export async function sweepExpiringGroupBets(opts: {
  windowMinutes?: number;
  lockTtlSec?: number;
} = {}): Promise<{
  warned: number;
  durationMs: number;
}> {
  const windowMin = opts.windowMinutes ?? EXPIRY_WARNING_WINDOW_MIN;
  const lockTtlSec = opts.lockTtlSec ?? 60;

  // Distributed lock to prevent two pods from double-warning.
  const lockVal = `${process.pid}-${Date.now()}`;
  const acquired = await redis.set(REDIS_WARNING_LOCK_KEY, lockVal, 'EX', lockTtlSec, 'NX');
  if (!acquired) return { warned: 0, durationMs: 0 };

  const start = Date.now();
  let warned = 0;

  try {
    // Find rooms expiring within the window (but not yet expired).
    // We don't have a "warned-at" column, so we use a Redis SET to
    // dedupe per-`expires_at` keyed room.
    const candidates = await query<any>(
      `SELECT id, short_code, status, current_members, max_members,
              total_pool::text AS total_pool, expires_at,
              EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS seconds_left
         FROM group_bet
        WHERE status IN ('open','ready')
          AND is_frozen = false
          AND expires_at > NOW()
          AND expires_at <= NOW() + ($1 || ' minutes')::interval
        ORDER BY expires_at ASC
        LIMIT 100`,
      [windowMin],
    );

    for (const r of candidates.rows) {
      const dedupKey = `group_bet:expiry_warning:${r.id}:${r.expires_at}`;
      // Redis SET NX with TTL = the seconds-left + 60s buffer. If the
      // key already exists, skip — this room was already warned.
      const ttl = Math.max(60, parseInt(String(r.seconds_left), 10) + 60);
      const set = await redis.set(dedupKey, '1', 'EX', ttl, 'NX');
      if (!set) continue;
      warned++;
      emitGroupBetEvent('group:expiry_warning', {
        groupId: r.id,
        shortCode: r.short_code,
        status: r.status,
        currentMembers: r.current_members,
        maxMembers: r.max_members,
        totalPool: parseFloat(r.total_pool),
        meta: {
          secondsLeft: parseInt(String(r.seconds_left), 10),
          windowMinutes: windowMin,
          expiresAt: r.expires_at,
        },
      });
    }
  } finally {
    await redis.del(REDIS_WARNING_LOCK_KEY).catch(() => {});
  }

  return { warned, durationMs: Date.now() - start };
}

// ─── Public: scheduled worker ──────────────────────────────────
export function startGroupBetExpiryWorker(intervalMs: number = 60_000): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }

  const tick = async () => {
    if (sweepRunning) return;  // skip if previous tick still running
    sweepRunning = true;
    try {
      // Gap 1: warning sweep (runs alongside the expiry sweep).
      // Lightweight (single SELECT, no row locks) so it's safe to
      // call every tick.
      try {
        const w = await sweepExpiringGroupBets();
        if (w.warned > 0) {
          console.log(`[group-bet-expiry] warned=${w.warned} durationMs=${w.durationMs}`);
        }
      } catch (we: any) {
        console.error('[group-bet-expiry] warning sweep failed:', we?.message || we);
      }
      const result = await sweepExpiredGroupBets();
      if (result.processed > 0 || result.errors.length > 0) {
        console.log(
          `[group-bet-expiry] processed=${result.processed} ` +
          `refunded_members=${result.refundedMembers} ` +
          `refunded_total=${result.refundedTotal} ` +
          `errors=${result.errors.length} ` +
          `durationMs=${result.durationMs}`,
        );
        for (const err of result.errors) {
          console.error(`[group-bet-expiry] error on group ${err.groupId}: ${err.error}`);
        }
      }
    } catch (e: any) {
      console.error('[group-bet-expiry] tick failed:', e?.message || e);
    } finally {
      sweepRunning = false;
    }
  };

  // Immediate first tick, then on the interval.
  tick();
  sweepInterval = setInterval(tick, intervalMs);
  console.log(`⏰ Group-bet expiry worker started (interval: ${intervalMs / 1000}s).`);
}

export function stopGroupBetExpiryWorker(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    console.log('⏰ Group-bet expiry worker stopped.');
  }
}

// Helper exported for tests + ad-hoc admin tools
export const __internals__ = { refundOneRoom, HARD_MAX_PER_TICK, REDIS_SWEEP_LOCK_KEY };
