/**
 * P0-5 — Bonus velocity rate limiter (Redis-backed, sliding window).
 *
 * Why: a user who claims a bonus, wagers, withdraws, then immediately
 * claims another bonus is bonus-farming. The legacy `bonusCooldownHours`
 * config only enforces a STATIC gap (default 24h). Real abusers exploit:
 *
 *   - Multiple bonus-types per day (e.g. deposit_match 6× across 2 types)
 *   - "Bonus storming": claim → forfeit → claim → forfeit every 24:01 UTC
 *
 * The sliding-window approach uses Redis sorted sets keyed per user. Each
 * claim is a (score=timestamp, member=unique-id) entry. Old entries are
 * pruned; count is computed across the live window.
 *
 * Falls back to in-process counters if Redis is unreachable so the
 * system stays available (slightly looser limit during Redis outage).
 */

import { v4 as uuidv4 } from 'uuid';
import { redis } from '../config/redis';
import { getAdminSettingNumber as getSetting } from './admin-settings.service';

const KEY_PREFIX = 'velocity:bonus_claims:';
const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// In-process fallback (per-pod, coarse)
const fallbackMem = new Map<string, number[]>();

export interface VelocityDecision {
  allowed: boolean;
  counts: {
    last24h: number;
    last7d: number;
    secondsSinceLast: number;
  };
  limits: {
    maxClaimsPer24h: number;
    maxClaimsPer7d: number;
    minSecondsBetweenClaims: number;
  };
  reason?: string;
}

/**
 * Look up admin-configured limits. Defaults match the v2.0 spec.
 */
async function loadLimits(): Promise<{
  maxClaimsPer24h: number;
  maxClaimsPer7d: number;
  minSecondsBetweenClaims: number;
}> {
  const [max24, max7d, minSec] = await Promise.all([
    getSetting('velocity_max_bonus_claims_per_24h', 3, true),
    getSetting('velocity_max_bonus_claims_per_7d', 5, true),
    getSetting('velocity_min_seconds_between_claims', 300, true),
  ]);
  return {
    maxClaimsPer24h: max24,
    maxClaimsPer7d: max7d,
    minSecondsBetweenClaims: minSec,
  };
}

/**
 * Decide whether the user can claim a bonus right now.
 * Pure read — does NOT record anything. Call `recordClaim` after a
 * successful grant to update the counters.
 *
 * Tolerates Redis failure by returning "allowed if counters can't be read"
 * — we don't want rate-limit bugs to lock legitimate users out during
 * an outage.
 */
export async function checkVelocity(userId: string): Promise<VelocityDecision> {
  const limits = await loadLimits();
  const key = KEY_PREFIX + userId;
  const now = Date.now();
  const cutoff24 = now - DAY * 1000;
  const cutoff7 = now - WEEK * 1000;

  let counts = { last24h: 0, last7d: 0, secondsSinceLast: Infinity };

  try {
    // Atomically prune old entries.
    await redis.zremrangebyscore(key, '-inf', String(cutoff24));
    // Read counts in each window.
    const c24 = await redis.zcount(key, String(cutoff24), '+inf');
    const c7 = await redis.zcount(key, String(cutoff7), '+inf');
    // Find most-recent entry.
    const recent = await redis.zrevrange(key, 0, 0, 'WITHSCORES');
    let last = 0;
    if (recent.length === 2) {
      last = parseInt(recent[1], 10) || 0;
    }
    counts = {
      last24h: c24,
      last7d: c7,
      secondsSinceLast: last > 0 ? Math.floor((now - last) / 1000) : Infinity,
    };
  } catch (e) {
    // Redis down — fall back to per-process counter so the system
    // stays available. Logged once for ops visibility.
    // eslint-disable-next-line no-console
    console.error('[bonus-velocity] Redis check failed, using in-memory fallback:', e);
    const arr = (fallbackMem.get(userId) ?? []).filter((t) => t >= cutoff7);
    fallbackMem.set(userId, arr);
    const last = arr.length ? arr[arr.length - 1] : 0;
    counts = {
      last24h: arr.filter((t) => t >= cutoff24).length,
      last7d: arr.length,
      secondsSinceLast: last > 0 ? Math.floor((now - last) / 1000) : Infinity,
    };
  }

  let allowed = true;
  let reason: string | undefined;

  if (counts.secondsSinceLast < limits.minSecondsBetweenClaims) {
    allowed = false;
    reason = `min_${limits.minSecondsBetweenClaims}s_between_claims`;
  } else if (counts.last24h > limits.maxClaimsPer24h) {
    allowed = false;
    reason = `max_${limits.maxClaimsPer24h}_claims_per_24h`;
  } else if (counts.last7d > limits.maxClaimsPer7d) {
    allowed = false;
    reason = `max_${limits.maxClaimsPer7d}_claims_per_7d`;
  }

  return {
    allowed,
    counts: {
      last24h: counts.last24h,
      last7d: counts.last7d,
      secondsSinceLast: counts.secondsSinceLast,
    },
    limits,
    reason,
  };
}

/**
 * Record a successful claim. Called right after the bonus_claims row
 * is inserted. TTL pruning is automatic since we ZADD then the next
 * ZREMRANGEBYSCORE cleans up.
 */
export async function recordClaim(userId: string): Promise<void> {
  const key = KEY_PREFIX + userId;
  const now = Date.now();
  const member = `${now}-${uuidv4()}`;
  try {
    await redis.zadd(key, now, member);
    await redis.expire(key, WEEK * 1000);  // auto-clean after 7d inactivity
  } catch (e) {
    // Fallback in-memory
    const arr = (fallbackMem.get(userId) ?? []).filter((t) => t >= now - WEEK * 1000);
    arr.push(now);
    fallbackMem.set(userId, arr);
    // eslint-disable-next-line no-console
    console.error('[bonus-velocity] Redis record failed, using in-memory fallback:', e);
  }
}

/**
 * One-shot guard: returns the decision OR throws if not allowed.
 * Convenience for callers who don't want to handle the boolean.
 */
export class VelocityLimitError extends Error {
  readonly code = 'VELOCITY_LIMIT';
  readonly decision: VelocityDecision;
  constructor(decision: VelocityDecision) {
    super(
      `Velocity limit (${decision.reason ?? 'unknown'}). ` +
      `Last 24h: ${decision.counts.last24h}/${decision.limits.maxClaimsPer24h}, ` +
      `Last 7d: ${decision.counts.last7d}/${decision.limits.maxClaimsPer7d}`,
    );
    this.name = 'VelocityLimitError';
    this.decision = decision;
  }
}

export async function enforceVelocity(userId: string): Promise<VelocityDecision> {
  const decision = await checkVelocity(userId);
  if (!decision.allowed) throw new VelocityLimitError(decision);
  return decision;
}
