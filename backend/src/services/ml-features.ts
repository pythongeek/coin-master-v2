/**
 * Phase 3 / P3-1b — ML Feature Extractor
 *
 * Builds a fixed-length numeric feature vector for a single user. The
 * vector shape + column order is the contract between this service and
 * the trained XGBoost model in `ml/notebooks/ml-training-pipeline.ipynb`.
 * If you change FEATURE_COLUMNS, retrain.
 *
 * Features (32 — all uint/float, no strings — XGBoost requires numeric):
 *   user-side:
 *     account_age_hours, account_age_days, account_age_log_days
 *   KYC:
 *     kyc_verified (0/1), kyc_tier (0..3), high_risk_country (0/1),
 *     attempted_kyc_24h (count), failed_kyc_24h (count)
 *   velocity (from transactions table, last N days):
 *     tx_total_1h, tx_total_24h, tx_total_7d, bet_count_24h,
 *     deposit_count_24h, distinct_devices_30d, distinct_ips_30d,
 *     deposit_amount_total_30d, withdrawal_amount_total_30d
 *   risk-engine signals (from fraud_signals):
 *     n_open_fraud_signals, has_tor, has_datacenter, has_known_fraud,
 *     has_bot_click, has_self_referral, has_impossible_travel
 *   from Phase 2.1 behavioral-analytics (computed when available):
 *     bet_amount_variance, bets_per_minute_avg, game_variety_index,
 *     only_bonus_bets (0/1), bot_like_click_timing (0/1)
 *   Phase 2.4 IP reputation:
 *     ip_abuse_score (0..100), ip_is_blocklisted (0/1)
 *
 * Missing values default to: numeric=0, ratio=0, count=0. None of the
 * columns are NaN — XGBoost accepts missing via sparse representation
 * but we pre-fill for portability with onnx-runtime.
 */

import { query } from '../config/database';
import { getAdminSetting } from './admin-settings.service';

export const FEATURE_COLUMNS: string[] = [
  // user (3)
  'account_age_hours', 'account_age_days', 'account_age_log_days',
  // kyc (5)
  'kyc_verified', 'kyc_tier', 'high_risk_country',
  'attempted_kyc_24h', 'failed_kyc_24h',
  // velocity (9)
  'tx_total_1h', 'tx_total_24h', 'tx_total_7d', 'bet_count_24h',
  'deposit_count_24h', 'distinct_devices_30d', 'distinct_ips_30d',
  'deposit_amount_total_30d', 'withdrawal_amount_total_30d',
  // fraud-signals (7)
  'n_open_fraud_signals', 'has_tor', 'has_datacenter', 'has_known_fraud',
  'has_bot_click', 'has_self_referral', 'has_impossible_travel',
  // behavioral (6)
  'bet_amount_variance', 'bets_per_minute_avg', 'game_variety_index',
  'only_bonus_bets', 'bot_like_click_timing', 'session_duration_avg_minutes',
  // ip reputation (2)
  'ip_abuse_score', 'ip_is_blocklisted',
  // P3-2d: deepfake risk signal (3) — NULL→0 until admin enables the
  // detector. Adding to the END keeps backward-compat with any model
  // trained on the 32-column version (feature_columns JSONB on
  // ml_models controls which subset the model actually uses).
  'deepfake_score', 'deepfake_check_recent', 'kyc_deepfake_strictness',
];

const HIGH_RISK_COUNTRIES = new Set([
  // FATF black/grey list + the standard "high-fraud" set used by Sift/etc.
  // (kept short and conservative — admin can override via admin_settings)
  'IR', 'KP', 'MM', 'SY', 'AF', 'YE',
]);

export interface FeatureVector {
  userId: string;
  vector: number[];                  // length === FEATURE_COLUMNS.length
  columns: string[];                 // === FEATURE_COLUMNS (sanity)
  computedAt: Date;
  durationMs: number;
}

const NUM = (x: unknown): number => {
  const n = typeof x === 'string' ? parseFloat(x) : (x as number);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pure-side helper: build the feature vector from a row-bundle read
 * from `loadUserSignals()`. Used both by extractFeatureVector (live
 * extraction) and by the training notebook (via SQL export of the
 * same shape). Keeping this pure makes test coverage trivial.
 */
export function buildFeatureVectorFromRows(
  userId: string,
  userRow: any | null,
  kycRow: any | null,
  velocityRows: {
    tx_total_1h: number; tx_total_24h: number; tx_total_7d: number;
    bet_count_24h: number; deposit_count_24h: number;
    distinct_devices_30d: number; distinct_ips_30d: number;
    deposit_amount_total_30d: number; withdrawal_amount_total_30d: number;
  },
  signalCounts: { open: number; [k: string]: number },
  behavioral: {
    bet_amount_variance: number | null; bets_per_minute_avg: number | null;
    game_variety_index: number | null; only_bonus_bets: boolean;
    bot_like_click_timing: boolean; session_duration_avg_minutes: number | null;
  },
  ipRep: { abuse_score: number; is_blocklisted: 0 | 1 },
  deepfake: { score: number | null; check_recent: boolean; strictness: number },
): number[] {
  // user-side
  const createdAt = userRow?.created_at ? new Date(userRow.created_at).getTime() : Date.now();
  const ageMs = Date.now() - createdAt;
  const ageH = Math.max(0, ageMs / 3_600_000);
  const ageDays = Math.max(0, ageMs / 86_400_000);
  const ageLog = Math.log1p(Math.max(0, ageDays));

  // KYC + country risk
  const kycVerified = userRow?.kyc_verified_at ? 1 : 0;
  const kycTier = NUM(userRow?.kyc_tier);
  const country = String(userRow?.kyc_country || '').toUpperCase();
  const highRisk = HIGH_RISK_COUNTRIES.has(country) ? 1 : 0;

  const attempted24 = NUM(kycRow?.attempted_24h);
  const failed24 = NUM(kycRow?.failed_24h);

  // fraud-signals
  const sTotal = NUM(signalCounts.open);
  const getSig = (k: string) => (NUM(signalCounts[k]) > 0 ? 1 : 0);

  const v: number[] = [
    // user (3)
    ageH, ageDays, ageLog,
    // kyc (5)
    kycVerified, kycTier, highRisk,
    attempted24, failed24,
    // velocity (9)
    NUM(velocityRows.tx_total_1h), NUM(velocityRows.tx_total_24h),
    NUM(velocityRows.tx_total_7d), NUM(velocityRows.bet_count_24h),
    NUM(velocityRows.deposit_count_24h), NUM(velocityRows.distinct_devices_30d),
    NUM(velocityRows.distinct_ips_30d), NUM(velocityRows.deposit_amount_total_30d),
    NUM(velocityRows.withdrawal_amount_total_30d),
    // signals (7)
    sTotal,
    getSig('ip_tor'), getSig('ip_vpn_proxy'), getSig('ip_known_fraudster'),
    getSig('bot_click_timing'), getSig('self_referral'), getSig('impossible_travel'),
    // behavioral (6)
    behavioral.bet_amount_variance ?? 0,
    behavioral.bets_per_minute_avg ?? 0,
    behavioral.game_variety_index ?? 1,
    behavioral.only_bonus_bets ? 1 : 0,
    behavioral.bot_like_click_timing ? 1 : 0,
    behavioral.session_duration_avg_minutes ?? 0,
    // ip reputation (2)
    ipRep.abuse_score,
    ipRep.is_blocklisted,
    // P3-2d: deepfake (3). Until the detector is enabled these all
    // resolve to 0 via NUM(), so existing trained models see a
    // neutral feature vector and the new columns are inert until the
    // operator opts in + retrains.
    deepfake.score ?? 0,
    deepfake.check_recent ? 1 : 0,
    deepfake.strictness,
  ];

  // Sanity: must match FEATURE_COLUMNS length exactly.
  if (v.length !== FEATURE_COLUMNS.length) {
    throw new Error(
      `Feature vector length mismatch: got ${v.length} expected ${FEATURE_COLUMNS.length}. ` +
      `Check FEATURE_COLUMNS ordering.`,
    );
  }
  return v;
}

interface UserRow { created_at: Date; kyc_verified_at: Date | null; kyc_tier: number | null; kyc_country: string | null }
interface KycRow { attempted_24h: number; failed_24h: number }
interface VelocityRow {
  tx_total_1h: number; tx_total_24h: number; tx_total_7d: number;
  bet_count_24h: number; deposit_count_24h: number;
  distinct_devices_30d: number; distinct_ips_30d: number;
  deposit_amount_total_30d: number; withdrawal_amount_total_30d: number;
}

/**
 * Live extraction: do all the DB reads in parallel, build the vector.
 * Best-effort: any failed query becomes 0s for that feature group so
 * the call never blocks the rule engine.
 */
export async function extractFeatureVector(userId: string): Promise<FeatureVector> {
  const t0 = Date.now();
  try {
    // 1. user base
    const userRes = await query(
      `SELECT created_at, kyc_verified_at, kyc_tier, kyc_country
         FROM users WHERE id = $1::uuid LIMIT 1`,
      [userId],
    );
    const userRow: UserRow | null = (userRes.rows[0] as UserRow | undefined) ?? null;

    // 2. KYC attempts in last 24h (count + failed count)
    // Note: kyc_submissions uses `submitted_at`, NOT `created_at`.
    const kycRes = await query(
      `SELECT count(*)::int                                       AS attempted_24h,
              count(*) FILTER (WHERE status = 'rejected')::int    AS failed_24h
         FROM kyc_submissions
        WHERE user_id = $1::uuid
          AND submitted_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    const kycRow: KycRow = (kycRes.rows[0] as KycRow) ?? { attempted_24h: 0, failed_24h: 0 };

    // 3. velocity numbers (last 1h, 24h, 7d) — single round-trip,
    //    conditional aggregates per bucket.
    const velRes = await query(
      `SELECT
         count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int       AS tx_total_1h,
         count(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int     AS tx_total_24h,
         count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int       AS tx_total_7d,
         count(*) FILTER (WHERE type = 'bet'
                          AND created_at > NOW() - INTERVAL '24 hours')::int       AS bet_count_24h,
         count(*) FILTER (WHERE type = 'deposit'
                          AND status = 'completed'
                          AND created_at > NOW() - INTERVAL '24 hours')::int      AS deposit_count_24h,
         sum(amount) FILTER (WHERE type = 'deposit'
                            AND status = 'completed'
                            AND created_at > NOW() - INTERVAL '30 days')::float8 AS deposit_amount_total_30d,
         sum(amount) FILTER (WHERE type = 'withdrawal'
                            AND status = 'completed'
                            AND created_at > NOW() - INTERVAL '30 days')::float8 AS withdrawal_amount_total_30d
       FROM transactions WHERE user_id = $1::uuid`,
      [userId],
    );
    const velRow: VelocityRow = (velRes.rows[0] as VelocityRow) ?? {} as VelocityRow;

    // 4. device + IP distinct counts (30d)
    const devRes = await query(
      `SELECT device_count, fingerprint FROM users WHERE id = $1::uuid LIMIT 1`,
      [userId],
    );
    const distinctDevices = NUM((devRes.rows[0] as any)?.device_count);
    const distinctIpsRes = await query(
      `SELECT count(DISTINCT ip_address)::int AS n
         FROM transactions
        WHERE user_id = $1::uuid
          AND ip_address IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 days'`,
      [userId],
    );
    const distinctIps = NUM((distinctIpsRes.rows[0] as any)?.n);

    // 5. open fraud signals grouped by signal_type
    const sigsRes = await query(
      `SELECT signal_type, count(*)::int AS n
         FROM fraud_signals
        WHERE user_id = $1::uuid AND status = 'open'
        GROUP BY signal_type`,
      [userId],
    );
    const signalCounts: { [k: string]: number; open: number } = { open: 0 };
    for (const r of sigsRes.rows as Array<{ signal_type: string; n: number }>) {
      signalCounts[r.signal_type] = NUM(r.n);
      signalCounts.open += NUM(r.n);
    }

    // 6. behavioral service (Phase 2.1). Lazy import so it stays
    //    pure-Node-friendly (no circular-dep risk).
    let behavioral = {
      bet_amount_variance: null as number | null,
      bets_per_minute_avg: null as number | null,
      game_variety_index: null as number | null,
      only_bonus_bets: false,
      bot_like_click_timing: false,
      session_duration_avg_minutes: null as number | null,
    };
    try {
      const { computeBehavioralSignals } = await import('./behavioral-analytics');
      const bs = await computeBehavioralSignals(userId);
      behavioral = {
        bet_amount_variance: bs.betAmountVariance,
        bets_per_minute_avg: bs.betsPerMinuteAvg,
        game_variety_index: bs.gameVarietyIndex,
        only_bonus_bets: bs.onlyBonusBets,
        bot_like_click_timing: bs.botClickTiming,
        session_duration_avg_minutes: bs.sessionDurationAvgMinutes,
      };
    } catch { /* tolerate behavioral service failure */ }

    // 7. IP reputation: latest cache row for the user's registration_ip
    let ipRep = { abuse_score: 0, is_blocklisted: 0 as 0 | 1 };
    try {
      const uip = (devRes.rows[0] as any)?.fingerprint;
      const regIpRes = await query(
        `SELECT registration_ip FROM users WHERE id = $1::uuid`, [userId]);
      const regIp = (regIpRes.rows[0] as any)?.registration_ip;
      if (regIp) {
        const ipRes = await query(
          `SELECT abuse_score FROM ip_reputation_cache
            WHERE ip_address = $1::inet
            ORDER BY checked_at DESC LIMIT 1`, [regIp]);
        ipRep.abuse_score = NUM((ipRes.rows[0] as any)?.abuse_score);
      }
      const blRes = await query(
        `SELECT 1 FROM ip_blocklist
          WHERE ip_address = COALESCE(NULLIF((SELECT registration_ip FROM users WHERE id = $1::uuid), '')::inet, '0.0.0.0'::inet)
            AND list_type = 'deny' AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1`, [userId]);
      ipRep.is_blocklisted = blRes.rows.length > 0 ? 1 : 0;
    } catch { /* ip_reputation_cache may not exist yet */ }

    // 8. P3-2d: deepfake risk signal. NULL until admin enables the
    // detector; the strictness column is the admin's current threshold
    // normalised, so the model can learn per-deploy calibration.
    let deepfake = { score: 0, check_recent: false, strictness: 0.70 };
    try {
      const df = await query(
        `SELECT deepfake_score, deepfake_checked_at FROM users WHERE id = $1::uuid`,
        [userId],
      );
      const row = (df.rows[0] as { deepfake_score: number | null; deepfake_checked_at: Date | null }) ?? null;
      if (row) {
        deepfake.score = row.deepfake_score ?? 0;
        const checkedAt = row.deepfake_checked_at
          ? new Date(row.deepfake_checked_at).getTime() : 0;
        // Within last 7 days = recent enough to trust.
        deepfake.check_recent = checkedAt > Date.now() - 7 * 86400000;
      }
      const strictStr = (await getAdminSetting('kyc_deepfake_score_threshold', '0.70')) ?? '0.70';
      const parsed = parseFloat(strictStr);
      if (Number.isFinite(parsed)) deepfake.strictness = parsed;
    } catch { /* deepfake columns may not exist yet on older migrations */ }

    const velocityRows = {
      tx_total_1h: velRow.tx_total_1h ?? 0,
      tx_total_24h: velRow.tx_total_24h ?? 0,
      tx_total_7d: velRow.tx_total_7d ?? 0,
      bet_count_24h: velRow.bet_count_24h ?? 0,
      deposit_count_24h: velRow.deposit_count_24h ?? 0,
      distinct_devices_30d: distinctDevices,
      distinct_ips_30d: distinctIps,
      deposit_amount_total_30d: velRow.deposit_amount_total_30d ?? 0,
      withdrawal_amount_total_30d: velRow.withdrawal_amount_total_30d ?? 0,
    };

    const vector = buildFeatureVectorFromRows(
      userId, userRow, kycRow, velocityRows, signalCounts, behavioral, ipRep, deepfake,
    );

    return {
      userId,
      vector,
      columns: FEATURE_COLUMNS,
      computedAt: new Date(),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    // Failed extraction: return zeros so the model still runs.
    return {
      userId,
      vector: new Array(FEATURE_COLUMNS.length).fill(0),
      columns: FEATURE_COLUMNS,
      computedAt: new Date(),
      durationMs: Date.now() - t0,
    };
  }
}
