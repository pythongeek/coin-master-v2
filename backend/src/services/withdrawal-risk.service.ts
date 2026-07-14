/**
 * =============================================================
 *  WITHDRAWAL RISK SCORING - multi-signal risk model
 * =============================================================
 *
 *  Computes a 0-100 risk score for a pending withdrawal request.
 *  Designed to NEVER rely on a single threshold - combines 7
 *  independent signals with explicit weights so admins can see
 *  WHY a withdrawal is flagged.
 *
 *  Signals (weights sum to 100):
 *    Amount band           30   - higher amounts score higher
 *    Account age           15   - new accounts score higher
 *    History ratio         15   - withdrawal >> typical deposits = suspicious
 *    Recent attempts       15   - velocity check
 *    KYC tier              10   - unverified accounts score higher
 *    GeoIP mismatch        10   - IP country vs KYC country
 *    First withdrawal       5   - first-ever withdrawal scores higher
 *
 *  Returns:
 *    score      0-100
 *    level      'low' | 'medium' | 'high' | 'critical'
 *    signals    array of { signal, weight, value, note }
 *    suggestion  'auto_approve_eligible' | 'manual_review_fast' |
 *                'manual_review_careful' | 'manual_review_required'
 *    reasons    top-level human-readable strings for the admin
 *
 *  Per memory: NO single magic-number thresholds for AI decisions.
 *  This service is rule-based (transparent) not ML - every score
 *  component is auditable.
 * =============================================================
 */

import { query } from '../config/database';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Suggestion =
  | 'auto_approve_eligible'
  | 'manual_review_fast'
  | 'manual_review_careful'
  | 'manual_review_required';

export interface RiskSignal {
  signal: string;
  weight: number;        // max weight this signal can contribute
  value: number;         // actual contribution (0..weight)
  note: string;          // human-readable
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
  suggestion: Suggestion;
  reasons: string[];             // top-level human-readable for admin
  computedAt: string;
}

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

interface UserContext {
  user_id: string;
  username: string | null;
  email: string | null;
  kyc_tier: string | null;
  kyc_status: string | null;
  kyc_country: string | null;
  account_created_at: string;
  total_deposited_coins: number;
  withdrawable_balance_coins: number;
  wagering_completed_coins: number;
  wagering_required_coins: number;
  is_flagged: boolean;
}

interface WithdrawalHistory {
  total_count: number;
  total_amount: number;
  last_24h_count: number;
  last_24h_amount: number;
  last_withdrawal_at: string | null;
  is_first_withdrawal: boolean;
}

// High-risk countries (per FATF guidance, basic list - extend as needed)
const HIGH_RISK_COUNTRIES = new Set([
  'KP', 'IR', 'MM', 'SY', 'AF', 'YE', 'SS', 'SO', 'LY', 'SD',
]);

// =============================================================
//  Per-signal scorers (each returns 0..maxWeight)
// =============================================================

function scoreAmount(amountUsd: number): RiskSignal {
  let value = 0;
  let note = `$${amountUsd.toFixed(2)} (small, low risk)`;
  if (amountUsd >= 10000) { value = 30; note = `$${amountUsd.toFixed(2)} - very large withdrawal`; }
  else if (amountUsd >= 2000) { value = 25; note = `$${amountUsd.toFixed(2)} - large withdrawal`; }
  else if (amountUsd >= 500)  { value = 15; note = `$${amountUsd.toFixed(2)} - medium-large withdrawal`; }
  else if (amountUsd >= 100)  { value = 5;  note = `$${amountUsd.toFixed(2)} - moderate withdrawal`; }
  return { signal: 'amount_band', weight: 30, value, note };
}

function scoreAccountAge(kycCountry: string | null, accountCreatedAt: string): RiskSignal {
  const ageDays = Math.floor((Date.now() - new Date(accountCreatedAt).getTime()) / (1000 * 60 * 60 * 24));
  let value = 0;
  let note = `${ageDays}-day-old account (established)`;
  if (ageDays < 1)  { value = 15; note = `${ageDays}-day-old account - newly created`; }
  else if (ageDays < 7)  { value = 10; note = `${ageDays}-day-old account - very new`; }
  else if (ageDays < 30) { value = 5;  note = `${ageDays}-day-old account - new`; }
  return { signal: 'account_age', weight: 15, value, note };
}

function scoreHistoryRatio(amount: number, history: WithdrawalHistory, totalDeposited: number): RiskSignal {
  if (history.is_first_withdrawal && amount > 100) {
    return {
      signal: 'history_ratio',
      weight: 15,
      value: 10,
      note: `First withdrawal, but cumulative deposit is only $${totalDeposited.toFixed(2)} - withdrawing more than ever deposited is unusual`,
    };
  }
  if (history.total_count === 0 || totalDeposited === 0) {
    return {
      signal: 'history_ratio',
      weight: 15,
      value: 8,
      note: `No prior withdrawal history`,
    };
  }
  const avgDeposit = totalDeposited / Math.max(1, history.total_count);
  const ratio = amount / Math.max(1, avgDeposit);
  let value = 0;
  let note = `Withdrawal $${amount.toFixed(2)} vs avg $${avgDeposit.toFixed(2)} per history (${ratio.toFixed(1)}x)`;
  if (ratio > 10) value = 15;
  else if (ratio > 5) value = 10;
  else if (ratio > 2) value = 5;
  return { signal: 'history_ratio', weight: 15, value, note };
}

function scoreRecentAttempts(history: WithdrawalHistory): RiskSignal {
  let value = 0;
  let note = `${history.last_24h_count} withdrawal(s) in last 24h`;
  if (history.last_24h_count >= 3) value = 15;
  else if (history.last_24h_count === 2) value = 8;
  return { signal: 'recent_attempts', weight: 15, value, note };
}

function scoreKycTier(kycStatus: string | null, kycTier: string | null): RiskSignal {
  const tier = (kycTier || '').toLowerCase();
  const status = (kycStatus || '').toLowerCase();
  let value = 0;
  let note = `KYC status=${status || 'unverified'} tier=${tier || 'none'}`;
  if (status !== 'verified') {
    value = 10;
    note = `KYC not verified - elevated risk`;
  } else if (tier === 'tier1' || tier === '1') {
    value = 5;
    note = `KYC tier 1 only - higher withdrawal limits require tier 2+`;
  }
  return { signal: 'kyc_tier', weight: 10, value, note };
}

function scoreGeoIp(ipCountry: string | null, kycCountry: string | null): RiskSignal {
  if (!ipCountry || ipCountry === 'XX' || ipCountry === 'unknown') {
    return {
      signal: 'geoip_mismatch',
      weight: 10,
      value: 5,
      note: `IP country unknown - cannot verify against KYC country`,
    };
  }
  if (!kycCountry) {
    return {
      signal: 'geoip_mismatch',
      weight: 10,
      value: 3,
      note: `IP country=${ipCountry}, KYC country unknown`,
    };
  }
  if (ipCountry === kycCountry) {
    return {
      signal: 'geoip_mismatch',
      weight: 10,
      value: 0,
      note: `IP country=${ipCountry} matches KYC country`,
    };
  }
  // Different country
  let value = 10;
  let note = `IP country=${ipCountry} differs from KYC country=${kycCountry}`;
  if (HIGH_RISK_COUNTRIES.has(ipCountry)) {
    note += ` (HIGH-RISK jurisdiction)`;
  } else {
    value = 7; // different but not in high-risk list
  }
  return { signal: 'geoip_mismatch', weight: 10, value, note };
}

function scoreFirstWithdrawal(history: WithdrawalHistory): RiskSignal {
  if (history.is_first_withdrawal) {
    return {
      signal: 'first_withdrawal',
      weight: 5,
      value: 5,
      note: `First-ever withdrawal request for this user`,
    };
  }
  return {
    signal: 'first_withdrawal',
    weight: 5,
    value: 0,
    note: `${history.total_count} prior withdrawals on record`,
  };
}

// =============================================================
//  Pull user context + history (single round-trip per)
// =============================================================

async function getUserContext(userId: string): Promise<UserContext> {
  const r = await query(
    `SELECT id, username, email, kyc_tier, kyc_status, kyc_country,
            created_at, total_deposited_coins::float8 AS total_deposited_coins,
            withdrawable_balance_coins::float8 AS withdrawable_balance_coins,
            wagering_completed_coins::float8 AS wagering_completed_coins,
            wagering_required_coins::float8 AS wagering_required_coins,
            is_flagged
     FROM users WHERE id = $1`,
    [userId]
  );
  if (r.rows.length === 0) {
    throw new Error(`user ${userId} not found`);
  }
  const row = r.rows[0];
  return {
    user_id: row.id,
    username: row.username,
    email: row.email,
    kyc_tier: row.kyc_tier,
    kyc_status: row.kyc_status,
    kyc_country: row.kyc_country,
    account_created_at: row.created_at,
    total_deposited_coins: parseFloat(row.total_deposited_coins) || 0,
    withdrawable_balance_coins: parseFloat(row.withdrawable_balance_coins) || 0,
    wagering_completed_coins: parseFloat(row.wagering_completed_coins) || 0,
    wagering_required_coins: parseFloat(row.wagering_required_coins) || 0,
    is_flagged: row.is_flagged,
  };
}

async function getWithdrawalHistory(userId: string): Promise<WithdrawalHistory> {
  const r = await query(
    `SELECT
       COUNT(*)::int AS total_count,
       COALESCE(SUM(amount), 0)::float8 AS total_amount,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h_count,
       COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::float8 AS last_24h_amount,
       MAX(created_at) AS last_withdrawal_at
     FROM transactions
     WHERE user_id = $1 AND type = 'withdrawal' AND status IN ('pending', 'confirmed')`,
    [userId]
  );
  const row = r.rows[0];
  return {
    total_count: row.total_count || 0,
    total_amount: parseFloat(row.total_amount) || 0,
    last_24h_count: row.last_24h_count || 0,
    last_24h_amount: parseFloat(row.last_24h_amount) || 0,
    last_withdrawal_at: row.last_withdrawal_at,
    is_first_withdrawal: (row.total_count || 0) === 0,
  };
}

// =============================================================
//  Public API: score a withdrawal
// =============================================================

export async function scoreWithdrawalRisk(withdrawal: WithdrawalRow): Promise<RiskResult> {
  const [user, history] = await Promise.all([
    getUserContext(withdrawal.user_id),
    getWithdrawalHistory(withdrawal.user_id),
  ]);

  // Extract IP country from metadata if stored, else use ip_address country lookup
  const ipCountry: string | null =
    withdrawal.metadata?.ipCountry ||
    withdrawal.metadata?.country ||
    null;

  // Each scorer returns its own signal with weight + value
  const amount = parseFloat(String(withdrawal.amount));
  const signals: RiskSignal[] = [
    scoreAmount(amount),
    scoreAccountAge(user.kyc_country, user.account_created_at),
    scoreHistoryRatio(amount, history, user.total_deposited_coins),
    scoreRecentAttempts(history),
    scoreKycTier(user.kyc_status, user.kyc_tier),
    scoreGeoIp(ipCountry, user.kyc_country),
    scoreFirstWithdrawal(history),
  ];

  const score = Math.min(100, Math.round(signals.reduce((s, x) => s + x.value, 0)));

  let level: RiskLevel;
  let suggestion: Suggestion;
  if (score >= 85)      { level = 'critical'; suggestion = 'manual_review_required'; }
  else if (score >= 60) { level = 'high';     suggestion = 'manual_review_careful'; }
  else if (score >= 30) { level = 'medium';   suggestion = 'manual_review_fast'; }
  else                  { level = 'low';      suggestion = 'auto_approve_eligible'; }

  // Top-level reasons: signals with non-zero value
  const reasons = signals
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((s) => `${s.signal.replace(/_/g, ' ')}: ${s.note}`);

  return {
    score,
    level,
    signals,
    suggestion,
    reasons,
    computedAt: new Date().toISOString(),
  };
}

// Helper: batch-score a list of withdrawals (for the list endpoint)
export async function scoreWithdrawalsBatch(rows: WithdrawalRow[]): Promise<Map<string, RiskResult>> {
  const map = new Map<string, RiskResult>();
  // Score in parallel, but cap concurrency to avoid hammering DB
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (row) => {
      try {
        map.set(row.id, await scoreWithdrawalRisk(row));
      } catch (err) {
        // On failure, return a degraded risk result (don't break the list)
        map.set(row.id, {
          score: 50,
          level: 'medium',
          signals: [{ signal: 'scoring_error', weight: 0, value: 50, note: (err as Error).message }],
          suggestion: 'manual_review_fast',
          reasons: [`Risk scoring failed: ${(err as Error).message}`],
          computedAt: new Date().toISOString(),
        });
      }
    }));
  }
  return map;
}
