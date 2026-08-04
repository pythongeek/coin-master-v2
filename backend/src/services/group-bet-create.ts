/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-CREATE — Creator-side open-room flow (Phase 1 / Day 2)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Responsible for:
 *    1. Pre-flight gates (KYC ≥ tier 1, lifetime-deposit ≥ $50,
 *       sufficient balance, not on global ban)
 *    2. Redis distributed lock (prevents the same user from racing
 *       two opens within 3 seconds — protects against double-debit)
 *    3. SQL `idempotency` via `client_request_id` partial-unique index
 *       (replays of the same create call within 60s return the original
 *       room, never create a duplicate)
 *    4. Atomic debit + `group_bet` INSERT + creator-member INSERT +
 *       `transactions` ledger entry — all inside one SERIALIZABLE TX
 *    5. Optimistic `weight` + `total_pool` bookkeeping
 *    6. Audit-mirror: `group_bet_audit.action='create'` +
 *       `audit_log.action='group_play.create'`
 *
 *  Error model (matches the rest of the backend):
 *    - GroupBetValidationError: 400 (input / gate failure)
 *    - GroupBetInsufficientBalanceError: 402 (mirror bonus.ts pattern)
 *    - GroupBetNotAllowedError: 403 (KYC/lifetime-deposit gate)
 *    - GroupBetDuplicateError: 409 (client_request_id replay)
 *    - GroupBetInternalError: 500 (anything else)
 *
 *  Designed so the HTTP route in `routes/group-bet.ts` can map these
 *  to status codes with a single `instanceof` ladder.
 * ════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { query, withTransaction } from '../config/database';
import { redis } from '../config/redis';
import { determineBalanceSource, debitBalanceForBet } from './bonus';
import { transitionGroupStatus } from './group-bet-state';
import { emitGroupBetEvent } from './socket-group-bet';
import { getGroupConfigKey, parseCountryList } from './admin-group-config';

// ─── Error class hierarchy ─────────────────────────────────────
export class GroupBetValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'GroupBetValidationError';
    this.code = code;
  }
}
export class GroupBetInsufficientBalanceError extends Error {
  readonly code: string;
  readonly balance: number;
  readonly required: number;
  constructor(balance: number, required: number) {
    super(`insufficient_balance: have ${balance.toFixed(8)}, need ${required.toFixed(8)}`);
    this.name = 'GroupBetInsufficientBalanceError';
    this.code = 'INSUFFICIENT_BALANCE';
    this.balance = balance;
    this.required = required;
  }
}
export class GroupBetNotAllowedError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'GroupBetNotAllowedError';
    this.code = code;
  }
}
export class GroupBetDuplicateError extends Error {
  readonly code: string;
  readonly existingGroupId: string;
  constructor(existingGroupId: string) {
    super(`duplicate_client_request_id: ${existingGroupId}`);
    this.name = 'GroupBetDuplicateError';
    this.code = 'DUPLICATE_CLIENT_REQUEST_ID';
    this.existingGroupId = existingGroupId;
  }
}
export class GroupBetInternalError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INTERNAL') {
    super(message);
    this.name = 'GroupBetInternalError';
    this.code = code;
  }
}

// ─── Public type contract ──────────────────────────────────────
export interface CreateGroupBetInput {
  userId: string;
  creatorChoice: 'heads' | 'tails';
  creatorStake: number;
  perMemberStake: number;
  minMembers: number;
  maxMembers: number;
  payoutMode: 'equal' | 'proportional' | 'founder_boost';
  turnMode: 'creator' | 'auto_on_full' | 'random_lottery';
  autoFlipSeconds?: number;
  inviteChannel?: 'whatsapp' | 'telegram' | 'twitter' | 'email' | 'copy' | 'qr' | 'link';
  clientRequestId?: string;
  ipAddress?: string;
}

export interface CreatedGroupBet {
  id: string;
  shortCode: string;
  creatorId: string;
  status: 'open';
  totalPool: string;
  creatorStake: string;
  perMemberStake: string;
  minMembers: number;
  maxMembers: number;
  payoutMode: string;
  turnMode: string;
  expiresAt: Date;
  inviteToken: string;
}

// ─── Soft caps (read at call-time from admin-config; falls back to
//      constants if config is missing — Day 8 Phase 2 §2.1) ─────
const SOFT_MAX_MEMBERS_FALLBACK = 10;
const SOFT_MAX_POOL_FALLBACK = 50_000;        // $50K
const SOFT_MIN_DEPOSIT_HISTORY_FALLBACK = 50; // $50 lifetime deposits
const HARD_LOCK_TTL_SEC = 3;         // anti-race
const REDIS_IDEM_TTL_SEC = 60;
const HARD_EXPIRY_HOURS_FALLBACK = 24;

// ─── Helpers ────────────────────────────────────────────────────
function genShortCode(): string {
  // 6 chars, unambiguous alphabet (no 0/O/1/I)
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += A[buf[i] % A.length];
  return s;
}
function genInviteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Pre-flight gates (run BEFORE any debit) ──────────────────
interface UserGate {
  ok: boolean;
  reason?: string;
  code?: string;
  balance?: number;
  lifetimeDeposits?: number;
}

async function runGates(
  userId: string,
  requiredBalance: number,
  softMinDeposit: number,
): Promise<UserGate> {
  // Pull the minimal row in one shot
  const r = await query<any>(
    `SELECT
        u.is_active,
        u.is_admin,
        u.kyc_tier,
        u.kyc_status,
        u.kyc_country,
        u.self_excluded_until,
        COALESCE(u.withdrawable_balance_coins, 0)::float8 AS withdrawable_balance,
        COALESCE(u.bonus_balance_coins, 0)::float8 AS bonus_balance,
        COALESCE((
          SELECT SUM(amount)::float8
            FROM transactions
           WHERE user_id = u.id
             AND type = 'deposit'
             AND status = 'confirmed'
        ), 0) AS lifetime_deposits
       FROM users u
      WHERE u.id = $1`,
    [userId],
  );
  if (!r.rows.length) {
    return { ok: false, reason: 'user_not_found', code: 'USER_NOT_FOUND' };
  }
  const u = r.rows[0];

  // 1. Active + not self-excluded
  if (!u.is_active) {
    return { ok: false, reason: 'account_disabled', code: 'ACCOUNT_DISABLED' };
  }
  if (u.self_excluded_until && new Date(u.self_excluded_until).getTime() > Date.now()) {
    return { ok: false, reason: 'self_excluded', code: 'SELF_EXCLUDED' };
  }

  // 2. KYC tier ≥ 1 (basic verified). is_admin bypasses.
  const tierNum = u.kyc_tier && /^\d+$/.test(String(u.kyc_tier))
    ? parseInt(String(u.kyc_tier), 10)
    : 0;
  if (tierNum < 1 && !u.is_admin) {
    return {
      ok: false,
      reason: 'kyc_required',
      code: 'KYC_TIER_INSUFFICIENT',
    };
  }

  // 2b. Country enforcement (group_play_blocked_countries from admin-config).
  //     Default list is KP,IR,SY,CU (sanctioned). Admin-configurable via
  //     admin_settings.group_play_blocked_countries (parsed as CSV).
  //     Lobby already hides rooms from blocked-country viewers; this
  //     closes the create-side bypass. is_admin bypasses.
  if (!u.is_admin) {
    const blockedCsv = await getGroupConfigKey('groupPlayBlockedCountries')
      .catch(() => 'KP,IR,SY,CU');
    const blocked = parseCountryList(String(blockedCsv ?? '')) ?? [];
    const userCountry = (u.kyc_country || '').toUpperCase().trim();
    if (userCountry && blocked.includes(userCountry)) {
      return {
        ok: false,
        reason: 'country_blocked',
        code: 'COUNTRY_BLOCKED',
      };
    }
  }

  // 3. Lifetime deposits ≥ admin-config floor (Gap 6: separate from per-member stake — uses groupMinUserDepositHistory, default $50)
  if (u.lifetime_deposits < softMinDeposit && !u.is_admin) {
    return {
      ok: false,
      reason: 'lifetime_deposit_too_low',
      code: 'LIFETIME_DEPOSIT_TOO_LOW',
      lifetimeDeposits: u.lifetime_deposits,
    };
  }

  // 4. Sufficient balance across the two balance columns
  const available = parseFloat(u.withdrawable_balance) + parseFloat(u.bonus_balance);
  if (available < requiredBalance) {
    return {
      ok: false,
      reason: 'insufficient_balance',
      code: 'INSUFFICIENT_BALANCE',
      balance: available,
    };
  }

  return { ok: true, balance: available, lifetimeDeposits: u.lifetime_deposits };
}

// ─── Public entrypoint ─────────────────────────────────────────
export async function createGroupBet(input: CreateGroupBetInput): Promise<CreatedGroupBet> {
  // ── 0. Load admin-config caps (Day 8 Phase 2) ────────────────
  const [softMaxMembers, softMaxPool, softMinDeposit, expiryMinutes] = await Promise.all([
    getGroupConfigKey('groupAbsoluteMaxMembers').catch(() => SOFT_MAX_MEMBERS_FALLBACK),
    getGroupConfigKey('groupAbsolutePoolCap').catch(() => SOFT_MAX_POOL_FALLBACK),
    getGroupConfigKey('groupMinUserDepositHistory').catch(() => SOFT_MIN_DEPOSIT_HISTORY_FALLBACK),
    getGroupConfigKey('groupExpiryMinutes').catch(() => 30),
  ]);

  // ── 0. Shape validation (cheap, throws GroupBetValidationError) ─
  if (!['heads', 'tails'].includes(input.creatorChoice)) {
    throw new GroupBetValidationError('creatorChoice must be heads or tails', 'INVALID_CHOICE');
  }
  if (!(input.creatorStake > 0)) {
    throw new GroupBetValidationError('creatorStake must be > 0', 'INVALID_CREATOR_STAKE');
  }
  if (!(input.perMemberStake > 0)) {
    throw new GroupBetValidationError('perMemberStake must be > 0', 'INVALID_PER_MEMBER_STAKE');
  }
  if (input.minMembers < 2) {
    throw new GroupBetValidationError('minMembers must be ≥ 2', 'INVALID_MIN_MEMBERS');
  }
  if (input.maxMembers > softMaxMembers) {
    throw new GroupBetValidationError(`maxMembers must be ≤ ${softMaxMembers}`, 'INVALID_MAX_MEMBERS');
  }
  if (input.maxMembers < input.minMembers) {
    throw new GroupBetValidationError('maxMembers < minMembers', 'INVALID_MEMBER_BOUNDS');
  }
  if (!['equal', 'proportional', 'founder_boost'].includes(input.payoutMode)) {
    throw new GroupBetValidationError(`invalid payoutMode: ${input.payoutMode}`, 'INVALID_PAYOUT_MODE');
  }
  if (!['creator', 'auto_on_full', 'random_lottery'].includes(input.turnMode)) {
    throw new GroupBetValidationError(`invalid turnMode: ${input.turnMode}`, 'INVALID_TURN_MODE');
  }
  const projectedPool = input.creatorStake + input.perMemberStake * (input.minMembers - 1);
  if (projectedPool > softMaxPool) {
    throw new GroupBetValidationError(
      `projected pool ${projectedPool} exceeds hard cap ${softMaxPool}`,
      'POOL_CAP_EXCEEDED',
    );
  }
  const autoFlip = input.autoFlipSeconds ?? 5;
  if (autoFlip < 1 || autoFlip > 60) {
    throw new GroupBetValidationError('autoFlipSeconds must be 1-60', 'INVALID_AUTO_FLIP');
  }

  // ── 1. clientRequestId idempotency (window 60s, scoped to user) ──
  if (input.clientRequestId && input.clientRequestId.length >= 8) {
    const r = await query<{ id: string }>(
      `SELECT id FROM group_bet
        WHERE creator_id = $1 AND client_request_id = $2
        LIMIT 1`,
      [input.userId, input.clientRequestId],
    );
    if (r.rows.length) {
      throw new GroupBetDuplicateError(r.rows[0].id);
    }
  }

  // ── 2. Redis SETNX distributed lock per user (anti-race) ──
  const lockKey = `group_bet:create:lock:${input.userId}`;
  const lockVal = `${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
  const lockOk = await redis.set(lockKey, lockVal, 'EX', HARD_LOCK_TTL_SEC, 'NX');
  if (!lockOk) {
    throw new GroupBetNotAllowedError(
      'concurrent create request — try again in a few seconds',
      'RATE_LIMITED',
    );
  }

  try {
    // ── 3. Pre-flight gates ──
    const gate = await runGates(input.userId, input.creatorStake, softMinDeposit);
    if (!gate.ok) {
      if (gate.code === 'INSUFFICIENT_BALANCE') {
        throw new GroupBetInsufficientBalanceError(gate.balance!, input.creatorStake);
      }
      throw new GroupBetNotAllowedError(
        gate.reason ?? 'not_allowed',
        gate.code ?? 'NOT_ALLOWED',
      );
    }

    // ── 4. Generate short_code (retry on the off-chance of clash) ─
    let shortCode = '';
    let inviteToken = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      shortCode = genShortCode();
      inviteToken = genInviteToken();
      const c = await query(
        `SELECT 1 FROM group_bet WHERE short_code = $1 OR invite_token = $2 LIMIT 1`,
        [shortCode, inviteToken],
      );
      if (!c.rows.length) break;
      if (attempt === 4) {
        throw new GroupBetInternalError('could not allocate unique short_code / invite_token', 'IDENT_COLLISION');
      }
    }

    // ── 5. Atomic transaction: debit + INSERT + audit + ledger ──
    const result = await withTransaction(async (txQuery) => {
      // 5a. Determine balance source (bonus vs withdrawable)
      const source = await determineBalanceSource(input.userId, input.creatorStake, txQuery as any);

      // 5b. Debit the creator's stake
      await debitBalanceForBet(input.userId, input.creatorStake, source, txQuery as any);

      // 5c. INSERT the group_bet row. The current_members default is 1
      //     (creator counts toward the threshold automatically).
      const insert = await txQuery(
        `INSERT INTO group_bet
           (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
            min_members, max_members, currency, payout_mode, turn_mode,
            auto_flip_seconds, invite_token, expires_at, status,
            client_request_id, total_pool, current_members)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, $9, $10,
                 $11, NOW() + ($12 || ' minutes')::interval, 'open',
                 $13, $14, 1)
         RETURNING id, short_code, creator_id, status, total_pool,
                   creator_stake, per_member_stake, min_members, max_members,
                   payout_mode, turn_mode, expires_at, invite_token`,
        [
          shortCode, input.userId, input.creatorChoice,
          input.creatorStake.toFixed(8), input.perMemberStake.toFixed(8),
          input.minMembers, input.maxMembers, input.payoutMode, input.turnMode,
          autoFlip, inviteToken, String(expiryMinutes), input.clientRequestId ?? null,
          input.creatorStake.toFixed(8), // total_pool starts at creator_stake
        ],
      ) as { rows: any[]; rowCount: number };
      const groupRow = insert.rows[0];

      // 5d. INSERT the creator's member row (role='creator')
      await txQuery(
        `INSERT INTO group_bet_member
           (group_id, user_id, role, choice, stake, weight, balance_before,
            client_request_id)
         VALUES ($1, $2, 'creator', $3, $4, 1.0,
                 (SELECT COALESCE(withdrawable_balance_coins, 0) + COALESCE(bonus_balance_coins, 0)
                    FROM users WHERE id = $2),
                 $5)`,
        [
          groupRow.id, input.userId, input.creatorChoice,
          input.creatorStake.toFixed(8), input.clientRequestId ?? null,
        ],
      );

      // 5e. Money-side ledger row (matches `placeBet` pattern)
      await txQuery(
        `INSERT INTO transactions
           (user_id, type, amount, currency, direction, status,
            metadata)
         VALUES ($1, 'bet', $2, 'USD', 'debit', 'confirmed',
                 $3::jsonb)`,
        [
          input.userId,
          input.creatorStake.toFixed(8),
          JSON.stringify({
            groupBetId: groupRow.id,
            shortCode: groupRow.short_code,
            role: 'creator',
            source,
            pool: 'group_play',
          }),
        ],
      );

      // 5f. Audit log row (replaces a transitionGroupStatus call because
      //     the row is being CREATED — there is no prior status to flip
      //     from. We mirror the same audit shape so the audit_log table
      //     records the event uniformly.)
      await txQuery(
        `INSERT INTO group_bet_audit
           (group_id, actor_id, action, payload, ip_address)
         VALUES ($1, $2, 'create',
                 $3::jsonb, $4::inet)`,
        [
          groupRow.id,
          input.userId,
          JSON.stringify({
            creatorChoice: input.creatorChoice,
            creatorStake: input.creatorStake,
            perMemberStake: input.perMemberStake,
            minMembers: input.minMembers,
            maxMembers: input.maxMembers,
            payoutMode: input.payoutMode,
            turnMode: input.turnMode,
            autoFlipSeconds: autoFlip,
            balanceSource: source,
          }),
          input.ipAddress ?? null,
        ],
      );
      await txQuery(
        `INSERT INTO audit_log
           (user_id, category, action, severity, details)
         VALUES ($1, 'group_play', 'group_play.create', 'info', $2::jsonb)`,
        [
          input.userId,
          JSON.stringify({
            groupId: groupRow.id,
            shortCode: groupRow.short_code,
            creatorStake: input.creatorStake,
            payoutMode: input.payoutMode,
            turnMode: input.turnMode,
          }),
        ],
      );

      return groupRow;
    });

    // Cache the idempotency window (Redis fallback in case
    //     the clientRequestId route-level check misses). ───────────
    if (input.clientRequestId && input.clientRequestId.length >= 8) {
      await redis.set(
        `group_bet:idem:create:${input.userId}:${input.clientRequestId}`,
        result.id,
        'EX',
        REDIS_IDEM_TTL_SEC,
      );
    }

    // ── Socket emit (best-effort; room is `group_<id>`) ──────
    emitGroupBetEvent('group:created', {
      groupId: result.id,
      shortCode: result.short_code,
      status: 'open',
      currentMembers: 1,
      maxMembers: result.max_members,
      totalPool: parseFloat(String(result.total_pool)),
      actorUserId: input.userId,
      meta: { payoutMode: result.payout_mode, turnMode: result.turn_mode },
    });

    return {
      id: result.id,
      shortCode: result.short_code,
      creatorId: result.creator_id,
      status: 'open',
      totalPool: String(result.total_pool),
      creatorStake: String(result.creator_stake),
      perMemberStake: String(result.per_member_stake),
      minMembers: result.min_members,
      maxMembers: result.max_members,
      payoutMode: result.payout_mode,
      turnMode: result.turn_mode,
      expiresAt: result.expires_at,
      inviteToken: result.invite_token,
    };
  } finally {
    // Release the distributed lock so the next legitimate create can proceed
    await redis.del(lockKey).catch(() => {});
  }
}

// Re-export transitionGroupStatus for downstream services (join / leave).
export { transitionGroupStatus };

// Helper exported for tests + join service
export const __internals__ = {
  genShortCode,
  genInviteToken,
  SOFT_MAX_MEMBERS_FALLBACK,
  SOFT_MAX_POOL_FALLBACK,
  SOFT_MIN_DEPOSIT_HISTORY_FALLBACK,
  HARD_EXPIRY_HOURS_FALLBACK,
};
