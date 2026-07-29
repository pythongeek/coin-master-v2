/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-STATE — 6-state finite state machine (Phase 1)
 *  ════════════════════════════════════════════════════════════════
 *
 *  The single source of truth for `group_bet.status` transitions.
 *  Every other group-bet service that mutates status MUST go through
 *  `transitionGroupStatus()` so the audit trail stays consistent.
 *
 *  Transitions:
 *    (none) ──► open                 — creation (group-bet-create.ts)
 *    open ─────► ready               — last member joined
 *    ready ────► flipping            — creator clicks flip / auto / lottery
 *    flipping ─► resolved            — provably-fair flip complete
 *    open ─────► cancelled           — creator cancels OR admin
 *    ready ────► cancelled           — creator cancels OR admin
 *    open ─────► expired             — TTL sweep (group-bet-expiry.ts)
 *    ready ────► expired             — TTL sweep
 *    any ──────► frozen              — admin force_freeze
 *    frozen ────► (back to source)   — admin unfreeze OR
 *                                       transition continues under admin
 *
 *  Anti-patterns guarded:
 *    - Status mutation outside this helper → rejected by tests
 *    - Mutating a terminal state (resolved/cancelled/expired) → throws
 *    - Mutating without an audit row → throws
 *    - Mutating without an audit_log mirror → throws
 *
 *  The helper:
 *    1. SELECT ... FOR UPDATE the row (concurrency-safe)
 *    2. Verifies `current_status` is in `fromStatuses`
 *    3. UPDATEs `status` + writes one row to `group_bet_audit`
 *       AND one row to `audit_log` (system-wide ledger)
 *    4. Returns the updated row
 *
 *  Both writes happen inside the same SERIALIZABLE transaction as the
 *  status update. If either audit row fails, the entire transition
 *  rolls back.
 * ════════════════════════════════════════════════════════════════
 */

import { query, withTransaction } from '../config/database';

// ─── Type contracts ────────────────────────────────────────────
export type GroupBetStatus =
  | 'pending'
  | 'open'
  | 'ready'
  | 'flipping'
  | 'resolved'
  | 'cancelled'
  | 'expired'
  | 'frozen';

export type GroupBetAuditAction =
  | 'create'
  | 'join'
  | 'leave'
  | 'ready'
  | 'flip_start'
  | 'flip_resolve'
  | 'cancel'
  | 'expire'
  | 'refund'
  | 'settle'
  | 'lottery_pick'
  | 'admin_force_cancel'
  | 'admin_force_refund'
  | 'admin_freeze'
  | 'admin_unfreeze'
  | 'admin_kick'
  | 'admin_mark_fraud'
  | 'admin_shadow'
  | 'invite_share'
  | 'bonus_award';

export interface GroupBetRow {
  id: string;
  creator_id: string;
  status: GroupBetStatus;
  current_members: number;
  min_members: number;
  max_members: number;
  total_pool: string;        // numeric → string from pg
  is_frozen: boolean;
  winning_side: string | null;
  server_seed_hash: string | null;
  resolved_at: Date | null;
  ready_at: Date | null;
  expires_at: Date;
}

export interface TransitionContext {
  groupId: string;
  actorId: string | null;       // null = system (sweep, auto-flip)
  ipAddress?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
}

export interface TransitionResult {
  previousStatus: GroupBetStatus;
  newStatus: GroupBetStatus;
  row: GroupBetRow;
}

// ─── Terminal + locked states ───────────────────────────────────
const TERMINAL_STATUSES: ReadonlySet<GroupBetStatus> = new Set([
  'resolved',
  'cancelled',
  'expired',
]);

export function isTerminalStatus(status: GroupBetStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ─── Forbidden direct mutations ────────────────────────────────
/**
 * Reference each "exit point" that used to be raw `UPDATE … status`
 * scattered across the codebase. The intent is to make it trivial
 * for code review to confirm no service mutates group_bet.status
 * outside this module.
 *
 * Implementation:
 *   - We provide `lockGroupBetRow()` and `transitionGroupStatus()`.
 *   - All other callers must pass through this helper.
 *   - The test suite greps the codebase to enforce that.
 */
export async function lockGroupBetRow(
  groupId: string,
): Promise<GroupBetRow | null> {
  const r = await query<GroupBetRow>(
    `SELECT id, creator_id, status, current_members, min_members, max_members,
            total_pool, is_frozen, winning_side, server_seed_hash,
            resolved_at, ready_at, expires_at
       FROM group_bet
      WHERE id = $1
        FOR UPDATE`,
    [groupId],
  );
  return r.rows[0] ?? null;
}

// ─── The single mutation helper ────────────────────────────────
export interface TransitionOptions {
  /**
   * Allowed source statuses. If the row's current status is not in this
   * list, `transitionGroupStatus` throws GroupBetTransitionError.
   */
  fromStatuses: readonly GroupBetStatus[];
  /** Target status. */
  toStatus: GroupBetStatus;
  /**
   * Audit action for the group_bet_audit row AND the audit_log row.
   * Convention: maps 1:1 to the in-table CHECK constraint.
   */
  action: GroupBetAuditAction;
  /**
   * Which audit_log.severity to use. Default = 'info'.
   * 'warn' for admin actions, 'critical' for force-refund.
   */
  auditSeverity?: 'info' | 'warn' | 'critical';
  /**
   * If true, also update additional columns in the same UPDATE
   * (e.g. resolved_at, winning_side). Keys = columns; values = SQL
   * placeholders via $N. Caller provides the SQL fragment.
   *
   *   extraColumnsSql = "winning_side = $2, resolved_at = NOW()"
   *   extraColumnsParams = [...values...]
   */
  extraColumnsSql?: string;
  extraColumnsParams?: unknown[];
}

/**
 * Transition a group_bet row's status, atomically writing BOTH the
 * per-group `group_bet_audit` row AND the system-wide `audit_log` row.
 *
 * Concurrency: SERIALIZABLE row lock on group_bet + transactional
 * audit writes. Two competing transitions on the same group will
 * serialize; the second sees the first's status and (correctly) fails
 * its `fromStatuses` check.
 */
export async function transitionGroupStatus(
  ctx: TransitionContext,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const {
    fromStatuses,
    toStatus,
    action,
    auditSeverity = 'info',
    extraColumnsSql,
    extraColumnsParams = [],
  } = options;

  if (fromStatuses.length === 0) {
    throw new Error('transitionGroupStatus: fromStatuses cannot be empty');
  }

  return withTransaction(async (txQuery) => {
    // 1. Lock the row
    const lockResult = await txQuery(
      `SELECT id, creator_id, status, current_members, min_members, max_members,
              total_pool, is_frozen, winning_side, server_seed_hash,
              resolved_at, ready_at, expires_at
         FROM group_bet
        WHERE id = $1
        FOR UPDATE`,
      [ctx.groupId],
    ) as { rows: GroupBetRow[] };
    const current = lockResult.rows[0];
    if (!current) {
      throw new GroupBetTransitionError(
        `group_bet ${ctx.groupId} not found`,
        'GROUP_BET_NOT_FOUND',
      );
    }

    // 2. Verify fromStatuses
    if (!fromStatuses.includes(current.status)) {
      throw new GroupBetTransitionError(
        `group_bet ${ctx.groupId}: invalid transition ` +
          `${current.status} → ${toStatus} (allowed from: ${fromStatuses.join(',')})`,
        'GROUP_BET_INVALID_TRANSITION',
        { currentStatus: current.status, fromStatuses, toStatus },
      );
    }

    // 3. Reject transitioning FROM a terminal status
    if (isTerminalStatus(current.status) && toStatus !== 'frozen') {
      throw new GroupBetTransitionError(
        `group_bet ${ctx.groupId} is already ${current.status} (terminal); ` +
          `cannot transition to ${toStatus}`,
        'GROUP_BET_TERMINAL',
        { currentStatus: current.status },
      );
    }

    // 4. Build the UPDATE statement.
    // Auto-set `ready_at` on open → ready; auto-set `resolved_at` on flipping → resolved.
    // Strip these out of the caller-supplied extraColumnsSql to avoid duplicate SET clauses.
    const autoExtras: string[] = [];
    if (toStatus === 'ready') autoExtras.push('ready_at = NOW()');
    if (toStatus === 'resolved') autoExtras.push('resolved_at = NOW()');
    let cleanedExtras = '';
    if (extraColumnsSql) {
      cleanedExtras = extraColumnsSql
        .replace(/(^|,\s*)resolved_at\s*=\s*NOW\(\)/gi, '')
        .replace(/(^|,\s*)ready_at\s*=\s*NOW\(\)/gi, '')
        .replace(/^,\s*/, '')
        .replace(/,\s*$/, '')
        .trim();
    }
    const allExtras = [...autoExtras, cleanedExtras].filter(Boolean).join(', ');
    const setClause = allExtras
      ? `status = $2, ${allExtras}, updated_at = NOW()`
      : `status = $2, updated_at = NOW()`;
    const updateParams = [
      ctx.groupId,
      toStatus,
      ...extraColumnsParams,
    ];
    const updateResult = await txQuery(
      `UPDATE group_bet
          SET ${setClause}
        WHERE id = $1
      RETURNING id, creator_id, status, current_members, min_members, max_members,
                total_pool, is_frozen, winning_side, server_seed_hash,
                resolved_at, ready_at, expires_at`,
      updateParams,
    ) as { rows: GroupBetRow[] };
    const updated = updateResult.rows[0];
    if (!updated) {
      // Should not happen — row was locked above. Throw loudly.
      throw new GroupBetTransitionError(
        `group_bet ${ctx.groupId}: UPDATE returned 0 rows`,
        'GROUP_BET_UPDATE_FAILED',
      );
    }

    // 5. Write the per-group audit row (group_bet_audit)
    const auditPayload = {
      previousStatus: current.status,
      newStatus: toStatus,
      ...(ctx.payload ?? {}),
    };
    await txQuery(
      `INSERT INTO group_bet_audit
         (group_id, actor_id, action, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5::inet)`,
      [
        ctx.groupId,
        ctx.actorId,
        action,
        JSON.stringify(auditPayload),
        ctx.ipAddress ?? null,
      ],
    );

    // 6. Mirror to the system-wide audit_log (same transaction)
    const auditLogDetails = JSON.stringify({
      groupId: ctx.groupId,
      action,
      previousStatus: current.status,
      newStatus: toStatus,
      actorId: ctx.actorId,
      ...(ctx.payload ?? {}),
    });
    await txQuery(
      `INSERT INTO audit_log
         (user_id, category, action, severity, details)
       VALUES ($1, 'group_play', $2, $3, $4)`,
      [
        ctx.actorId,
        `group_play.${action}`,
        auditSeverity,
        auditLogDetails,
      ],
    );

    return {
      previousStatus: current.status,
      newStatus: toStatus,
      row: updated,
    };
  });
}

// ─── Custom error ───────────────────────────────────────────────
export class GroupBetTransitionError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'GroupBetTransitionError';
    this.code = code;
    this.context = context;
  }
}

// ─── Pure transition table (no DB) ─────────────────────────────
/**
 * Authoritative transition matrix. Exported so tests can verify
 * what's allowed without hitting the DB.
 *
 * Frozen is intentionally a SPECIAL pseudo-state handled outside
 * this table because it can overlay any non-terminal state (admin
 * block). Use `freezeGroupBet()` for that.
 */
export const TRANSITION_TABLE: ReadonlyArray<{
  readonly from: GroupBetStatus;
  readonly to: GroupBetStatus;
  readonly action: GroupBetAuditAction;
}> = Object.freeze([
  // Lifecycle
  { from: 'open',      to: 'ready',     action: 'ready' },
  { from: 'ready',     to: 'flipping',  action: 'flip_start' },
  { from: 'flipping',  to: 'resolved',  action: 'flip_resolve' },

  // Cancelled paths
  { from: 'open',      to: 'cancelled', action: 'cancel' },
  { from: 'ready',     to: 'cancelled', action: 'cancel' },

  // TTL expiry paths
  { from: 'open',      to: 'expired',   action: 'expire' },
  { from: 'ready',     to: 'expired',   action: 'expire' },
]);

export function isTransitionAllowed(
  from: GroupBetStatus,
  to: GroupBetStatus,
): boolean {
  return TRANSITION_TABLE.some(t => t.from === from && t.to === to);
}
