/**
 * ═══════════════════════════════════════════════════════════════
 *  BONUS & WAGERING SERVICE — Session 1 of roadmap-2026.md
 * ═══════════════════════════════════════════════════════════════
 *
 *  Purpose: prevent bonus abuse while keeping the user experience fair.
 *
 *  Mental model:
 *    - Every Coin in a user's wallet is tagged as either "bonus" (house money,
 *      cannot withdraw until conditions met) or "withdrawable" (real money,
 *      withdrawable subject to withdrawal validation).
 *    - When user places a bet, we prefer consuming bonus_balance first (so
 *      users feel the bonus is "in play"), then fall back to withdrawable.
 *    - Wagering tracks total bet volume against outstanding bonus requirements.
 *    - Withdrawal validates 5 conditions: wagering complete, amount <= cap,
 *      no expired bonus, KYC approved, no fraud flag.
 *
 *  All amounts in Coin (1 Coin = 1 USDT, pegged).
 *
 *  Tunable via admin_settings (admin can change at runtime):
 *    - bonus_wager_multiplier              (default 30)
 *    - bonus_max_withdrawal_multiplier     (default 3 — profit-first)
 *    - bonus_expiry_days                   (default 7)
 *    - bonus_min_deposit_to_withdraw_pct   (default 50)
 *    - bonus_cooldown_hours                (default 24)
 *    - bonus_welcome_amount                (default 10)
 *    - bonus_deposit_match_pct             (default 50)
 *    - bonus_deposit_match_cap             (default 100)
 *    - daily_withdrawal_limit_coins        (default 5000)
 *    - withdrawal_min_coins                (default 1)
 *    - withdrawal_max_coins                (default 10000)
 *    - withdrawal_auto_approve_threshold   (default 0 = always manual)
 * ═══════════════════════════════════════════════════════════════
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';

// ── Public types ──────────────────────────────────────────────

export type BonusType = 'welcome' | 'deposit_match' | 'rain' | 'vip' | 'manual' | 'affiliate';
export type BonusStatus = 'active' | 'completed' | 'expired' | 'forfeited';

export interface BonusClaim {
  id: string;
  userId: string;
  bonusType: BonusType;
  amountCoins: number;
  wageringRequired: number;
  wageringCompleted: number;
  maxWithdrawalAllowed: number | null;
  expiresAt: Date;
  claimedAt: Date;
  completedAt: Date | null;
  status: BonusStatus;
  metadata: Record<string, unknown>;
}

export interface BonusStatusSummary {
  totalActive: number;
  totalCompleted: number;
  totalExpired: number;
  totalForfeited: number;
  bonusBalanceCoins: number;
  withdrawableBalanceCoins: number;
  wageringRequiredCoins: number;
  wageringCompletedCoins: number;
  wageringPercentComplete: number;       // 0-100
  totalBonusClaimedCoins: number;        // lifetime
  totalDepositedCoins: number;          // lifetime
  minDepositRequiredToWithdrawCoins: number; // 0 if no active bonus
  canWithdrawNow: boolean;
  blockedReasons: string[];              // Bengali-friendly reasons
  activeClaims: Array<{
    id: string;
    bonusType: BonusType;
    amountCoins: number;
    wageringRequired: number;
    wageringCompleted: number;
    expiresAt: Date;
    daysRemaining: number;
    status: BonusStatus;
  }>;
}

export type WithdrawalValidationResult =
  | { ok: true; availableCoins: number }
  | { ok: false; reason: string; reasonBn: string; missingCoins?: number };


/**
 * Helper: get a query function for either an in-transaction callback or
 * the top-level query(). Avoids the awkward `txClient?.query ?? query`
 * pattern in every function body.
 */
type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
function q(txClient?: QueryFn): QueryFn {
  if (txClient) return txClient;
  // top-level query from database config returns the same shape but
  // with rowCount: number (not nullable) — cast for compatibility.
  return query as unknown as QueryFn;
}

// ── Helper: get a single bonus config value with fallback ────

// ── Helper: get bonus settings — read from typed getConfig() ─────
// Uses GameConfig (camelCase keys defined in admin-config.ts) populated
// from admin_settings on every call. This is the SAME data that admin
// PATCH /api/admin/config writes, so changing a setting in the admin UI
// immediately affects bonus behavior.
async function getBonusCfgNumber(key: keyof import('./admin-config').GameConfig, fallback: number): Promise<number> {
  const cfg = await getConfig();
  const v = cfg[key];
  if (typeof v === 'number') return v;
  return fallback;
}
async function getBonusCfgString(key: keyof import('./admin-config').GameConfig, fallback: string): Promise<string> {
  const cfg = await getConfig();
  const v = cfg[key];
  if (typeof v === 'string') return v;
  return fallback;
}

// ── 1. grantWelcomeBonus ───────────────────────────────────────

/**
 * Grant the welcome bonus to a freshly-registered user.
 * Idempotent: if the user already has a 'welcome' bonus claim, do nothing.
 *
 * @param userId    the user ID
 * @param txClient  optional withTransaction-style client:
 *                  `(text, params) => Promise<{rows, rowCount}>`
 *                  (matches withTransaction signature from config/database)
 * @returns the bonus claim row, or null if already granted
 */
export async function grantWelcomeBonus(
  userId: string,
  txClient?: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
): Promise<BonusClaim | null> {
  // Idempotency check
  const existing = await q(txClient)(
    `SELECT id FROM bonus_claims
     WHERE user_id = $1 AND bonus_type = 'welcome'
     LIMIT 1`,
    [userId],
  );
  if (existing.rows.length) return null;

  const amount = await getBonusCfgNumber('bonusWelcomeAmount', 10);
  const mult  = await getBonusCfgNumber('bonusWagerMultiplier', 30);
  const maxMul = await getBonusCfgNumber('bonusMaxWithdrawalMultiplier', 3);
  const expiryDays = await getBonusCfgNumber('bonusExpiryDays', 7);

  const wageringRequired = amount * mult;
  const maxWithdrawal = amount * maxMul;

  const id = uuidv4();
  const expiresAt = new Date(Date.now() + expiryDays * 86400_000);

  await q(txClient)(
    `INSERT INTO bonus_claims
       (id, user_id, bonus_type, amount_coins, wagering_required,
        max_withdrawal_allowed, expires_at, status, metadata)
     VALUES ($1, $2, 'welcome', $3, $4, $5, $6, 'active', $7)`,
    [
      id, userId, amount, wageringRequired, maxWithdrawal, expiresAt,
      JSON.stringify({ source: 'registration', version: '2.7' }),
    ],
  );

  // Atomically credit bonus balance + bump wagering_required + set last_bonus_at
  // The DB trigger trg_sync_user_balance will keep legacy balance = bonus + withdrawable.
  await q(txClient)(
    `UPDATE users
       SET bonus_balance_coins      = bonus_balance_coins + $2,
           wagering_required_coins  = wagering_required_coins + $3,
           total_bonus_claimed_coins = total_bonus_claimed_coins + $2,
           last_bonus_at            = NOW(),
           balance                  = COALESCE(bonus_balance_coins, 0) + COALESCE(withdrawable_balance_coins, 0) + $2
     WHERE id = $1`,
    [userId, amount, wageringRequired],
  );

  // 6. Record a 'bonus' transaction row so the user sees the credit
  //    in their transaction history. The merged reconciliation engine
  //    excludes these because they're house-credit (not a deposit),
  //    but the legacy `transactions` table keeps an audit trail.
  await q(txClient)(
    `INSERT INTO transactions
       (id, user_id, type, amount, currency, direction, status,
        related_user_id, metadata, completed_at)
     VALUES ($1, $2, 'bonus', $3, 'USD', 'credit', 'confirmed',
             $2, $4, NOW())`,
    [
      uuidv4(),
      userId,
      amount,
      JSON.stringify({
        source: 'welcome_bonus',
        bonus_claim_id: id,
        wagering_required: wageringRequired,
      }),
    ],
  );

  // 7. Audit
  await q(txClient)(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('bonus', 'bonus.granted.welcome', 'info', $1, $2)`,
    [
      userId,
      JSON.stringify({
        bonus_claim_id: id,
        amount_coins: amount,
        wagering_required: wageringRequired,
        max_withdrawal_allowed: maxWithdrawal,
      }),
    ],
  );

  return {
    id, userId, bonusType: 'welcome', amountCoins: amount,
    wageringRequired, wageringCompleted: 0,
    maxWithdrawalAllowed: maxWithdrawal,
    expiresAt, claimedAt: new Date(), completedAt: null,
    status: 'active', metadata: { source: 'registration' },
  };
}

// ── 2. claimDepositMatchBonus ─────────────────────────────────

/**
 * Grant a deposit-match bonus when a real deposit is confirmed.
 * Fires from the payment webhook handler.
 */
export async function claimDepositMatchBonus(
  userId: string,
  depositCoins: number,
  txClient?: QueryFn,
): Promise<BonusClaim | null> {
  const pct = await getBonusCfgNumber('bonusDepositMatchPct', 50);
  if (pct <= 0) return null; // disabled
  const cap = await getBonusCfgNumber('bonusDepositMatchCap', 100);

  const amount = Math.min((depositCoins * pct) / 100, cap);
  if (amount <= 0) return null;

  const mult  = await getBonusCfgNumber('bonusWagerMultiplier', 30);
  const maxMul = await getBonusCfgNumber('bonusMaxWithdrawalMultiplier', 3);
  const expiryDays = await getBonusCfgNumber('bonusExpiryDays', 7);

  const wageringRequired = amount * mult;
  const maxWithdrawal = amount * maxMul;
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + expiryDays * 86400_000);

  await q(txClient)(
    `INSERT INTO bonus_claims
       (id, user_id, bonus_type, amount_coins, wagering_required,
        max_withdrawal_allowed, expires_at, status, metadata)
     VALUES ($1, $2, 'deposit_match', $3, $4, $5, $6, 'active', $7)`,
    [
      id, userId, amount, wageringRequired, maxWithdrawal, expiresAt,
      JSON.stringify({ source: 'deposit', deposit_coins: depositCoins, pct }),
    ],
  );

  await q(txClient)(
    `UPDATE users
       SET bonus_balance_coins      = bonus_balance_coins + $2,
           wagering_required_coins  = wagering_required_coins + $3,
           total_bonus_claimed_coins = total_bonus_claimed_coins + $2,
           last_bonus_at            = NOW()
     WHERE id = $1`,
    [userId, amount, wageringRequired],
  );

  await q(txClient)(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('bonus', 'bonus.granted.deposit_match', 'info', $1, $2)`,
    [
      userId,
      JSON.stringify({
        bonus_claim_id: id,
        deposit_coins: depositCoins,
        pct, amount_coins: amount, wagering_required: wageringRequired,
      }),
    ],
  );

  return {
    id, userId, bonusType: 'deposit_match', amountCoins: amount,
    wageringRequired, wageringCompleted: 0,
    maxWithdrawalAllowed: maxWithdrawal,
    expiresAt, claimedAt: new Date(), completedAt: null,
    status: 'active', metadata: { deposit_coins: depositCoins, pct },
  };
}

// ── 3. creditWagering ──────────────────────────────────────────

/**
 * Called from game-engine after every bet.
 * Increments wagering_completed on bonus_claims where it counts,
 * marks claims completed when target reached.
 *
 * IMPORTANT: this also DEPLETS the user's wagering_required counter
 * on completion (so future bets don't continue "completing" the same bonus).
 *
 * @param userId     the betting user
 * @param betAmount  amount of the bet in coins
 * @returns number of claims completed by this bet
 */
export async function creditWagering(
  userId: string,
  betAmount: number,
  txClient?: QueryFn,
): Promise<{ claimsCompleted: number }> {
  // 1. Bump user-level wagering_completed (denormalized for fast UI)
  await q(txClient)(
    `UPDATE users
       SET wagering_completed_coins = wagering_completed_coins + $2
     WHERE id = $1`,
    [userId, betAmount],
  );

  // 2. Find active claims and bump them one by one (FIFO until exhausted)
  const activeClaims = await q(txClient)(
    `SELECT id, wagering_required FROM bonus_claims
     WHERE user_id = $1 AND status = 'active'
     ORDER BY claimed_at ASC
     FOR UPDATE`,
    [userId],
  );

  let remaining = betAmount;
  let claimsCompleted = 0;

  // Track per-claim wagering progress in bonus_claims.wagering_completed.
  // This is the correct model: each active claim has its own target, and
  // the user-level counters are aggregates. We FIFO-apply the bet amount
  // until it is exhausted or all claims are completed.
  for (const c of activeClaims.rows as Array<{ id: string; wagering_required: string | number; wagering_completed?: string | number }>) {
    if (remaining <= 0) break;

    const required = parseFloat(String(c.wagering_required));
    const completed = parseFloat(String(c.wagering_completed ?? 0));
    const need = Math.max(0, required - completed);
    if (need <= 0) continue;

    const apply = Math.min(remaining, need);
    const newCompleted = completed + apply;
    remaining -= apply;

    await q(txClient)(
      `UPDATE bonus_claims
          SET wagering_completed = $2,
              status = CASE WHEN $2 >= wagering_required THEN 'completed' ELSE status END,
              completed_at = CASE WHEN $2 >= wagering_required THEN NOW() ELSE completed_at END
        WHERE id = $1`,
      [c.id, newCompleted],
    );

    if (newCompleted >= required) {
      claimsCompleted += 1;
    }
  }

  // Keep user-level counters accurate: they should always reflect the
  // outstanding requirements and completed volume across all active claims.
  const aggRow = await q(txClient)(
    `SELECT COALESCE(SUM(wagering_required), 0) AS total_required,
            COALESCE(SUM(wagering_completed), 0) AS total_completed
     FROM bonus_claims
     WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  const agg = aggRow.rows[0];
  const totalRequired = parseFloat(String(agg.total_required ?? 0));
  const totalCompleted = parseFloat(String(agg.total_completed ?? 0));

  await q(txClient)(
    `UPDATE users
        SET wagering_required_coins = $2,
            wagering_completed_coins = $3
      WHERE id = $1`,
    [userId, totalRequired, totalCompleted],
  );

  if (claimsCompleted > 0) {
    await q(txClient)(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('bonus', 'bonus.wagering.completed', 'info', $1, $2)`,
      [
        userId,
        JSON.stringify({ claims_completed: claimsCompleted, total_wagered: totalCompleted }),
      ],
    );
  }

  return { claimsCompleted };
}

// ── 4. determineBalanceSource ──────────────────────────────────

export type BalanceSource = 'bonus' | 'withdrawable';

/**
 * Decide whether to debit bonus_balance or withdrawable_balance for a bet.
 * Rule: prefer bonus (so users feel their bonus is "in play") while
 * any active claim's wagering is incomplete AND bonus_balance has funds.
 */
export async function determineBalanceSource(
  userId: string,
  amount: number,
  txClient?: QueryFn,
): Promise<BalanceSource> {
  const row = await q(txClient)(
    `SELECT bonus_balance_coins, withdrawable_balance_coins, wagering_required_coins
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!row.rows.length) return 'withdrawable';
  const r0 = row.rows[0] as { bonus_balance_coins: string | number; withdrawable_balance_coins: string | number; wagering_required_coins: string | number };
  const bonus = parseFloat(String(r0.bonus_balance_coins || 0));
  const reqd = parseFloat(String(r0.wagering_required_coins || 0));
  const wdr  = parseFloat(String(r0.withdrawable_balance_coins || 0));

  // If user has active wagering requirement AND bonus covers the bet, use bonus
  if (reqd > 0 && bonus >= amount) return 'bonus';
  // Otherwise withdrawable (even if some bonus remains, fall through when not enough)
  return 'withdrawable';
}

// ── 5. debitBalanceForBet / creditPayout ───────────────────────

export async function debitBalanceForBet(
  userId: string,
  amount: number,
  source: BalanceSource,
  txClient?: QueryFn,
): Promise<{ success: boolean; newBalance: number; source: BalanceSource }> {
  const col = source === 'bonus' ? 'bonus_balance_coins' : 'withdrawable_balance_coins';
  const upd = await q(txClient)(
    `UPDATE users
       SET ${col} = ${col} - $2
     WHERE id = $1 AND ${col} >= $2
     RETURNING ${col} AS new_balance`,
    [userId, amount],
  );
  if (!upd.rows.length) {
    // Insufficient funds in this source — caller should retry with other source
    throw new Error(`insufficient_${source}_balance`);
  }
  const upd0 = upd.rows[0] as { new_balance: string | number };
  return { success: true, newBalance: parseFloat(String(upd0.new_balance)), source };
}

export async function creditPayout(
  userId: string,
  amount: number,
  source: BalanceSource,
  txClient?: QueryFn,
): Promise<void> {
  if (amount <= 0) return;
  const col = source === 'bonus' ? 'bonus_balance_coins' : 'withdrawable_balance_coins';
  await q(txClient)(
    `UPDATE users SET ${col} = ${col} + $2 WHERE id = $1`,
    [userId, amount],
  );
}

// ── 6. getBonusStatus ──────────────────────────────────────────

export async function getBonusStatus(
  userId: string,
  txClient?: QueryFn,
): Promise<BonusStatusSummary> {
  const claims = await q(txClient)(
    `SELECT id, bonus_type, amount_coins, wagering_required,
            max_withdrawal_allowed, expires_at, claimed_at, completed_at, status,
            EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400.0 AS days_remaining,
            metadata
     FROM bonus_claims
     WHERE user_id = $1
     ORDER BY claimed_at DESC`,
    [userId],
  );

  const user = await q(txClient)(
    `SELECT bonus_balance_coins, withdrawable_balance_coins,
            wagering_required_coins, wagering_completed_coins,
            total_bonus_claimed_coins, total_deposited_coins,
            EXTRACT(EPOCH FROM (NOW() - last_bonus_at)) / 3600.0 AS hours_since_bonus
     FROM users WHERE id = $1`,
    [userId],
  );

  const u = (user.rows[0] ?? {}) as {
    bonus_balance_coins?: string | number;
    withdrawable_balance_coins?: string | number;
    wagering_required_coins?: string | number;
    wagering_completed_coins?: string | number;
    total_bonus_claimed_coins?: string | number;
    total_deposited_coins?: string | number;
    hours_since_bonus?: string | number;
  };
  const bonusBal = parseFloat(String(u.bonus_balance_coins ?? 0));
  const wdrBal   = parseFloat(String(u.withdrawable_balance_coins ?? 0));
  const reqd    = parseFloat(String(u.wagering_required_coins ?? 0));
  const done    = parseFloat(String(u.wagering_completed_coins ?? 0));
  const totalDep = parseFloat(String(u.total_deposited_coins ?? 0));
  const totalBns = parseFloat(String(u.total_bonus_claimed_coins ?? 0));
  const hrsSince = parseFloat(String(u.hours_since_bonus ?? '9999'));

  const counts = { active: 0, completed: 0, expired: 0, forfeited: 0 };
  let minDepRequired = 0;
  const activeClaims: BonusStatusSummary['activeClaims'] = [];

  for (const r of claims.rows as Array<{
    id: string;
    bonus_type: string;
    amount_coins: string | number;
    wagering_required: string | number;
    expires_at: Date | string;
    status: string;
    days_remaining: string | number;
    metadata?: unknown;
  }>) {
    const s = r.status as BonusStatus;
    if (s in counts) (counts as Record<string, number>)[s]++;
    if (s === 'active') {
      const days = Math.max(0, parseFloat(String(r.days_remaining)));
      activeClaims.push({
        id: r.id,
        bonusType: r.bonus_type as BonusType,
        amountCoins: parseFloat(String(r.amount_coins)),
        wageringRequired: parseFloat(String(r.wagering_required)),
        wageringCompleted: 0, // tracked at user-level only
        expiresAt: new Date(r.expires_at),
        daysRemaining: Math.floor(days),
        status: 'active',
      });
      // Min deposit rule: user must deposit X% of active bonus total
      const pct = await getBonusCfgNumber('bonusMinDepositToWithdrawPct', 50);
      minDepRequired = Math.max(minDepRequired, (parseFloat(String(r.amount_coins)) * pct) / 100);
    }
  }

  const blockedReasons: string[] = [];
  if (reqd > done && reqd > 0) {
    blockedReasons.push(`wagering incomplete: ${(reqd - done).toFixed(2)} Coin remaining`);
  }
  if (totalDep < minDepRequired && minDepRequired > 0) {
    blockedReasons.push(`need deposit: ${(minDepRequired - totalDep).toFixed(2)} Coin more`);
  }
  if (hrsSince < 24) {
    const cooldown = await getBonusCfgNumber('bonusCooldownHours', 24);
    if (hrsSince < cooldown) {
      blockedReasons.push(`cooldown: ${(cooldown - hrsSince).toFixed(1)} hours remaining`);
    }
  }
  if ((claims.rows as Array<{ status: string }>).some((r) => r.status === 'expired')) {
    blockedReasons.push('expired bonus claim exists — contact support');
  }

  return {
    totalActive: counts.active,
    totalCompleted: counts.completed,
    totalExpired: counts.expired,
    totalForfeited: counts.forfeited,
    bonusBalanceCoins: bonusBal,
    withdrawableBalanceCoins: wdrBal,
    wageringRequiredCoins: reqd,
    wageringCompletedCoins: done,
    wageringPercentComplete: reqd > 0 ? Math.min(100, (done / reqd) * 100) : 100,
    totalBonusClaimedCoins: totalBns,
    totalDepositedCoins: totalDep,
    minDepositRequiredToWithdrawCoins: minDepRequired,
    canWithdrawNow: blockedReasons.length === 0 && wdrBal > 0,
    blockedReasons,
    activeClaims,
  };
}

// ── 7. validateWithdrawal ──────────────────────────────────────

/**
 * Pre-flight check before accepting a withdrawal request.
 * Returns either ok=true with available amount, or ok=false with reason.
 *
 * Checks (all must pass):
 *   1. wagering_completed >= wagering_required (no active bonus blocking)
 *   2. amount <= min(available withdrawable, max_withdrawal_allowed for bonuses, daily limit)
 *   3. no expired bonus claims outstanding
 *   4. KYC status = 'approved'
 *   5. user not flagged as suspicious (fraud_signals status='confirmed')
 */
export async function validateWithdrawal(
  userId: string,
  amount: number,
): Promise<WithdrawalValidationResult> {
  // Sanity: amount bounds
  const minW = await getBonusCfgNumber('withdrawalMinCoins', 1);
  const maxW = await getBonusCfgNumber('withdrawalMaxCoins', 10000);
  if (amount < minW) {
    return { ok: false, reason: 'amount_too_small',
             reasonBn: `সর্বনিম্ন উইথড্র ${minW} Coin` };
  }
  if (amount > maxW) {
    return { ok: false, reason: 'amount_too_large',
             reasonBn: `সর্বোচ্চ উইথড্র ${maxW} Coin` };
  }

  const status = await getBonusStatus(userId);
  const user = await query(
    `SELECT is_suspicious, withdrawable_balance_coins FROM users WHERE id = $1`,
    [userId],
  );
  const isSuspicious = user.rows[0]?.is_suspicious ?? false;
  const availCoins   = parseFloat(user.rows[0]?.withdrawable_balance_coins ?? 0);

  if (isSuspicious) {
    return { ok: false, reason: 'user_flagged',
             reasonBn: 'অ্যাকাউন্ট স্থগিত — সাপোর্ট যোগাযোগ করুন' };
  }

  if (status.wageringRequiredCoins > status.wageringCompletedCoins) {
    const remaining = status.wageringRequiredCoins - status.wageringCompletedCoins;
    return { ok: false, reason: 'wagering_incomplete',
             reasonBn: `বোনাস wagering অসম্পূর্ণ — ${remaining.toFixed(2)} Coin বেট করুন`,
             missingCoins: remaining };
  }

  if (status.minDepositRequiredToWithdrawCoins > status.totalDepositedCoins) {
    const missing = status.minDepositRequiredToWithdrawCoins - status.totalDepositedCoins;
    return { ok: false, reason: 'min_deposit_not_met',
             reasonBn: `বোনাস তুলতে ${missing.toFixed(2)} Coin ডিপোজিট করুন`,
             missingCoins: missing };
  }

  // KYC check
  const kyc = await query(
    `SELECT status FROM kyc_submissions
     WHERE user_id = $1
     ORDER BY submitted_at DESC LIMIT 1`,
    [userId],
  );
  const kycStatus = kyc.rows[0]?.status ?? 'none';
  if (kycStatus !== 'approved') {
    return { ok: false, reason: 'kyc_not_approved',
             reasonBn: 'KYC যাচাই সম্পন্ন করুন' };
  }

  // Cooldown check (if any bonus was granted recently)
  const cooldown = await getBonusCfgNumber('bonusCooldownHours', 24);
  if (status.totalActive > 0 || (status.totalBonusClaimedCoins > 0)) {
    // Only enforce cooldown if user has/had bonus recently
    const lastBonusRow = await query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - last_bonus_at)) / 3600.0 AS hours_ago
       FROM users WHERE id = $1 AND last_bonus_at IS NOT NULL`,
      [userId],
    );
    const hrsAgo = parseFloat(lastBonusRow.rows[0]?.hours_ago ?? 9999);
    if (hrsAgo < cooldown) {
      return { ok: false, reason: 'cooldown_active',
               reasonBn: `বোনাসের ${cooldown} ঘণ্টা কুলিং অফ চলছে (${(cooldown - hrsAgo).toFixed(1)} ঘণ্টা বাকি)` };
    }
  }

  // Max withdrawal from active bonus cap (sum of max_withdrawal_allowed across active claims)
  if (status.totalActive > 0) {
    const maxAllowedRow = await query(
      `SELECT COALESCE(SUM(max_withdrawal_allowed), 0) AS cap
       FROM bonus_claims
       WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    const cap = parseFloat(maxAllowedRow.rows[0]?.cap ?? 0);
    if (cap > 0 && amount > cap) {
      return { ok: false, reason: 'exceeds_bonus_cap',
               reasonBn: `বোনাস থেকে সর্বোচ্চ ${cap.toFixed(2)} Coin তুলতে পারবেন`,
               missingCoins: amount - cap };
    }
  }

  // Daily limit
  const dailyLimit = await getBonusCfgNumber('dailyWithdrawalLimitCoins', 5000);
  const todaySpent = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE user_id = $1
       AND type = 'withdrawal'
       AND status IN ('confirmed', 'pending')
       AND created_at >= date_trunc('day', NOW())`,
    [userId],
  );
  const spent = parseFloat(todaySpent.rows[0]?.total ?? 0);
  if (spent + amount > dailyLimit) {
    const remain = Math.max(0, dailyLimit - spent);
    return { ok: false, reason: 'daily_limit_reached',
             reasonBn: `আজকের দৈনিক সীমা ${dailyLimit} Coin — অবশিষ্ট ${remain.toFixed(2)} Coin`,
             missingCoins: amount - remain };
  }

  // Balance check
  if (amount > availCoins) {
    return { ok: false, reason: 'insufficient_balance',
             reasonBn: `আপনার withdrawable ব্যালেন্স ${availCoins.toFixed(2)} Coin`,
             missingCoins: amount - availCoins };
  }

  return { ok: true, availableCoins: availCoins };
}

// ── 8. expireBonuses (called by cron) ──────────────────────────

export async function expireBonuses(): Promise<{ expiredCount: number }> {
  // 1. Find all active claims past their expiry date
  const exp = await query(
    `UPDATE bonus_claims
       SET status = 'expired', completed_at = NOW()
     WHERE status = 'active' AND expires_at < NOW()
     RETURNING id, user_id, amount_coins`,
  );

  if (exp.rows.length === 0) return { expiredCount: 0 };

  // 2. For each expired claim, deduct from user's bonus_balance + reduce wagering_required proportionally
  for (const r of exp.rows) {
    await query(
      `UPDATE users
         SET bonus_balance_coins = GREATEST(0, bonus_balance_coins - $2),
             wagering_required_coins = GREATEST(0, wagering_required_coins - $3),
             wagering_completed_coins = LEAST(wagering_completed_coins,
                                              GREATEST(0, wagering_required_coins - $3))
       WHERE id = $1`,
      [r.user_id, parseFloat(r.amount_coins), parseFloat(r.amount_coins)],
    );

    // Fraud signal: expired bonus while user still has wagering incomplete
    await query(
      `INSERT INTO fraud_signals (signal_type, severity, related_user_id, status, metadata)
       VALUES ('bonus_expired_unused', 'medium', $1, 'open', $2)
       ON CONFLICT DO NOTHING`,
      [
        r.user_id,
        JSON.stringify({ bonus_claim_id: r.id, amount_coins: parseFloat(r.amount_coins) }),
      ],
    );

    await query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('bonus', 'bonus.expired', 'warn', $1, $2)`,
      [
        r.user_id,
        JSON.stringify({ bonus_claim_id: r.id, amount_coins: parseFloat(r.amount_coins) }),
      ],
    );
  }

  return { expiredCount: exp.rows.length };
}

// ── 9. createWithdrawalRequest ────────────────────────────────

/**
 * Create a pending withdrawal transaction after validation passes.
 * Returns the transaction row.
 */
export async function createWithdrawalRequest(
  userId: string,
  amount: number,
  metadata: Record<string, unknown> = {},
): Promise<{ id: string; status: string }> {
  // Check auto-approve threshold
  const threshold = await getBonusCfgNumber('withdrawalAutoApproveThreshold', 0);
  const autoApprove = threshold > 0 && amount <= threshold;

  const id = uuidv4();
  await withTransaction(async (tx) => {
    // Insert transaction row (debit)
    await tx(
      `INSERT INTO transactions
         (id, user_id, type, amount, currency, direction, status, metadata)
       VALUES ($1, $2, 'withdrawal', $3, 'COIN', 'debit', $4, $5)`,
      [
        id, userId, amount, autoApprove ? 'confirmed' : 'pending',
        JSON.stringify({
          ...metadata,
          requested_at: new Date().toISOString(),
          auto_approved: autoApprove,
        }),
      ],
    );

    // Debit from withdrawable_balance immediately (escrow)
    await tx(
      `UPDATE users
         SET withdrawable_balance_coins = withdrawable_balance_coins - $2,
             last_withdrawal_at = NOW()
       WHERE id = $1 AND withdrawable_balance_coins >= $2`,
      [userId, amount],
    );

    // Audit
    await tx(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('withdrawal', 'withdrawal.requested', 'info', $1, $2)`,
      [
        userId,
        JSON.stringify({ tx_id: id, amount, auto_approved: autoApprove }),
      ],
    );
  });

  return { id, status: autoApprove ? 'confirmed' : 'pending' };
}

// ── 10. approveWithdrawal / rejectWithdrawal (admin) ──────────

export async function approveWithdrawal(
  withdrawalId: string,
  adminUserId: string,
): Promise<{ ok: boolean }> {
  const tx = await query(
    `SELECT user_id, amount, status, metadata, currency FROM transactions
     WHERE id = $1 AND type = 'withdrawal'`,
    [withdrawalId],
  );
  if (!tx.rows.length) return { ok: false };
  if (tx.rows[0].status !== 'pending') return { ok: false };

  const metadata = typeof tx.rows[0].metadata === 'string' ? JSON.parse(tx.rows[0].metadata) : (tx.rows[0].metadata || {});
  const chain = metadata.chain || metadata.payout_chain || 'unknown';
  const token = metadata.currency || tx.rows[0].currency || 'USDT';

  await query(
    `UPDATE transactions
       SET status = 'confirmed', confirmed_at = NOW()
     WHERE id = $1`,
    [withdrawalId],
  );

  // For TRON/USDT withdrawals, enqueue a real on-chain payout job.
  if (chain === 'tron' || token === 'USDT' || token === 'TRX') {
    const { withdrawalPayoutQueue } = await import('./withdrawal-payout.worker');
    await withdrawalPayoutQueue.add('payout-tron', { txId: withdrawalId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
    });
  }
  await query(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('withdrawal', 'withdrawal.approved', 'info', $1, $2)`,
    [
      tx.rows[0].user_id,
      JSON.stringify({
        tx_id: withdrawalId, amount: parseFloat(tx.rows[0].amount),
        approved_by: adminUserId,
      }),
    ],
  );
  return { ok: true };
}

export async function rejectWithdrawal(
  withdrawalId: string,
  adminUserId: string,
  reason: string,
): Promise<{ ok: boolean; refundedCoins: number }> {
  const tx = await query(
    `SELECT user_id, amount, status FROM transactions
     WHERE id = $1 AND type = 'withdrawal'`,
    [withdrawalId],
  );
  if (!tx.rows.length) return { ok: false, refundedCoins: 0 };
  if (tx.rows[0].status !== 'pending') return { ok: false, refundedCoins: 0 };

  const amount = parseFloat(tx.rows[0].amount);
  const userId = tx.rows[0].user_id;

  await withTransaction(async (tx) => {
    await tx(
      `UPDATE transactions
         SET status = 'failed', confirmed_at = NOW(),
             metadata = metadata || jsonb_build_object('rejected_by', $2::text, 'rejection_reason', $3::text)
       WHERE id = $1`,
      [withdrawalId, adminUserId, reason],
    );
    // Refund the debited amount back to withdrawable
    await tx(
      `UPDATE users
         SET withdrawable_balance_coins = withdrawable_balance_coins + $2
       WHERE id = $1`,
      [userId, amount],
    );
    await tx(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('withdrawal', 'withdrawal.rejected', 'warn', $1, $2)`,
      [
        userId,
        JSON.stringify({
          tx_id: withdrawalId, amount, rejected_by: adminUserId, reason,
        }),
      ],
    );
  });
  return { ok: true, refundedCoins: amount };
}

// ── 11. Total withdrawable for user ───────────────────────────

export async function getWithdrawableCoins(userId: string): Promise<number> {
  const r = await query(
    `SELECT withdrawable_balance_coins FROM users WHERE id = $1`,
    [userId],
  );
  return parseFloat(r.rows[0]?.withdrawable_balance_coins ?? 0);
}