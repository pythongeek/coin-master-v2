/**
 * ═══════════════════════════════════════════════════════════════
 *  DEVICE-FINGERPRINT FRAUD CAP — per-device 24h signup cap
 *  ─────────────────────────────────────────────────────────────
 *
 *  P1-12 — Caps how many new accounts can be created from a single
 *  device fingerprint in a 24h window. This complements the
 *  per-IP cap (`fraud_max_accounts_per_ip_24h`) because a sophisticated
 *  attacker rotating IP addresses (proxy, mobile data, residential
 *  VPN pool) can still be fingerprinted at the device level.
 *
 *  Why per-fingerprint AND per-IP?
 *  - IP-only: a botnet with thousands of IPs can drain the bonus
 *    pool trivially.
 *  - Fingerprint-only: legitimate users who happen to share a
 *    device (family iPad) shouldn't be capped too tightly.
 *  - Both: each is a hard ceiling. Reaching either cap → 429.
 *
 *  Source of truth
 *  ───────────────
 *  We read from BOTH the legacy `users.fingerprint` column AND the
 *  newer `device_fingerprints` table. The legacy column is set on
 *  every insert (Phase 1.1 refactor preserved the write path); the
 *  device_fingerprints table is updated by `recordDeviceUse()` AFTER
 *  user creation. A pre-check against the legacy `users.fingerprint`
 *  column gives us a tight bound because the write is atomic with
 *  the user insert (inside the same `withTransaction`).
 *
 *  Threshold
 *  ─────────
 *  Default: 3 accounts per fingerprint hash per 24h. Configurable
 *  via `admin_settings.fraud_max_accounts_per_fingerprint_24h`.
 *  Admin can relax to 5 (legit shared-device case) or tighten to
 *  1 (strict friction mode for high-fraud periods).
 *
 *  Whitelist
 *  ─────────
 *  Operator IPs in `ip_whitelist` (e.g. 46.62.247.167) bypass the
 *  IP cap but NOT the fingerprint cap. The fingerprint cap is
 *  device-scoped, not network-scoped.
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';
import { getAdminSettingNumber } from './admin-settings.service';
import { hashFingerprint } from './device-fingerprint';

export interface FingerprintCapResult {
  allowed: boolean;
  fingerprintHash: string | null;
  countInLast24h: number;
  cap: number;
  reason: 'no-fingerprint' | 'under-cap' | 'at-cap' | 'error';
}

/**
 * Count how many users have been created with this exact RAW fingerprint
 * value in the last `windowHours` hours.
 *
 * IMPORTANT — we query the **raw** fingerprint string, NOT the SHA-256
 * hash. This is because the `users.fingerprint` column is populated
 * with the raw client-supplied value at insert time (P1-12-prior
 * legacy code path). The newer `device_fingerprints.fingerprint_hash`
 * column stores the hash, but it is updated AFTER user creation
 * (post-insert) by `recordDeviceUse`, so it cannot serve as a tight
 * pre-registration gate.
 *
 * The legacy `users.fingerprint` column write IS atomic with the
 * user insert (inside `withTransaction`), so reading the count
 * against the raw value is a safe pre-check: by the time we have
 * a high count, the writes have committed.
 */
export async function countFingerprintsInWindow(
  rawFingerprint: string,
  windowHours = 24,
): Promise<number> {
  const r = await query(
    `SELECT count(*)::int AS cnt
       FROM users
      WHERE fingerprint = $1
        AND created_at > NOW() - ($2 || ' hours')::interval`,
    [rawFingerprint, String(windowHours)],
  );
  return (r.rows[0] as { cnt: number }).cnt;
}

/**
 * Determine whether a registration with this fingerprint is allowed.
 *
 * @param rawFingerprint  the raw fingerprint string from the client
 *                        (can be `null` or empty — in that case the
 *                        caller decides separately whether to allow
 *                        a fingerprint-less registration).
 * @param ipAddress       the registering IP (for audit logging only)
 *
 * @returns FingerprintCapResult with the 24h count, the active cap,
 *          and an `allowed` boolean. Callers should reject with HTTP
 *          429 when `allowed === false`.
 */
export async function checkFingerprintRegistrationCap(
  rawFingerprint: string | null | undefined,
  ipAddress: string,
): Promise<FingerprintCapResult> {
  // Normalize: trim + lowercase to match what the user input went
  // through (the Zod schema does not currently normalize, but the
  // raw column is inserted verbatim — we mirror the same semantics).
  // Empty / null input → no cap applied.
  if (!rawFingerprint || typeof rawFingerprint !== 'string' || rawFingerprint.trim() === '') {
    return {
      allowed: true,
      fingerprintHash: null,
      countInLast24h: 0,
      cap: 0,
      reason: 'no-fingerprint',
    };
  }
  const normalized = rawFingerprint.trim();

  // Validate the same way as `hashFingerprint` does (8+ chars).
  // For consistency with the `device_fingerprint` service, we hash
  // for the result metadata (so callers can correlate), but we
  // count by the raw value (because that is what the column stores).
  const fingerprintHash = hashFingerprint(normalized);
  if (!fingerprintHash) {
    return {
      allowed: true,
      fingerprintHash: null,
      countInLast24h: 0,
      cap: 0,
      reason: 'no-fingerprint',
    };
  }

  // Cap is admin-tunable. Default 3 (matches task spec).
  let cap = 3;
  try {
    cap = await getAdminSettingNumber('fraud_max_accounts_per_fingerprint_24h', 3, true);
  } catch (e) {
    // Use the default 3 on any read error. We do not want a broken
    // admin_settings read to lock out the registration endpoint.
    // eslint-disable-next-line no-console
    console.warn('[fingerprint-cap] admin_settings read failed, using default cap=3', e);
  }
  if (cap < 1) cap = 1; // never disable the cap entirely

  let count = 0;
  try {
    count = await countFingerprintsInWindow(normalized, 24);
  } catch (e) {
    // Fail-closed: if we cannot determine the count, refuse the
    // registration rather than letting a bot slip through.
    return {
      allowed: false,
      fingerprintHash,
      countInLast24h: -1,
      cap,
      reason: 'error',
    };
  }

  if (count >= cap) {
    return {
      allowed: false,
      fingerprintHash,
      countInLast24h: count,
      cap,
      reason: 'at-cap',
    };
  }

  return {
    allowed: true,
    fingerprintHash,
    countInLast24h: count,
    cap,
    reason: 'under-cap',
  };
}
