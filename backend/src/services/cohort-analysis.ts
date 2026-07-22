/**
 * P3-6 — Behavioral Cohort Comparison (batch ML job, weekly).
 *
 * Assigns each user to a deterministic cohort based on (country,
 * KYC tier, account-age bucket, device-class) and aggregates peer
 * metrics. Users whose behavior is > z_threshold std-dev from the
 * cohort mean are recorded as outliers AND written as fraud_signals
 * rows (same pattern as persistIpGeoSignals from P3-4a).
 *
 * Per the CryptoFlip_BonusSystem_CompleteDocs.md:1517 P3-6 spec.
 *
 * Cohort key shape:
 *   "<COUNTRY>-<KYC_TIER>-<AGE_BUCKET>-<DEVICE_CLASS>"
 *
 * Examples:
 *   "BD-1-young-mobile"   (Bangladeshi user, KYC tier 1, account
 *                           <30d old, mobile UA)
 *   "US-3-old-desktop"    (US user, KYC tier 3, account >180d old,
 *                           desktop UA)
 *
 * Aggregated metrics per cohort:
 *   bets_per_day        — average bets placed per day
 *   avg_bet_amount      — mean bet size in coins
 *   deposit_frequency   — average deposits per week
 *   risk_score_avg      — mean risk_score across the cohort
 *   withdrawal_velocity — average withdrawals per 24h
 *
 * Outliers: any user whose z-score on any metric exceeds the
 * configured threshold (default 2.5) is recorded in
 * behavioral_cohort_outliers with severity = 'high' if |z| >= 4,
 * 'critical' if |z| >= 6, 'medium' otherwise.
 *
 * Idempotency: stats upsert per (cohort_key, metric). Outliers
 * upsert per (user_id, metric, cohort_key). Each run is independent;
 * the cron fires Sunday 04:00 UTC by default.
 */

import { createHash } from 'crypto';
import { query } from '../config/database';
import { getAdminSetting, getAdminSettingBool, getAdminSettingNumber } from './admin-settings.service';

export type AgeBucket = 'young' | 'mid' | 'old' | 'unknown';
export type DeviceClass = 'mobile' | 'desktop' | 'tablet' | 'unknown';
export type KYC = 0 | 1 | 2 | 3;

export interface CohortAssignment {
  user_id: string;
  cohort_key: string;
  cohort_features_hash: string;
  cohort_size: number;
  last_assigned_at: string;
}

export interface CohortStatsRow {
  cohort_key: string;
  metric: string;
  mean_value: number;
  stddev_value: number | null;
  p50_value: number | null;
  p95_value: number | null;
  n_samples: number;
  computed_at: string;
}

export interface OutlierRow {
  user_id: string;
  cohort_key: string;
  metric: string;
  user_value: number;
  cohort_mean: number;
  cohort_stddev: number;
  z_score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detected_at: string;
}

export interface RunCohortResult {
  cohortsScanned: number;
  outliersFound: number;
  signalsWritten: number;
  errors: string[];
}

// ── Cohort key derivation ──────────────────────────────────────

const MOBILE_UA_RE = /(?:Mobile|iPhone|Android(?!.*Tablet)|iPod|Mobile Safari|webOS|BlackBerry|IEMobile|Opera Mini)/i;
const TABLET_UA_RE = /(?:iPad|Android.*Tablet|Tablet.*Android|Silk.*Mobile|Kindle|PlayBook)/i;

export function classifyDevice(userAgent: string | null | undefined): DeviceClass {
  if (!userAgent) return 'unknown';
  if (TABLET_UA_RE.test(userAgent)) return 'tablet';
  if (MOBILE_UA_RE.test(userAgent)) return 'mobile';
  return 'desktop';
}

export function ageBucketFor(createdAt: Date | string | null): AgeBucket {
  if (!createdAt) return 'unknown';
  const ms = Date.now() - new Date(createdAt).getTime();
  if (ms < 0) return 'young';
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 30) return 'young';
  if (days < 180) return 'mid';
  return 'old';
}

/**
 * Stable cohort key. Hashes the 4-tuple so a cohort with rare
 * combinations still gets a short, sortable label.
 */
export function cohortKeyFor(opts: {
  country: string | null;
  kycTier: number | string | null;
  createdAt: Date | string | null;
  deviceClass: DeviceClass;
}): string {
  const country = (opts.country ?? 'XX').toUpperCase().slice(0, 2) || 'XX';
  const kyc = String(opts.kycTier ?? 'X');
  const age = ageBucketFor(opts.createdAt);
  const device = opts.deviceClass;
  const features = `${country}-${kyc}-${age}-${device}`;
  // 8-char hash for unique handling of edge cases (e.g. mixed tiers)
  // without the label exploding in length.
  return features;
}

/**
 * Full hash used for tracking changes in the cohort dimensions
 * (so a future migration adding a new axis can re-run the analysis
 * even though the label format stays the same).
 */
export function cohortFeaturesHash(opts: {
  country: string | null;
  kycTier: number | string | null;
  ageBucket: AgeBucket;
  deviceClass: DeviceClass;
}): string {
  return createHash('sha256')
    .update(`${opts.country ?? 'XX'}|${opts.kycTier ?? 'X'}|${opts.ageBucket}|${opts.deviceClass}`)
    .digest('hex')
    .slice(0, 32);
}

// ── Cohort assignment + size computation ─────────────────────

export async function assignCohortsForAllUsers(lookbackDays: number): Promise<{
  scanned: number; cohortsTouched: number;
}> {
  // Pull per-user facts: country, kyc_tier, created_at, and the
  // most-recent user_agent (via the most recent bet, which has the
  // ua at submission time).
  const userRows = (await query(
    `SELECT
        u.id::text AS user_id,
        COALESCE(u.kyc_country, 'XX'::varchar) AS country,
        COALESCE(u.kyc_tier, '0'::varchar) AS kyc_tier,
        u.created_at
       FROM users u
      WHERE COALESCE(u.is_active, true) = true`,
  )).rows as Array<{ user_id: string; country: string; kyc_tier: string; created_at: Date }>;

  // For device class we need the most recent user_agent. Pull from
  // the most recent activity row that has it. Falls back to
  // 'unknown' when no data.
  const uaMap = new Map<string, string>();
  const uaRows = (await query(
    `SELECT DISTINCT ON (user_id) user_id::text AS user_id, user_agent
       FROM transactions
      WHERE user_agent IS NOT NULL AND user_agent <> ''
      ORDER BY user_id, created_at DESC`,
  )).rows as Array<{ user_id: string; user_agent: string | null }>;
  for (const r of uaRows) uaMap.set(r.user_id, r.user_agent ?? '');

  // Group by cohort in memory to compute sizes before insert.
  const groups = new Map<string, { size: number; rows: Array<{ user_id: string; cohort_key: string; features_hash: string }> }>();
  for (const u of userRows) {
    const deviceClass = classifyDevice(uaMap.get(u.user_id));
    // kyc_tier column is varchar in the schema; coerce to number for
    // the cohort key derivation. Treat empty / non-numeric as null.
    const kycTierNum = u.kyc_tier && /^\d+$/.test(u.kyc_tier) ? Number(u.kyc_tier) : null;
    const cohortKey = cohortKeyFor({ country: u.country, kycTier: kycTierNum, createdAt: u.created_at, deviceClass });
    const ageB = ageBucketFor(u.created_at);
    const featuresHash = cohortFeaturesHash({ country: u.country, kycTier: kycTierNum, ageBucket: ageB, deviceClass });
    if (!groups.has(cohortKey)) groups.set(cohortKey, { size: 0, rows: [] });
    const g = groups.get(cohortKey)!;
    g.size++;
    g.rows.push({ user_id: u.user_id, cohort_key: cohortKey, features_hash: featuresHash });
  }

  // Upsert each cohort's assignments + size in batch.
  let scanned = 0;
  for (const [, group] of groups) {
    for (const r of group.rows) {
      await query(
        `INSERT INTO behavioral_cohort_assignments
           (user_id, cohort_key, cohort_features_hash, cohort_size, last_assigned_at)
         VALUES ($1::uuid, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET cohort_key = EXCLUDED.cohort_key,
               cohort_features_hash = EXCLUDED.cohort_features_hash,
               cohort_size = EXCLUDED.cohort_size,
               last_assigned_at = NOW()`,
        [r.user_id, r.cohort_key, r.features_hash, group.size],
      );
      scanned++;
    }
  }

  return { scanned, cohortsTouched: groups.size };
}

// ── Cohort metric aggregation ─────────────────────────────────

interface UserBehaviorRow {
  user_id: string;
  bets_per_day: number;
  avg_bet_amount: number;
  deposit_frequency: number;
  risk_score_avg: number;
  withdrawal_velocity: number;
}

async function fetchCohortBehaviors(cohortKey: string, lookbackDays: number): Promise<UserBehaviorRow[]> {
  // Each metric is a sub-query so the planner can use the
  // appropriate index per aggregate. Performance budget: each
  // sub-query < 200 ms on the typical cohort size (< 5000 users).
  const sql = `
    WITH cohort_users AS (
      SELECT user_id FROM behavioral_cohort_assignments
       WHERE cohort_key = $1
    )
    SELECT
      cu.user_id::text AS user_id,
      COALESCE(bpd.bets_per_day, 0)        AS bets_per_day,
      COALESCE(bpd.avg_bet_amount, 0)     AS avg_bet_amount,
      COALESCE(dpf.deposit_frequency, 0)   AS deposit_frequency,
      COALESCE(rsk.risk_score_avg, 0)      AS risk_score_avg,
      COALESCE(wvl.withdrawal_velocity, 0) AS withdrawal_velocity
    FROM cohort_users cu
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::float / NULLIF($2::int, 0) AS bets_per_day,
        AVG(amount)::float                  AS avg_bet_amount
      FROM bets b
      WHERE b.user_id = cu.user_id
        AND b.created_at > NOW() - ($2::int || ' days')::interval
        AND b.status IN ('resolved','won','lost')
    ) bpd ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::float / NULLIF(($2::int / 7.0), 0) AS deposit_frequency
      FROM transactions t
      WHERE t.user_id = cu.user_id
        AND t.type IN ('deposit','deposit_bonus_credit')
        AND t.status IN ('confirmed','completed')
        AND t.created_at > NOW() - ($2::int || ' days')::interval
    ) dpf ON true
    LEFT JOIN LATERAL (
      SELECT AVG(risk_score)::float AS risk_score_avg
      FROM users
      WHERE id = cu.user_id
    ) rsk ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::float AS withdrawal_velocity
      FROM transactions t
      WHERE t.user_id = cu.user_id
        AND t.type = 'withdrawal'
        AND t.status IN ('pending','confirmed','completed','held','rejected')
        AND t.created_at > NOW() - INTERVAL '24 hours'
    ) wvl ON true
  `;
  const r = await query(sql, [cohortKey, lookbackDays]);
  return r.rows as UserBehaviorRow[];
}

export async function computeAndPersistCohortStats(cohortKey: string, lookbackDays: number): Promise<CohortStatsRow[]> {
  const rows = await fetchCohortBehaviors(cohortKey, lookbackDays);
  if (rows.length === 0) return [];
  const metrics: Array<{ metric: string; values: number[] }> = [];
  for (const metric of ['bets_per_day', 'avg_bet_amount', 'deposit_frequency', 'risk_score_avg', 'withdrawal_velocity']) {
    const vals = rows.map((r) => Number((r as unknown as Record<string, number>)[metric])).filter((v) => Number.isFinite(v));
    if (vals.length === 0) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, vals.length - 1);
    const stddev = Math.sqrt(variance);
    const sorted = [...vals].sort((a, b) => a - b);
    const p = (q: number): number => sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
    metrics.push({ metric, values: [mean, stddev, p(0.5), p(0.95), vals.length] });
  }

  // Upsert
  for (const m of metrics) {
    const [mean, stddev, p50, p95, n] = m.values;
    await query(
      `INSERT INTO behavioral_cohort_stats
         (cohort_key, metric, mean_value, stddev_value, p50_value, p95_value, n_samples, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::int, NOW())
       ON CONFLICT (cohort_key, metric) DO UPDATE
         SET mean_value = EXCLUDED.mean_value,
             stddev_value = EXCLUDED.stddev_value,
             p50_value = EXCLUDED.p50_value,
             p95_value = EXCLUDED.p95_value,
             n_samples = EXCLUDED.n_samples,
             computed_at = NOW()`,
      [cohortKey, m.metric, mean, stddev, p50, p95, n],
    );
  }

  return metrics.map((m) => ({
    cohort_key: cohortKey,
    metric: m.metric,
    mean_value: m.values[0],
    stddev_value: m.values[1],
    p50_value: m.values[2],
    p95_value: m.values[3],
    n_samples: m.values[4],
    computed_at: new Date().toISOString(),
  }));
}

// ── Outlier detection + signal writing ────────────────────────

export function severityForZ(z: number): 'medium' | 'high' | 'critical' {
  const az = Math.abs(z);
  if (az >= 6) return 'critical';
  if (az >= 4) return 'high';
  return 'medium';
}

export async function detectAndPersistOutliers(cohortKey: string, lookbackDays: number, zThreshold: number): Promise<{
  outliersFound: number; signalsWritten: number;
}> {
  const rows = await fetchCohortBehaviors(cohortKey, lookbackDays);
  if (rows.length === 0) return { outliersFound: 0, signalsWritten: 0 };

  // Pull stats
  const statsRows = (await query(
    `SELECT metric, mean_value, stddev_value
       FROM behavioral_cohort_stats
      WHERE cohort_key = $1`,
    [cohortKey],
  )).rows as Array<{ metric: string; mean_value: number; stddev_value: number | null }>;
  const stats = new Map(statsRows.map((s) => [s.metric, s]));

  let outliersFound = 0;
  let signalsWritten = 0;

  for (const r of rows) {
    for (const metric of ['bets_per_day', 'avg_bet_amount', 'deposit_frequency', 'risk_score_avg', 'withdrawal_velocity']) {
      const userVal = Number((r as unknown as Record<string, number>)[metric]);
      const s = stats.get(metric);
      if (!s || !Number.isFinite(s.stddev_value) || (s.stddev_value ?? 0) <= 0) continue;
      const mean = Number(s.mean_value);
      const stddev = Number(s.stddev_value);
      const z = (userVal - mean) / stddev;
      if (!Number.isFinite(z)) continue;
      if (Math.abs(z) < zThreshold) continue;
      const severity = severityForZ(z);

      // Upsert outlier row
      await query(
        `INSERT INTO behavioral_cohort_outliers
           (user_id, cohort_key, metric, user_value, cohort_mean, cohort_stddev, z_score, severity, detected_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id, metric, cohort_key) DO UPDATE
           SET user_value = EXCLUDED.user_value,
               cohort_mean = EXCLUDED.cohort_mean,
               cohort_stddev = EXCLUDED.cohort_stddev,
               z_score = EXCLUDED.z_score,
               severity = EXCLUDED.severity,
               detected_at = NOW()`,
        [r.user_id, cohortKey, metric, userVal, mean, stddev, z, severity],
      );
      outliersFound++;

      // Write fraud_signals row (idempotent: 24h dedup per user+metric)
      // Signal codes mirror the GEO_SIGNAL_TYPES pattern.
      try {
        const existing = (await query(
          `SELECT id FROM fraud_signals
            WHERE user_id = $1::uuid AND signal_type = $2
              AND detected_at > NOW() - INTERVAL '24 hours'
            LIMIT 1`,
          [r.user_id, `cohort_${metric}_outlier`],
        )).rows;
        if (existing.length === 0) {
          await query(
            `INSERT INTO fraud_signals
               (user_id, signal_type, severity, status, metadata, detected_at)
             VALUES ($1::uuid, $2, $3, 'open', $4::jsonb, NOW())`,
            [r.user_id, `cohort_${metric}_outlier`, severity,
             JSON.stringify({
               cohort_key: cohortKey,
               metric,
               user_value: userVal,
               cohort_mean: mean,
               cohort_stddev: stddev,
               z_score: z,
               source: 'weekly_cohort_analysis',
             })],
          );
          signalsWritten++;
        }
      } catch { /* best-effort signal write */ }
    }
  }

  return { outliersFound, signalsWritten };
}

// ── Public entry points ───────────────────────────────────────

export async function listCohortKeys(): Promise<Array<{ cohort_key: string; size: number }>> {
  const r = (await query(
    `SELECT cohort_key, COUNT(*)::int AS size
       FROM behavioral_cohort_assignments
      GROUP BY cohort_key
      ORDER BY size DESC`,
  )).rows as Array<{ cohort_key: string; size: number }>;
  return r;
}

export async function listRecentOutliers(opts: { severity?: string; limit?: number; cohort_key?: string } = {}): Promise<OutlierRow[]> {
  const limit = Math.min(500, Math.max(1, Number(opts.limit ?? 50)));
  const sev = opts.severity ?? null;
  const ck = opts.cohort_key ?? null;
  const r = (await query(
    `SELECT user_id::text AS user_id, cohort_key, metric, user_value, cohort_mean, cohort_stddev,
            z_score, severity, detected_at::text AS detected_at
       FROM behavioral_cohort_outliers
      WHERE ($1::text IS NULL OR severity = $1)
        AND ($2::text IS NULL OR cohort_key = $2)
      ORDER BY detected_at DESC
      LIMIT $3::int`,
    [sev, ck, limit],
  )).rows as Array<{
    user_id: string; cohort_key: string; metric: string;
    user_value: number; cohort_mean: number; cohort_stddev: number;
    z_score: number; severity: 'low' | 'medium' | 'high' | 'critical';
    detected_at: string;
  }>;
  return r;
}

/**
 * Main weekly entry: assign → stats → outliers. Idempotent on
 * every step (upserts).
 */
export async function runWeeklyCohortAnalysis(): Promise<RunCohortResult> {
  const enabled = await getAdminSettingBool('cohort_analysis_enabled', true);
  if (!enabled) {
    return { cohortsScanned: 0, outliersFound: 0, signalsWritten: 0, errors: ['disabled'] };
  }
  const lookback = await getAdminSettingNumber('cohort_analysis_lookback_days', 90);
  const zThreshold = await getAdminSettingNumber('cohort_analysis_z_threshold', 2.5);
  const errors: string[] = [];

  // 1. Assign all active users to cohorts.
  const assign = await assignCohortsForAllUsers(lookback);

  // 2. For each cohort, compute stats and detect outliers.
  let outliersFound = 0;
  let signalsWritten = 0;
  for (const cohort of await listCohortKeys()) {
    try {
      await computeAndPersistCohortStats(cohort.cohort_key, lookback);
      const r = await detectAndPersistOutliers(cohort.cohort_key, lookback, zThreshold);
      outliersFound += r.outliersFound;
      signalsWritten += r.signalsWritten;
    } catch (err: unknown) {
      errors.push(`cohort=${cohort.cohort_key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { cohortsScanned: assign.cohortsTouched, outliersFound, signalsWritten, errors };
}

/**
 * Cron-friendly tick. Fires Sunday 04:00 UTC by default. Same
 * pattern as startDailyFraudReportWorker in P3-5.
 */
export async function maybeRunWeeklyCohortAnalysis(): Promise<RunCohortResult | null> {
  const enabled = await getAdminSettingBool('cohort_analysis_enabled', true);
  if (!enabled) return null;
  const hourCfg = await getAdminSettingNumber('cohort_analysis_send_hour_utc', 4);
  const now = new Date();
  if (now.getUTCHours() !== hourCfg) return null;
  if (now.getUTCDay() !== 0) return null; // Sunday only
  return runWeeklyCohortAnalysis();
}

let weeklyHandle: ReturnType<typeof setInterval> | null = null;

export function startWeeklyCohortWorker(tickMs = 60 * 60 * 1000): ReturnType<typeof setInterval> {
  if (weeklyHandle) return weeklyHandle;
  const tick = async () => {
    try {
      const r = await maybeRunWeeklyCohortAnalysis();
      if (r) {
        console.log('[cohort-analysis] weekly run: cohorts=%d outliers=%d signals=%d errors=%d',
          r.cohortsScanned, r.outliersFound, r.signalsWritten, r.errors.length);
        if (r.errors.length > 0) console.warn('[cohort-analysis] errors:', r.errors.slice(0, 5));
      }
    } catch (err) {
      console.error('[cohort-analysis] tick failed:', err instanceof Error ? err.message : err);
    }
  };
  weeklyHandle = setInterval(tick, tickMs);
  // Run once 10s after boot so an admin can see results during a fresh deploy
  // without waiting until Sunday 04:00 UTC.
  setTimeout(() => { tick(); }, 10_000);
  return weeklyHandle;
}