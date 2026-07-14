/**
 * P0-4 — Bonus stacking rules.
 *
 * Per the v2.0 spec, AT MOST ONE active bonus per user by default, with
 * documented exceptions for VIP rakeback + cashback bonuses that can
 * stack alongside ONE other active bonus of compatible type.
 *
 * The matrix lives in code (not admin_settings) because:
 *   - It rarely changes
 *   - It's enforced atomically against the bonus_claims table
 *   - Admin can't widen stacks beyond what the game-economics team OK'd
 *
 * Admin CAN, however, globally disable stacking (max_active_bonuses_per_user,
 * default 1). Setting it to 0 means "unlimited" (legacy behavior).
 */

import type { BonusType } from './bonus';

export class BonusStackingError extends Error {
  readonly code = 'STACK_NOT_ALLOWED';
  readonly blockedBy: BonusType[];
  readonly attempted: BonusType;
  constructor(attempted: BonusType, blockedBy: BonusType[]) {
    super(
      `Cannot claim "${attempted}" — user already has active bonus(es) [${blockedBy.join(', ')}] and the stacking matrix forbids combination.`,
    );
    this.name = 'BonusStackingError';
    this.attempted = attempted;
    this.blockedBy = blockedBy;
  }
}

/**
 * Stacking matrix (subset relevant today — extends as new bonus types land).
 * `canStackWith: []` means this bonus MUST be alone.
 */
export const STACKING_MATRIX: Record<BonusType, { canStackWith: BonusType[] }> = {
  welcome:             { canStackWith: [] },                             // always alone
  deposit_match:       { canStackWith: ['vip'] },
  rain:                { canStackWith: [] },                             // event-driven, must be alone
  vip:                 { canStackWith: ['deposit_match'] },              // VIP is the rack-friendly one
  manual:              { canStackWith: ['vip'] },
  affiliate:           { canStackWith: ['vip'] },
  // Future types per v2.0 spec — re-add here when those services land:
  //   reload → canStackWith: ['vip']
  //   streak → canStackWith: ['vip']
  //   referral_milestone → canStackWith: ['vip']
  //   loss_rebate → canStackWith: ['vip', 'streak']
};

/**
 * Decides if `attempted` can be added given the user's existing active types.
 * Pure function — no DB. Caller passes in the row from bonus_claims.
 *
 * Throws BonusStackingError if the attempt is forbidden. The error carries
 * the existing types so the route layer can surface a clear message.
 */
export function checkStackingAllowed(
  attempted: BonusType,
  existingActiveTypes: BonusType[],
): void {
  if (existingActiveTypes.length === 0) return;

  // Empty list ("max_active_bonuses=0" → unlimited) is handled by caller.
  for (const existing of existingActiveTypes) {
    if (existing === attempted) {
      // Same type already active → reject. Welcome bonus re-issue is
      // gated by grantWelcomeBonus idempotency separately, but for
      // deposit_match and others this stops duplicate claims.
      throw new BonusStackingError(attempted, [existing]);
    }
    const allowed = STACKING_MATRIX[attempted].canStackWith;
    if (!allowed.includes(existing)) {
      throw new BonusStackingError(attempted, [existing]);
    }
  }
}

import { query } from '../config/database';

/**
 * Fetch existing ACTIVE claim types for a user. Used by both grant funcs
 * and the test suite to validate the rule.
 */
export async function getActiveBonusTypes(userId: string): Promise<BonusType[]> {
  const r = await query(
    `SELECT DISTINCT bonus_type FROM bonus_claims
      WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return r.rows.map((row) => (row as { bonus_type: string }).bonus_type as BonusType);
}

/**
 * One-shot guard used by deposit-match claim path. Throws if dis-allowed.
 */
export async function enforceStacking(
  userId: string,
  attempted: BonusType,
  maxActivePerUser: number = 1,
): Promise<void> {
  if (maxActivePerUser <= 0) return;  // 0 = unlimited (admin override)
  const existing = await getActiveBonusTypes(userId);
  if (existing.length >= maxActivePerUser) {
    checkStackingAllowed(attempted, existing);
  }
}
