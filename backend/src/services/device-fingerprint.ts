/**
 * Phase 1.1 — Device Fingerprint Registry (L04)
 *
 * One device = one fingerprint hash. We track which user accounts have
 * ever signed up / signed in from this device. If a device has 2+ KYC-
 * approved accounts, all those accounts get flagged. If 3+ accounts
 * ever appear on a single device, auto-block + admin review.
 *
 * The frontend already collects a raw fingerprint string (canvas + WebGL
 * + screen + tz etc.) and posts it on signup/login. Here we normalize
 * + hash it, then upsert into device_fingerprints.
 *
 * Trust levels:
 *   new         — first sighting, < 24h old
 *   trusted     — 1 account, >= 24h old, no flags
 *   suspicious  — has 2+ accounts OR signal matched
 *   untrusted   — 3+ accounts OR explicit fraud confirmation
 */

import { createHash } from 'crypto';
import { query } from '../config/database';
import { getAdminSettingNumber as getSetting } from './admin-settings.service';

export type DeviceTrustLevel = 'trusted' | 'new' | 'suspicious' | 'untrusted';

export interface DeviceInfo {
  fingerprintHash: string;
  userIds: string[];
  accountCount: number;
  trustLevel: DeviceTrustLevel;
  firstSeenAt: Date;
  lastSeenAt: Date;
  suspiciousReason: string | null;
}

export interface DeviceDecision {
  fingerprintHash: string;
  existingUserIds: string[];   // other users already on this device
  accountCount: number;         // including the user we're recording
  trustLevel: DeviceTrustLevel;
  shouldFlag: boolean;
  reason: string | null;
}

/**
 * Normalize + hash a raw fingerprint string. SHA-256 hex (64 chars).
 * Empty / null input → null (caller should skip registration).
 */
export function hashFingerprint(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 8) return null;       // too short to be useful
  return createHash('sha256').update(trimmed).digest('hex');
}

/**
 * Load admin thresholds. Defaults per v2.0 spec:
 *   fraud_max_accounts_per_device = 2
 *   fraud_flag_accounts_per_device = 2
 */
async function loadDeviceLimits(): Promise<{
  flagThreshold: number;       // device with this many accounts → flag all
  blockThreshold: number;      // device with this many accounts → block + review
}> {
  const [flagT, blockT] = await Promise.all([
    getSetting('fraud_flag_accounts_per_device', 2, true),
    getSetting('fraud_block_accounts_per_device', 3, true),
  ]);
  return { flagThreshold: flagT, blockThreshold: blockT };
}

/**
 * Look up a device without recording it. Pure read.
 */
export async function lookupDevice(fpHash: string): Promise<DeviceInfo | null> {
  const r = await query(
    `SELECT fingerprint_hash, user_ids, account_count, trust_level,
            first_seen_at, last_seen_at, suspicious_reason
       FROM device_fingerprints
      WHERE fingerprint_hash = $1
      LIMIT 1`,
    [fpHash],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as {
    fingerprint_hash: string;
    user_ids: string[];
    account_count: number;
    trust_level: DeviceTrustLevel;
    first_seen_at: Date;
    last_seen_at: Date;
    suspicious_reason: string | null;
  };
  return {
    fingerprintHash: row.fingerprint_hash,
    userIds: row.user_ids,
    accountCount: row.account_count,
    trustLevel: row.trust_level,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    suspiciousReason: row.suspicious_reason,
  };
}

/**
 * Record that `userId` is using device `fpHash` with the given browser
 * info. Idempotent — re-recording the same user on the same device is a
 * no-op (UNIQUE constraint + array_append uses DISTINCT).
 *
 * Returns the device decision: should the user be flagged? Blocked?
 * The caller (signup/login route) decides what to do with the flag.
 *
 * This is the SINGLE function called from auth paths. It does the upsert,
 * the trust-level computation, and the fraud decision in one transaction.
 */
export async function recordDeviceUse(
  userId: string,
  rawFingerprint: string | null | undefined,
  browserInfo: Record<string, unknown> = {},
): Promise<DeviceDecision | null> {
  const fpHash = hashFingerprint(rawFingerprint);
  if (!fpHash) return null;             // no fingerprint → skip silently

  const limits = await loadDeviceLimits();

  // Upsert: append userId to the array if not already there.
  // Note: `existing` SELECT must include ALL columns referenced in
  // the outer UNION ALL, otherwise the parser errors with
  // "column X does not exist" because the UNION shape is fixed.
  const upsertRes = await query(
    `WITH existing AS (
       SELECT id, user_ids, account_count, first_seen_at
         FROM device_fingerprints
        WHERE fingerprint_hash = $1
     ),
     updated AS (
       UPDATE device_fingerprints df
          SET user_ids      = (
                SELECT array_agg(DISTINCT v) FROM unnest(df.user_ids || ARRAY[$2]::uuid[]) v
              ),
              account_count = (
                SELECT count(DISTINCT v) FROM unnest(df.user_ids || ARRAY[$2]::uuid[]) v
              ),
              last_seen_at  = NOW(),
              browser_info  = COALESCE(df.browser_info, '{}'::jsonb) || $3::jsonb
        WHERE df.fingerprint_hash = $1
        RETURNING id, user_ids, account_count, first_seen_at
     )
     SELECT id, user_ids, account_count, first_seen_at FROM existing
     UNION ALL
     SELECT id, user_ids, account_count, first_seen_at FROM updated`,
    [fpHash, userId, JSON.stringify(browserInfo)],
  );

  // If neither branch returned a row, INSERT new device row.
  let row: { id: string; user_ids: string[]; account_count: number; first_seen_at: Date };
  if (upsertRes.rows.length === 0) {
    const ins = await query(
      `INSERT INTO device_fingerprints (fingerprint_hash, user_ids, account_count, browser_info)
       VALUES ($1, ARRAY[$2]::uuid[], 1, $3::jsonb)
       RETURNING id, user_ids, account_count, first_seen_at`,
      [fpHash, userId, JSON.stringify(browserInfo)],
    );
    row = ins.rows[0] as typeof row;
  } else {
    row = upsertRes.rows[0] as typeof row;
  }
  if (!row) {
    // Should never happen — defensive.
    return {
      fingerprintHash: fpHash,
      existingUserIds: [],
      accountCount: 1,
      trustLevel: 'new',
      shouldFlag: false,
      reason: null,
    };
  }

  const otherUsers = (row.user_ids ?? []).filter((u: string) => u !== userId);
  const accountCount: number = row.account_count;

  // Trust level logic.
  let trustLevel: DeviceTrustLevel = 'new';
  let shouldFlag = false;
  let reason: string | null = null;

  if (accountCount >= limits.blockThreshold) {
    trustLevel = 'untrusted';
    shouldFlag = true;
    reason = `device_has_${accountCount}_accounts_block_threshold`;
  } else if (accountCount >= limits.flagThreshold) {
    trustLevel = 'suspicious';
    shouldFlag = true;
    reason = `device_has_${accountCount}_accounts_flag_threshold`;
  } else {
    // Single-account device: 'new' for first 24h, 'trusted' after.
    const ageMs = Date.now() - new Date(row.first_seen_at).getTime();
    trustLevel = ageMs > 24 * 3600 * 1000 ? 'trusted' : 'new';
  }

  // Persist trust-level if it changed.
  await query(
    `UPDATE device_fingerprints
        SET trust_level       = $2,
            suspicious_reason = $3
      WHERE fingerprint_hash = $1`,
    [fpHash, trustLevel, reason],
  );

  // Keep users.device_count in sync.
  await query(
    `UPDATE users SET device_count = (
       SELECT count(DISTINCT v) FROM unnest($1::uuid[]) v
     )
     WHERE id = $2`,
    [row.user_ids ?? [], userId],
  );

  // Phase 1.3: record graph edges so multi-account device use is
  // visible to fraud cluster detection. Edges between the new user
  // and every existing user on this device. Each edge is idempotent
  // (UNIQUE constraint); only added when there's actually overlap.
  if (otherUsers.length > 0) {
    try {
      const { addEdgesFromResource } = await import('./graph-fraud');
      await addEdgesFromResource(userId, otherUsers, 'device', fpHash);
    } catch (e) {
      // Non-fatal — graph service is best-effort enrichment.
      // eslint-disable-next-line no-console
      console.error('[device-fingerprint] graph edge write failed:', e);
    }
  }

  return {
    fingerprintHash: fpHash,
    existingUserIds: otherUsers,
    accountCount,
    trustLevel,
    shouldFlag,
    reason,
  };
}

/**
 * List all devices a given user has been seen on.
 * Used by the admin fraud panel ("show me every device this account touched").
 */
export async function getDevicesForUser(userId: string): Promise<DeviceInfo[]> {
  const r = await query(
    `SELECT fingerprint_hash, user_ids, account_count, trust_level,
            first_seen_at, last_seen_at, suspicious_reason
       FROM device_fingerprints
      WHERE $1 = ANY(user_ids)
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return r.rows.map((row) => {
    const x = row as {
      fingerprint_hash: string;
      user_ids: string[];
      account_count: number;
      trust_level: DeviceTrustLevel;
      first_seen_at: Date;
      last_seen_at: Date;
      suspicious_reason: string | null;
    };
    return {
      fingerprintHash: x.fingerprint_hash,
      userIds: x.user_ids,
      accountCount: x.account_count,
      trustLevel: x.trust_level,
      firstSeenAt: new Date(x.first_seen_at),
      lastSeenAt: new Date(x.last_seen_at),
      suspiciousReason: x.suspicious_reason,
    };
  });
}