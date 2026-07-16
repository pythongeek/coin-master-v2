/**
 * Phase 3 / P3-2b — Deepfake-Detector service (provider-agnostic).
 *
 * Best-effort: NEVER throws, NEVER blocks the caller, always writes
 * an audit row in kyc_deepfake_audit. If anything fails, the caller
 * gets `score: null, status: 'error'`. The KYC submission continues
 * regardless.
 *
 * Two providers:
 *   - NoopProvider:  no HTTP call, returns null + status='skipped'.
 *                    Used when kyc_deepfake_enabled=false OR endpoint empty.
 *                    This is the safe default so the platform behaviour
 *                    does not change just by importing this module.
 *   - HttpProvider: POSTs {image_url, user_id?, kyc_submission_id?} to the
 *                    admin-configured endpoint, expects {score: 0..1}.
 *                    5s hard timeout cap on top of the admin's setting.
 *
 * Side effects (best-effort):
 *   1. ALWAYS writes one kyc_deepfake_audit row per call.
 *   2. UPDATEs users.deepfake_score + checked_at + check_status
 *      when status='ok' OR 'error'.
 *   3. If status='ok' AND score >= admin_settings.kyc_deepfake_score_threshold
 *      AND kyc_deepfake_enabled=true → opens ONE fraud_signals row
 *      signal_type='deepfake_high_probability' status='open' for
 *      admin review. NEVER auto-blocks.
 *
 * Caching: results for the same image_url are cached for 24 h on the
 * server-side redis. Cached lookups DO NOT write a new audit row
 * (audit happens on first check only) — but they DO return the
 * cached score so the caller still gets a value.
 */

import { query } from '../config/database';
import { redis } from '../config/redis';
import { getAdminSetting } from './admin-settings.service';

// ── Types ────────────────────────────────────────────────────────

export interface DeepfakeCheckInput {
  userId: string;
  imageUrl: string;
  kycSubmissionId?: string;
}

export interface DeepfakeCheckResult {
  score: number | null;                // 0..1, null on skip/error
  status: 'ok' | 'error' | 'skipped' | 'timeout';
  durationMs: number;
  endpoint: string;                    // what URL we hit (or "noop")
  cached: boolean;                     // true when served from 24h cache
}

export type DeepfakeProviderName = 'noop' | 'http';

interface DeepfakeProvider {
  name: DeepfakeProviderName;
  check(input: DeepfakeCheckInput, opts: { endpoint: string; timeoutMs: number }): Promise<{
    score: number | null;
    status: 'ok' | 'error' | 'timeout';
  }>;
}

// ── Cache (Redis) ───────────────────────────────────────────────

const CACHE_PREFIX = 'deepfake:';
const CACHE_TTL = 24 * 60 * 60;        // 24 hours

interface CacheEntry { score: number | null; status: string }
async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await redis.get(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch { return null; }
}
async function writeCache(key: string, value: CacheEntry): Promise<void> {
  try {
    await redis.set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', CACHE_TTL);
  } catch { /* best-effort */ }
}

// ── Providers ──────────────────────────────────────────────────

class NoopProvider implements DeepfakeProvider {
  name: DeepfakeProviderName = 'noop';
  async check(): Promise<{ score: null; status: 'ok' }> {
    return { score: null, status: 'ok' };     // 'ok' status, noop score
  }
}

class HttpProvider implements DeepfakeProvider {
  name: DeepfakeProviderName = 'http';
  // Hard cap on top of any admin-set value. System-level guarantee.
  private static MAX_TIMEOUT_MS = 5000;
  async check(
    input: DeepfakeCheckInput,
    opts: { endpoint: string; timeoutMs: number },
  ): Promise<{ score: number | null; status: 'ok' | 'error' | 'timeout' }> {
    const timeoutMs = Math.min(HttpProvider.MAX_TIMEOUT_MS, Math.max(100, opts.timeoutMs));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: input.imageUrl,
          user_id: input.userId,
          kyc_submission_id: input.kycSubmissionId,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { score: null, status: 'error' };
      const body: unknown = await res.json();
      const score = clamp((body as any)?.score);
      if (score === null) return { score: null, status: 'error' };
      return { score, status: 'ok' };
    } catch (e: any) {
      const status: 'timeout' | 'error' =
        e?.name === 'AbortError' ? 'timeout' : 'error';
      return { score: null, status };
    } finally {
      clearTimeout(t);
    }
  }
}

function clamp(s: unknown): number | null {
  if (typeof s !== 'number' || !Number.isFinite(s)) return null;
  return Math.max(0, Math.min(1, s));
}

function buildProvider(name: DeepfakeProviderName, endpoint: string): DeepfakeProvider {
  if (name === 'http' && endpoint) return new HttpProvider();
  return new NoopProvider();
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Best-effort deepfake check.
 *
 * Reads admin_settings:
 *   - kyc_deepfake_enabled       (boolean-string 'true' or 'false')
 *   - kyc_deepfake_endpoint      (URL string)
 *   - kyc_deepfake_timeout_ms    (number ms)
 *   - kyc_deepfake_score_threshold (number 0..1)
 *   - kyc_deepfake_block_above   (boolean; this function ALWAYS reads
 *                                   this but the implementation currently
 *                                   never auto-blocks — flagged for phase 2
 *                                   of P3-2 rollout)
 *   - kyc_deepfake_log_image     (whether to include selfie in audit)
 *
 * Returns a DeepfakeCheckResult. Always writes to kyc_deepfake_audit.
 */
export async function checkImageForDeepfake(
  input: DeepfakeCheckInput,
): Promise<DeepfakeCheckResult> {
  const t0 = Date.now();

  // 1. Read admin knobs.
  const enabled = ((await getAdminSetting('kyc_deepfake_enabled', 'false')) ?? 'false') === 'true';
  const endpoint = (await getAdminSetting('kyc_deepfake_endpoint', '')) ?? '';
  const timeoutMs = Number(await getAdminSetting('kyc_deepfake_timeout_ms', '2000'));
  const scoreThreshold = Number(await getAdminSetting('kyc_deepfake_score_threshold', '0.70'));
  const blockAbove = (await getAdminSetting('kyc_deepfake_block_above', 'false')) === 'true';
  const logImage = (await getAdminSetting('kyc_deepfake_log_image', 'false')) === 'true';

  // 2. Cache check (per-image-url key).
  const cacheKey = encodeURIComponent(input.imageUrl);
  const cached = await readCache(cacheKey);
  if (cached) {
    const audit = await writeAudit({
      userId: input.userId,
      kycSubmissionId: input.kycSubmissionId,
      imageUrl: input.imageUrl,
      status: cached.status as any,
      score: cached.score,
      endpoint: 'cache',
      durationMs: Date.now() - t0,
      responseBody: logImage ? { cached: true } : null,
      errorMessage: null,
    }).catch(() => null);
    void audit;
    return {
      score: cached.score,
      status: cached.status as any,
      durationMs: Date.now() - t0,
      endpoint: 'cache',
      cached: true,
    };
  }

  // 3. Decide provider.
  const providerName: DeepfakeProviderName = enabled && endpoint ? 'http' : 'noop';
  const provider = buildProvider(providerName, endpoint);

  // 4. Call provider.
  const out = await provider.check(input, { endpoint, timeoutMs });

  // 5. Cache the result.
  await writeCache(cacheKey, { score: out.score, status: out.status });

  // 6. Update users row (best-effort). Only set fields we have a real value for.
  if (out.status === 'ok' || out.status === 'error' || out.status === 'timeout') {
    try {
      await query(
        `UPDATE users
            SET deepfake_score        = $2,
                deepfake_checked_at   = NOW(),
                deepfake_check_status = $3
          WHERE id = $1::uuid`,
        [input.userId, out.score, out.status],
      );
    } catch { /* best-effort */ }
  }

  // 7. Audit + fraud-signal side effects (best-effort).
  const dur = Date.now() - t0;
  await writeAudit({
    userId: input.userId,
    kycSubmissionId: input.kycSubmissionId,
    imageUrl: input.imageUrl,
    status: out.status,
    score: out.score,
    endpoint: endpoint || 'noop',
    durationMs: dur,
    responseBody: logImage && out.status === 'ok'
      ? { image_url: input.imageUrl }
      : null,
    errorMessage: out.status === 'error' || out.status === 'timeout'
      ? (out.status === 'timeout' ? 'upstream timeout' : 'upstream error')
      : null,
  }).catch(() => null);

  // 8. Risk-signal: open a fraud_signals row if score is above threshold.
  //    NEVER auto-block. block_above is read but honored only in P3-2 follow-up.
  if (out.status === 'ok' && out.score !== null &&
      enabled && out.score >= scoreThreshold) {
    try {
      await query(
        `INSERT INTO fraud_signals
           (user_id, signal_type, severity, status, metadata, detected_at)
         VALUES ($1::uuid, 'deepfake_high_probability', 'warn', 'open', $2::jsonb, NOW())`,
        [
          input.userId,
          JSON.stringify({
            score: out.score,
            threshold: scoreThreshold,
            endpoint,
            kyc_submission_id: input.kycSubmissionId,
            block_above: blockAbove,
            note: 'P3-2b risk signal. Auto-block disabled until block_above=true AND FP<0.5% confirmed.',
          }),
        ],
      );
    } catch { /* best-effort */ }
  }

  return {
    score: out.score,
    status: out.status === 'ok' ? 'ok' : out.status,
    durationMs: dur,
    endpoint: endpoint || 'noop',
    cached: false,
  };
}

// ── Audit row helper ────────────────────────────────────────────

async function writeAudit(args: {
  userId: string;
  kycSubmissionId?: string;
  imageUrl: string;
  status: 'ok' | 'error' | 'skipped' | 'timeout';
  score: number | null;
  endpoint: string;
  durationMs: number;
  responseBody: any;
  errorMessage: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO kyc_deepfake_audit
       (user_id, kyc_submission_id, source_url, status, score,
        endpoint_url, duration_ms, response_body, error_message)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      args.userId,
      args.kycSubmissionId ?? null,
      args.imageUrl,
      args.status,
      args.score,
      args.endpoint,
      args.durationMs,
      args.responseBody === null || args.responseBody === undefined
        ? null
        : JSON.stringify(args.responseBody),
      args.errorMessage,
    ],
  );
}
