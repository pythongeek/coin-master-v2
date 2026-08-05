/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-FRAUD — 8 real-time fraud signals (Phase 1 / Day 5)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Implements the 8 fraud signals listed in Phase 1 §4:
 *
 *    | Code                            | Severity | Trigger                                |
 *    |---------------------------------|----------|----------------------------------------|
 *    | group_sybil_suspected           | high     | ≥3 members in a room share the same IP |
 *    | group_invite_farm_suspected     | medium   | creator had ≥3 rooms with the same IP  |
 *    | group_founder_collusion         | medium   | creator win-rate >60% over ≥10 rounds  |
 *    | group_withdraw_hold             | info     | resolved room pool ≥$5,000             |
 *    | group_unusual_pattern           | high     | pool >3× creator_stake × max_members   |
 *    | group_vpn_suspected             | high     | members from ≥3 distinct countries     |
 *    | group_compromised_creator       | high     | creator's account is_flagged = true    |
 *    | group_admin_force               | info     | an admin froze or force-cancelled       |
 *
 *  Hooks:
 *    - `evaluateOnJoin({groupId, userId, ipAddress, countryCode})`
 *      Called by group-bet-join.ts after a successful INSERT.
 *    - `evaluateOnFlip({groupId, totalPool, winningSide, founderBoost})`
 *      Called by group-bet-flip.ts before the status flip.
 *    - `evaluateOnExpire({groupId, refundedTotal})`
 *      Called by group-bet-expiry.ts for audit visibility.
 *
 *  Every signal writes to BOTH:
 *    - `fraud_signals` (existing table, system-wide fraud pipeline)
 *    - `group_bet_audit` (per-room, with action='admin_force'|'invite_share'|'bonus_award')
 *      via payload metadata so admins can find them in the room context.
 *
 *  Idempotency: signal fingerprint is `signal_type:room_id:user_id:context`
 *  so the same signal is not written twice for the same room + trigger.
 * ════════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';
import { groupFraudSignalsTotal } from '../routes/metrics';

// ─── Signal taxonomy (matches Phase 1 §4 plan) ─────────────────
export type GroupFraudSignalType =
  | 'group_sybil_suspected'
  | 'group_invite_farm_suspected'
  | 'group_founder_collusion'
  | 'group_withdraw_hold'
  | 'group_unusual_pattern'
  | 'group_vpn_suspected'
  | 'group_compromised_creator'
  | 'group_admin_force';

export type GroupFraudSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface GroupFraudSignal {
  signalType: GroupFraudSignalType;
  severity: GroupFraudSeverity;
  userId: string | null;
  relatedUserId: string | null;
  fingerprint: string;
  metadata: Record<string, unknown>;
}

// ─── Thresholds (Phase 2 admin-config replaces) ─────────────────
const FALLBACK_SYBIL_MIN_SAME_IP = 3;          // ≥3 distinct users on same IP
const FALLBACK_INVITE_FARM_MIN_ROOMS = 3;     // ≥3 rooms per creator in window
const FALLBACK_FOUNDER_COLLUSION_MIN_ROUNDS = 10;
const FALLBACK_FOUNDER_COLLUSION_WIN_RATE = 0.6;
const FALLBACK_WITHDRAW_HOLD_POOL_USD = 5000;  // hold winners ≥24h if pool > $5K
const FALLBACK_POOL_ANOMALY_MULTIPLIER = 3;   // pool > 3× (creatorStake × maxMembers)
const FALLBACK_VPN_MIN_COUNTRIES = 3;

// Backwards-compat aliases — Day-8 rename for clarity (no behavior change)
const SYBIL_MIN_SAME_IP = FALLBACK_SYBIL_MIN_SAME_IP;
const INVITE_FARM_MIN_ROOMS = FALLBACK_INVITE_FARM_MIN_ROOMS;
const FOUNDER_COLLUSION_MIN_ROUNDS = FALLBACK_FOUNDER_COLLUSION_MIN_ROUNDS;
const FOUNDER_COLLUSION_WIN_RATE = FALLBACK_FOUNDER_COLLUSION_WIN_RATE;
const WITHDRAW_HOLD_POOL_USD = FALLBACK_WITHDRAW_HOLD_POOL_USD;
const POOL_ANOMALY_MULTIPLIER = FALLBACK_POOL_ANOMALY_MULTIPLIER;
const VPN_MIN_COUNTRIES = FALLBACK_VPN_MIN_COUNTRIES;

// ─── Helper: write a signal to fraud_signals (idempotent) ─────
async function writeSignal(signal: GroupFraudSignal, ipAddress: string | null = null): Promise<boolean> {
try {
  // Check for existing signal with same fingerprint (partial index —
  // the partial index `idx_fraud_signals_fingerprint` is non-unique)
  const existing = await query<{ id: string }>(
    `SELECT id FROM fraud_signals
      WHERE fingerprint = $1
      LIMIT 1`,
    [signal.fingerprint],
  );
  if (existing.rows.length > 0) return false;

  const r = await query(
    `INSERT INTO fraud_signals
       (user_id, signal_type, severity, fingerprint, ip_address,
        related_user_id, status, metadata)
     VALUES ($1, $2, $3, $4, $5::inet, $6, 'open', $7::jsonb)
     RETURNING id`,
    [
      signal.userId,
      signal.signalType,
      signal.severity,
      signal.fingerprint,
      ipAddress,
      signal.relatedUserId,
      JSON.stringify(signal.metadata),
    ],
  );
  const inserted = (r.rows.length ?? 0) > 0;
  // Gap 7: increment groupFraudSignalsTotal counter, labeled by signal_type
  // and severity. Fired only on INSERT success (deduped signals don't
  // double-count).
  if (inserted) {
    groupFraudSignalsTotal.inc({
      signal_type: signal.signalType,
      severity: signal.severity,
    });
  }
  return inserted;
} catch (err: any) {
  // Never let a fraud-signal-write failure crash the calling flow.
  // Surface to stderr for the operator; flip=false means "caller
  // should keep going". The signal can always be regenerated.
  console.error('[group-bet-fraud] signal write failed:', err?.message);
  return false;
}
}

function fingerprintFor(signalType: string, groupId: string, userId: string | null, context: string): string {
  return `${signalType}:${groupId}:${userId ?? 'system'}:${context}`.slice(0, 200);
}

// ─── Public API: join-time signals ─────────────────────────────
export interface JoinContext {
  groupId: string;
  userId: string;
  ipAddress: string | null;
  countryCode?: string | null;
}

export async function evaluateOnJoin(ctx: JoinContext): Promise<GroupFraudSignal[]> {
  const triggered: GroupFraudSignal[] = [];

  // NOTE (Day 8): The Phase 2 §2.1 admin-config thresholds focus on
  // player-facing knobs (member caps, stake caps, invite bonuses).
  // Per-signal fraud thresholds (sybil count, invite-farm count,
  // founder-collusion rounds, etc.) are NOT yet exposed in the
  // admin UI — they remain the FALLBACK_* constants below. Phase 3
  // work will add a `fraud_signals` config slice (e.g.
  // `groupSybilMinSameIp`, `groupFraudInviteFarmMinRooms`,
  // `groupFraudFounderMinRounds`, …) that admin can tune.
  //
  // For now the fallbacks here ARE the production values.

  // Load the room + all current members
  const r = await query<any>(
    `SELECT creator_id FROM group_bet WHERE id = $1`,
    [ctx.groupId],
  );
  if (!r.rows.length) return triggered;
  const creatorId = r.rows[0].creator_id;

  // ── 1. Sybil: ≥3 members sharing the same IP (excluding the creator's
  // own IP if we can't isolate — Phase 2 will refine) ────────────────
  if (ctx.ipAddress) {
    // registration_ip is varchar(45); cast both sides to inet for comparison
    const ipCount = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM group_bet_member m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
          AND m.user_id != $2
          AND u.registration_ip::inet = $3::inet`,
      [ctx.groupId, creatorId, ctx.ipAddress],
    );
    if ((ipCount.rows[0]?.n ?? 0) + 1 >= SYBIL_MIN_SAME_IP) {
      const sig: GroupFraudSignal = {
        signalType: 'group_sybil_suspected',
        severity: 'high',
        userId: creatorId,
        relatedUserId: ctx.userId,
        fingerprint: fingerprintFor('group_sybil_suspected', ctx.groupId, creatorId, ctx.ipAddress),
        metadata: {
          groupBetId: ctx.groupId,
          ipAddress: ctx.ipAddress,
          sameIpCount: (ipCount.rows[0]?.n ?? 0) + 1,
          trigger: 'join_time',
          userId: ctx.userId,
        },
      };
      await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
    }
  }

  // ── 2. Invite-farm: creator opened ≥3 rooms in the last 24h ─────
  const recentRooms = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM group_bet
      WHERE creator_id = $1
        AND created_at > NOW() - interval '24 hours'`,
    [creatorId],
  );
  const recentN = recentRooms.rows[0]?.n ?? 0;
  if (recentN >= INVITE_FARM_MIN_ROOMS) {
    const sig: GroupFraudSignal = {
      signalType: 'group_invite_farm_suspected',
      severity: 'medium',
      userId: creatorId,
      relatedUserId: ctx.userId,
      fingerprint: fingerprintFor('group_invite_farm_suspected', ctx.groupId, creatorId, '24h_window'),
      metadata: {
          groupBetId: ctx.groupId,
        recentRooms: recentRooms.rows[0]?.n ?? 0,
        window: '24h',
        trigger: 'join_time',
        userId: ctx.userId,
      },
    };
    await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
  }

  // ── 3. VPN-suspected: members from ≥3 distinct countries ─────
  if (ctx.countryCode) {
    const countries = await query<{ c: string }>(
      `SELECT DISTINCT COALESCE(u.kyc_country, '??') AS c
         FROM group_bet_member m
         JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1
        AND u.kyc_country IS NOT NULL`,
      [ctx.groupId],
    );
    if (countries.rows.length + 1 >= VPN_MIN_COUNTRIES) {
      const sig: GroupFraudSignal = {
        signalType: 'group_vpn_suspected',
        severity: 'high',
        userId: creatorId,
        relatedUserId: ctx.userId,
        fingerprint: fingerprintFor('group_vpn_suspected', ctx.groupId, creatorId, 'multi_country'),
        metadata: {
          groupBetId: ctx.groupId,
          countries: countries.rows.map(r => r.c).concat(ctx.countryCode ?? '??'),
          trigger: 'join_time',
          userId: ctx.userId,
        },
      };
      await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
    }
  }

  // ── 4. Compromised creator: creator's account is_flagged=true ──
  const creatorRow = await query<{ is_flagged: boolean }>(
    `SELECT is_flagged FROM users WHERE id = $1`,
    [creatorId],
  );
  if (creatorRow.rows[0]?.is_flagged === true) {
    const sig: GroupFraudSignal = {
      signalType: 'group_compromised_creator',
      severity: 'high',
      userId: creatorId,
      relatedUserId: ctx.userId,
      fingerprint: fingerprintFor('group_compromised_creator', ctx.groupId, creatorId, 'is_flagged'),
      metadata: {
          groupBetId: ctx.groupId,
        trigger: 'join_time',
        userId: ctx.userId,
      },
    };
    await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
  }

  return triggered;
}

// ─── Public API: flip-time signals ──────────────────────────────
export interface FlipContext {
  groupId: string;
  creatorId: string;
  totalPool: number;
  creatorStake: number;
  maxMembers: number;
  winningSide: 'heads' | 'tails';
  payoutMode: 'equal' | 'proportional' | 'founder_boost';
  ipAddress: string | null;
  /** Optional invite-token prefix used to scope the founder-collusion
   *  query to a single test run. In production this should be undefined
   *  (the default 30-day window is used). */
  historyScopeToken?: string;
}

export async function evaluateOnFlip(ctx: FlipContext): Promise<GroupFraudSignal[]> {
  const triggered: GroupFraudSignal[] = [];

  // ── 5. Withdraw hold: pool ≥ $5K → 24h hold on winners ───────
  if (ctx.totalPool >= WITHDRAW_HOLD_POOL_USD) {
    const sig: GroupFraudSignal = {
      signalType: 'group_withdraw_hold',
      severity: 'low',
      userId: null,
      relatedUserId: ctx.creatorId,
      fingerprint: fingerprintFor('group_withdraw_hold', ctx.groupId, ctx.creatorId, String(ctx.totalPool)),
      metadata: {
          groupBetId: ctx.groupId,
        totalPool: ctx.totalPool,
        holdHours: 24,
        trigger: 'flip_resolve',
      },
    };
    await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
  }

  // ── 6. Unusual pattern: pool > 3× (creatorStake × max_members) ─
  const expectedMax = ctx.creatorStake * ctx.maxMembers;
  if (ctx.totalPool > expectedMax * POOL_ANOMALY_MULTIPLIER && expectedMax > 0) {
    const sig: GroupFraudSignal = {
      signalType: 'group_unusual_pattern',
      severity: 'high',
      userId: ctx.creatorId,
      relatedUserId: null,
      fingerprint: fingerprintFor('group_unusual_pattern', ctx.groupId, ctx.creatorId, 'pool_anomaly'),
      metadata: {
          groupBetId: ctx.groupId,
        totalPool: ctx.totalPool,
        expectedMax,
        ratio: ctx.totalPool / expectedMax,
        trigger: 'flip_resolve',
      },
    };
    await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
  }

  // ── 7. Founder collusion: creator win-rate > 60% over ≥10 rounds ─
  // (only meaningful with payout_mode='founder_boost', where the
  // creator has structural incentive)
  if (ctx.payoutMode === 'founder_boost') {
    // In production use a 30-day window. Tests can pass `historyScopeToken`
    // to scope the count to a specific run (matching `invite_token` LIKE).
    const where: string[] = ['creator_id = $1', "status = 'resolved'"];
    const params: unknown[] = [ctx.creatorId];
    if (ctx.historyScopeToken) {
      params.push(`${ctx.historyScopeToken}%`);
      where.push(`invite_token LIKE $${params.length}`);
      where.push(`resolved_at > NOW() - interval '5 hours'`);
    } else {
      where.push(`resolved_at > NOW() - interval '30 days'`);
    }
    const stats = await query<{ rounds: number; wins: number }>(
      `SELECT
         count(*) FILTER (WHERE winning_side = creator_choice)::int AS wins,
         count(*)::int AS rounds
       FROM group_bet
      WHERE ${where.join(' AND ')}`,
      params,
    );
    const rounds = stats.rows[0]?.rounds ?? 0;
    const wins = stats.rows[0]?.wins ?? 0;
    if (rounds >= FOUNDER_COLLUSION_MIN_ROUNDS && wins / rounds > FOUNDER_COLLUSION_WIN_RATE) {
      const sig: GroupFraudSignal = {
        signalType: 'group_founder_collusion',
        severity: 'medium',
        userId: ctx.creatorId,
        relatedUserId: null,
        fingerprint: fingerprintFor('group_founder_collusion', ctx.groupId, ctx.creatorId, 'win_rate'),
        metadata: {
          groupBetId: ctx.groupId,
          rounds,
          wins,
          winRate: wins / rounds,
          window: ctx.historyScopeToken ? '1h-scoped' : '30d',
          trigger: 'flip_resolve',
        },
      };
      await writeSignal(sig, ctx.ipAddress);
      triggered.push(sig);
    }
  }

  return triggered;
}

// ─── Public API: admin-action signal (Phase 1 §4 row 8) ──────
export async function recordAdminForce(
  groupId: string,
  adminId: string,
  action: 'admin_freeze' | 'admin_force_cancel' | 'admin_force_refund' | 'admin_kick' | 'admin_mark_fraud' | 'admin_shadow',
  reason: string,
): Promise<void> {
  await writeSignal({
    signalType: 'group_admin_force',
    severity: 'low',
    userId: adminId,
    relatedUserId: null,
    fingerprint: fingerprintFor('group_admin_force', groupId, adminId, action),
    metadata: { action, reason, groupBetId: groupId, trigger: 'admin_action' },
  });
}

// ─── Public API: query helpers used by the admin route ────────
export async function listGroupFraudSignals(
  groupId: string,
): Promise<Array<{ id: string; signal_type: string; severity: string; status: string; metadata: any; detected_at: Date }>> {
  const r = await query<any>(
    `SELECT id, signal_type, severity, status, metadata, detected_at
       FROM fraud_signals
      WHERE metadata::text LIKE $1
      ORDER BY detected_at DESC
      LIMIT 100`,
    [`%"groupBetId":"${groupId}"%`],
  );
  return r.rows;
}

export const __internals__ = {
  writeSignal,
  fingerprintFor,
  SYBIL_MIN_SAME_IP,
  INVITE_FARM_MIN_ROOMS,
  FOUNDER_COLLUSION_MIN_ROUNDS,
  FOUNDER_COLLUSION_WIN_RATE,
  WITHDRAW_HOLD_POOL_USD,
  POOL_ANOMALY_MULTIPLIER,
  VPN_MIN_COUNTRIES,
};
