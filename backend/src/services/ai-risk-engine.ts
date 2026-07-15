/**
 * Phase 1.2 — AI Risk Score Engine (L15, L16, L17, L18)
 *
 * Rule-based scoring per the v2.0 spec. Each "signal" has a weight;
 * the score is the sum of all matched signals (capped at 100).
 * Mitigating signals subtract.
 *
 * Why rule-based first:
 *   - Deterministic + auditable (admin can see exactly why a user is flagged)
 *   - No training data dependency (ML layer is Phase 3)
 *   - Cheap (no model inference, ~microseconds)
 *
 * `recalculateRisk(userId)` is the entry point used by signup, login,
 * deposit, bet, withdrawal handlers. It loads all the relevant signals
 * from the DB, computes the score, persists the breakdown to
 * user_risk_scores, and updates users.risk_score / risk_tier.
 */

import { query } from '../config/database';

// ── Types ────────────────────────────────────────────────────────

export type RiskTier = 'safe' | 'low_risk' | 'medium_risk' | 'high_risk' | 'critical';

export interface RiskSignal {
  /** Code-name of the signal, e.g. 'tor_detected' */
  code: string;
  /** Signed weight: positive = risk, negative = mitigator */
  weight: number;
  /** Human-readable explanation, surfaced in admin UI */
  detail: string;
}

export interface RiskActions {
  bonusClaimAllowed: boolean;
  withdrawalAllowed: boolean;
  requireExtra2FA: boolean;
  adminAlert: boolean;
  enhancedMonitoring?: boolean;
  autoSuspend?: boolean;
  adminAlertPriority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface RiskScore {
  userId: string;
  score: number;          // 0-100, capped
  tier: RiskTier;
  signals: RiskSignal[];  // ALL matched signals (positive + mitigator)
  actions: RiskActions;
  calculatedAt: Date;
  calculatedBy: 'rule_engine' | 'ml_model';
}

// ── Tier + action tables (from v2.0 spec) ────────────────────────

export function scoreToTier(score: number): RiskTier {
  if (score >= 85) return 'critical';
  if (score >= 70) return 'high_risk';
  if (score >= 50) return 'medium_risk';
  if (score >= 30) return 'low_risk';
  return 'safe';
}

export function tierToActions(tier: RiskTier): RiskActions {
  switch (tier) {
    case 'safe':       return { bonusClaimAllowed: true,  withdrawalAllowed: true,  requireExtra2FA: false, adminAlert: false };
    case 'low_risk':   return { bonusClaimAllowed: true,  withdrawalAllowed: true,  requireExtra2FA: false, adminAlert: false, enhancedMonitoring: true };
    case 'medium_risk':return { bonusClaimAllowed: true,  withdrawalAllowed: true,  requireExtra2FA: true,  adminAlert: false };
    case 'high_risk':  return { bonusClaimAllowed: false, withdrawalAllowed: false, requireExtra2FA: true,  adminAlert: true,  adminAlertPriority: 'high' };
    case 'critical':   return { bonusClaimAllowed: false, withdrawalAllowed: false, requireExtra2FA: false, adminAlert: true,  adminAlertPriority: 'critical', autoSuspend: true };
  }
}

// ── Pure scoring function (no DB) ────────────────────────────────

/**
 * Sum signal weights, capped at [0, 100].
 * Pure function — unit-testable. The DB-loading variant lives in
 * `recalculateRisk` below.
 */
export function scoreFromSignals(signals: RiskSignal[]): number {
  let total = 0;
  for (const s of signals) total += s.weight;
  if (total < 0) return 0;
  if (total > 100) return 100;
  return Math.round(total);
}

/**
 * Build a RiskScore from already-computed signals.
 * Pure: just maps signals → score → tier → actions.
 */
export function buildRiskScore(
  userId: string,
  signals: RiskSignal[],
  calculatedBy: 'rule_engine' | 'ml_model' = 'rule_engine',
): RiskScore {
  const score = scoreFromSignals(signals);
  const tier = scoreToTier(score);
  return {
    userId,
    score,
    tier,
    signals,
    actions: tierToActions(tier),
    calculatedAt: new Date(),
    calculatedBy,
  };
}

// ── Signal collection (queries the DB) ──────────────────────────

interface UserContext {
  userId: string;
  ipIsTor: boolean;
  ipIsDatacenter: boolean;
  ipIsKnownFraudster: boolean;
  highRiskCountry: boolean;
  kycStatus: 'approved' | 'pending' | 'rejected' | 'expired' | 'none';
  kycDuplicate: boolean;
  failedKycCount: number;
  deviceAccountCount: number;
  depositToClaimLatencySec: number | null;     // null if no claim yet
  wageringCompletionMinutes: number | null;
  withdrawalLatencyMinutes: number | null;    // since wagering complete
  accountAgeDays: number;
  betAmountVariance: number | null;
  onlyBonusBets: boolean;
  botLikeClickTiming: boolean;
  referralChainParticipant: boolean;
  selfReferralSignal: boolean;
  affiliateAbuse: boolean;
  disposableEmail: boolean;
  voipPhone: boolean;
  impossibleTravel: boolean;
  withdrawalPatternMatch: boolean;
}

/**
 * Load every signal-relevant piece of context for a user.
 * Cheap: one query per signal category. If a query fails (e.g. table
 * not yet exists), the signal is simply treated as "not triggered"
 * so the engine never crashes the host.
 */
export async function loadUserContext(userId: string): Promise<UserContext> {
  const ctx: UserContext = {
    userId,
    ipIsTor: false, ipIsDatacenter: false, ipIsKnownFraudster: false,
    highRiskCountry: false,
    kycStatus: 'none', kycDuplicate: false, failedKycCount: 0,
    deviceAccountCount: 0,
    depositToClaimLatencySec: null,
    wageringCompletionMinutes: null,
    withdrawalLatencyMinutes: null,
    accountAgeDays: 0,
    betAmountVariance: null,
    onlyBonusBets: false,
    botLikeClickTiming: false,
    referralChainParticipant: false,
    selfReferralSignal: false,
    affiliateAbuse: false,
    disposableEmail: false,
    voipPhone: false,
    impossibleTravel: false,
    withdrawalPatternMatch: false,
  };

  // 1. User base + KYC + account age
  const userRow = await query(
    `SELECT
       COALESCE(u.created_at, NOW()) AS created_at,
       COALESCE(u.risk_score, 0)    AS risk_score,
       u.kyc_status,
       u.kyc_country,
       u.device_count,
       (SELECT status FROM kyc_submissions WHERE user_id = u.id ORDER BY submitted_at DESC LIMIT 1) AS latest_kyc_status
     FROM users u
     WHERE u.id = $1`,
    [userId],
  );
  if (userRow.rows.length === 0) return ctx;
  const u = userRow.rows[0] as {
    created_at: Date;
    risk_score: number;
    kyc_status: string | null;
    kyc_country: string | null;
    device_count: number | null;
    latest_kyc_status: string | null;
  };
  ctx.accountAgeDays = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86_400_000);
  ctx.kycStatus = (u.latest_kyc_status ?? u.kyc_status ?? 'none') as UserContext['kycStatus'];
  ctx.deviceAccountCount = u.device_count ?? 0;
  ctx.highRiskCountry = (u.kyc_country ?? '').toUpperCase() === 'XX' || (u.kyc_country ?? '').toUpperCase() === 'YY';

  // 2. KYC duplicate check (Phase 1.1 backstop)
  try {
    const dup = await query(
      `SELECT user_id FROM kyc_submissions
        WHERE (national_id_hash IN (SELECT national_id_hash FROM kyc_submissions WHERE user_id = $1 AND status='approved')
            OR passport_hash IN (SELECT passport_hash FROM kyc_submissions WHERE user_id = $1 AND status='approved'))
          AND user_id <> $1 AND status = 'approved'
        LIMIT 1`,
      [userId],
    );
    ctx.kycDuplicate = dup.rows.length > 0;
    if (ctx.kycDuplicate) {
      const cnt = await query(
        `SELECT COUNT(*)::int AS n FROM kyc_submissions WHERE user_id = $1 AND status = 'rejected'`,
        [userId],
      );
      ctx.failedKycCount = (cnt.rows[0] as { n: number }).n ?? 0;
    }
  } catch { /* table missing or column missing */ }

  // 3. Recent fraud signals (Phase 1.3 / 1.4 hooks will populate this)
  try {
    const sigs = await query(
      `SELECT signal_type FROM fraud_signals
        WHERE user_id = $1 AND detected_at > NOW() - INTERVAL '30 days'`,
      [userId],
    );
    for (const row of sigs.rows as Array<{ signal_type: string }>) {
      const t = row.signal_type;
      if (t === 'ip_tor' || t === 'ip_vpn_proxy') ctx.ipIsTor = true;
      if (t === 'ip_datacenter') ctx.ipIsDatacenter = true;
      if (t === 'ip_known_fraudster') ctx.ipIsKnownFraudster = true;
      if (t === 'bot_click_timing') ctx.botLikeClickTiming = true;
      if (t === 'impossible_travel') ctx.impossibleTravel = true;
      if (t === 'self_referral') ctx.selfReferralSignal = true;
      if (t === 'referral_chain') ctx.referralChainParticipant = true;
      if (t === 'withdrawal_abuser_pattern') ctx.withdrawalPatternMatch = true;
      if (t === 'disposable_email') ctx.disposableEmail = true;
      if (t === 'voip_phone') ctx.voipPhone = true;
    }
  } catch { /* table missing */ }

  // 4. Withdrawal latency (since latest wagering completion).
  // Withdrawals are tracked as rows in `transactions` (type='withdrawal'),
  // not a dedicated `withdrawals` table — adjust query to match.
  try {
    const wr = await query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(wagering_completed_at))) / 60.0 AS minutes
         FROM (
           SELECT MAX(completed_at) AS wagering_completed_at
             FROM bonus_claims
            WHERE user_id = $1 AND status = 'completed'
         ) w
       WHERE EXISTS (
         SELECT 1 FROM transactions
          WHERE user_id = $1 AND type = 'withdrawal'
            AND created_at > NOW() - INTERVAL '24 hours'
       )`,
      [userId],
    );
    if (wr.rows.length > 0) {
      const m = parseFloat(String((wr.rows[0] as { minutes: string | null }).minutes ?? ''));
      if (Number.isFinite(m)) ctx.withdrawalLatencyMinutes = m;
    }
  } catch { /* withdrawal latency only relevant if user has history */ }

  // Phase 2.1: behavioral-analytics fills the previously-stub fields
  // (depositToClaimLatencySec, betAmountVariance, botLikeClickTiming,
  // onlyBonusBets) from real transactions data. Best-effort — if the
  // behavioral service fails, we keep the stub defaults (null/false).
  try {
    const { getBehavioralContext } = await import('./behavioral-analytics');
    const beh = await getBehavioralContext(userId);
    if (beh.depositToClaimLatencySec !== null) ctx.depositToClaimLatencySec = beh.depositToClaimLatencySec;
    if (beh.betAmountVariance !== null) ctx.betAmountVariance = beh.betAmountVariance;
    ctx.onlyBonusBets = beh.onlyBonusBets;
    ctx.botLikeClickTiming = beh.botLikeClickTiming;
  } catch { /* behavioral service unavailable — keep stub defaults */ }

  return ctx;
}

// ── Map context → signals (weights from v2.0 spec) ──────────────

const SIGNAL_WEIGHTS = {
  tor: +30, datacenter: +25, device3plus: +40, kycDup: +50,
  sameIpFraudster: +45, fastDepositClaim: +20, fastWagering: +25,
  fastWithdrawal: +20, lowBetVariance: +20, onlyBonusBets: +15,
  youngAccountWithdraw: +15, impossibleTravel: +30,
  selfReferral: +35, disposableEmail: +20, voip: +15,
  botTiming: +25, highRiskCountry: +10, referralChain: +10,
  withdrawalPattern: +30, failedKyc: +15,
  kycVerified: -15, accountAge30Clean: -10,
  recreationalBets: -10, consistentDevice: -5,
} as const;

export function signalsFromContext(ctx: UserContext): RiskSignal[] {
  const s: RiskSignal[] = [];

  if (ctx.ipIsTor) s.push({ code: 'tor_detected', weight: SIGNAL_WEIGHTS.tor, detail: 'Tor/proxy IP detected' });
  if (ctx.ipIsDatacenter) s.push({ code: 'datacenter_ip', weight: SIGNAL_WEIGHTS.datacenter, detail: 'Datacenter/cloud IP (common bot origin)' });
  if (ctx.deviceAccountCount >= 3) s.push({ code: 'device_3plus', weight: SIGNAL_WEIGHTS.device3plus, detail: `Device linked to ${ctx.deviceAccountCount} accounts` });
  if (ctx.kycDuplicate) s.push({ code: 'kyc_duplicate', weight: SIGNAL_WEIGHTS.kycDup, detail: 'Same KYC ID on another approved account' });
  if (ctx.ipIsKnownFraudster) s.push({ code: 'same_ip_fraudster', weight: SIGNAL_WEIGHTS.sameIpFraudster, detail: 'IP matches a known fraudster' });
  if (ctx.depositToClaimLatencySec !== null && ctx.depositToClaimLatencySec < 30)
    s.push({ code: 'fast_deposit_claim', weight: SIGNAL_WEIGHTS.fastDepositClaim, detail: `Deposit→claim latency ${ctx.depositToClaimLatencySec}s (<30s)` });
  if (ctx.wageringCompletionMinutes !== null && ctx.wageringCompletionMinutes < 10)
    s.push({ code: 'fast_wagering', weight: SIGNAL_WEIGHTS.fastWagering, detail: `Wagering done in ${Math.round(ctx.wageringCompletionMinutes)}m (<10m)` });
  if (ctx.withdrawalLatencyMinutes !== null && ctx.withdrawalLatencyMinutes < 60)
    s.push({ code: 'fast_withdrawal', weight: SIGNAL_WEIGHTS.fastWithdrawal, detail: `Withdrawal ${Math.round(ctx.withdrawalLatencyMinutes)}m after wagering (<1h)` });
  if (ctx.betAmountVariance !== null && ctx.betAmountVariance < 0.01)
    s.push({ code: 'low_bet_variance', weight: SIGNAL_WEIGHTS.lowBetVariance, detail: `Bet amount variance ${ctx.betAmountVariance} (suspicious)` });
  if (ctx.onlyBonusBets) s.push({ code: 'only_bonus_bets', weight: SIGNAL_WEIGHTS.onlyBonusBets, detail: 'User only bets with bonus balance' });
  if (ctx.accountAgeDays < 1 && ctx.withdrawalLatencyMinutes !== null)
    s.push({ code: 'young_account_withdraw', weight: SIGNAL_WEIGHTS.youngAccountWithdraw, detail: `First withdrawal at account age ${ctx.accountAgeDays}d` });
  if (ctx.impossibleTravel) s.push({ code: 'impossible_travel', weight: SIGNAL_WEIGHTS.impossibleTravel, detail: 'Impossible-travel between sessions' });
  if (ctx.selfReferralSignal) s.push({ code: 'self_referral', weight: SIGNAL_WEIGHTS.selfReferral, detail: 'Affiliate self-referral pattern' });
  if (ctx.disposableEmail) s.push({ code: 'disposable_email', weight: SIGNAL_WEIGHTS.disposableEmail, detail: 'Disposable email domain' });
  if (ctx.voipPhone) s.push({ code: 'voip_phone', weight: SIGNAL_WEIGHTS.voip, detail: 'VoIP/virtual phone prefix' });
  if (ctx.botLikeClickTiming) s.push({ code: 'bot_click_timing', weight: SIGNAL_WEIGHTS.botTiming, detail: 'Bot-like click interval variance' });
  if (ctx.highRiskCountry) s.push({ code: 'high_risk_country', weight: SIGNAL_WEIGHTS.highRiskCountry, detail: 'High-risk country code' });
  if (ctx.referralChainParticipant) s.push({ code: 'referral_chain', weight: SIGNAL_WEIGHTS.referralChain, detail: 'Member of a referral chain' });
  if (ctx.withdrawalPatternMatch) s.push({ code: 'withdrawal_abuser_pattern', weight: SIGNAL_WEIGHTS.withdrawalPattern, detail: 'Withdrawal pattern matches known abuser cohort' });
  if (ctx.failedKycCount > 1) s.push({ code: 'failed_kyc_multiple', weight: SIGNAL_WEIGHTS.failedKyc, detail: `${ctx.failedKycCount} failed KYC submissions` });

  // ── Mitigators ──
  // KYC verified + KYC duplicate is contradictory: if a duplicate was
  // found, the verification is compromised. Don't credit the mitigator.
  if (ctx.kycStatus === 'approved' && !ctx.kycDuplicate)
    s.push({ code: 'kyc_verified', weight: SIGNAL_WEIGHTS.kycVerified, detail: 'KYC fully verified' });
  if (ctx.accountAgeDays > 30)
    s.push({ code: 'account_age_30_clean', weight: SIGNAL_WEIGHTS.accountAge30Clean, detail: 'Account > 30 days old' });
  if (ctx.deviceAccountCount === 1 && ctx.accountAgeDays > 7)
    s.push({ code: 'consistent_device', weight: SIGNAL_WEIGHTS.consistentDevice, detail: 'Single device used for 7+ days' });

  return s;
}

// ── DB persistence ──────────────────────────────────────────────

/**
 * Recompute a user's risk score, persist, and update users.risk_score/tier.
 * Cheap enough to call from signup, deposit, withdrawal handlers.
 */
export async function recalculateRisk(userId: string): Promise<RiskScore> {
  const ctx = await loadUserContext(userId);
  const signals = signalsFromContext(ctx);
  const result = buildRiskScore(userId, signals, 'rule_engine');

  // Persist: upsert history table + flip users.risk_score
  // PostgreSQL needs an explicit type for $2 wherever it's used inside
  // JSON-construction expressions — pass it twice (once typed int, once
  // typed text) so the planner never has to guess.
  const scoreInt = Number(result.score);
  const scoreText = String(result.score);
  const tierText = String(result.tier);
  const breakdown = JSON.stringify({ signals });
  await query(
    `INSERT INTO user_risk_scores
       (user_id, current_score, tier, score_breakdown, last_calculated, calculated_by, history)
     VALUES ($1::uuid, $2::int, $3::text, $4::jsonb, NOW(), $5::text,
             jsonb_build_array(jsonb_build_object('score', $6::text, 'tier', $7::text, 'at', NOW())))
     ON CONFLICT (user_id) DO UPDATE SET
       current_score   = EXCLUDED.current_score,
       tier            = EXCLUDED.tier,
       score_breakdown = EXCLUDED.score_breakdown,
       last_calculated = EXCLUDED.last_calculated,
       calculated_by   = EXCLUDED.calculated_by,
       history         = (
         (SELECT history FROM user_risk_scores WHERE user_id = $1) ||
         jsonb_build_array(jsonb_build_object('score', $6::text, 'tier', $7::text, 'at', NOW()))
       )::jsonb`,
    [userId, scoreInt, tierText, breakdown, 'rule_engine', scoreText, tierText],
  );

  // Cap history at 10
  await query(
    `UPDATE user_risk_scores
        SET history = (
          SELECT jsonb_agg(elem)
            FROM (
              SELECT elem
                FROM jsonb_array_elements(history) WITH ORDINALITY AS e(elem, ord)
               ORDER BY ord DESC
               LIMIT 10
            ) recent
        )
      WHERE user_id = $1`,
    [userId],
  );

  // Mirror onto users row
  await query(
    `UPDATE users SET risk_score = $2::int, risk_tier = $3 WHERE id = $1`,
    [userId, result.score, result.tier],
  );

  return result;
}

/**
 * Quick read of the current score without recomputing. For hot paths.
 */
export async function getRiskScore(userId: string): Promise<RiskScore | null> {
  const r = await query(
    `SELECT current_score, tier, score_breakdown, last_calculated, calculated_by
       FROM user_risk_scores
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as {
    current_score: number;
    tier: RiskTier;
    score_breakdown: { signals?: RiskSignal[] };
    last_calculated: Date;
    calculated_by: 'rule_engine' | 'ml_model';
  };
  const signals = (row.score_breakdown?.signals ?? []) as RiskSignal[];
  const score = row.current_score;
  const tier = row.tier;
  return {
    userId,
    score,
    tier,
    signals,
    actions: tierToActions(tier),
    calculatedAt: new Date(row.last_calculated),
    calculatedBy: row.calculated_by,
  };
}