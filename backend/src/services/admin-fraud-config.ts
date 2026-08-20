/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN FRAUD CONFIG — generic KYC & risk threshold persistence.
 *
 *  Part of the P1-11 refactor.
 *
 *  Note: the typed `GameConfig` interface has no explicit "fraud &
 *  risk" fields — risk thresholds, velocity limits, and KYC
 *  overrides are stored as opaque `admin_settings` rows keyed by
 *  string. This module owns the two read/write helpers used by all
 *  KYC services (kyc.ts, kyc-settings.ts, kyc-enforcement.service.ts,
 *  admin-adjustment.service.ts) to read and write those raw rows.
 *
 *  Keeping them in their own module makes it obvious where to look
 *  when adding a new KYC threshold (setRawSetting), and gives the
 *  fraud-detection work its own home for future domain expansion
 *  (e.g., a typed RiskConfig interface in P1-13).
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';

/**
 * Generic raw key/value reader for the `admin_settings` table. Used
 * for settings that are outside the typed `GameConfig` interface —
 * primarily KYC provider secrets, risk thresholds, and overrides.
 *
 * Returns the raw string value as stored (could be a JSON-encoded
 * object, a number-string, a date string, etc. — caller is
 * responsible for parsing). Returns `null` if the key is not set or
 * the DB is unreachable.
 */
export async function getRawSetting(key: string): Promise<string | null> {
  try {
    const result = await query('SELECT value FROM admin_settings WHERE key = $1', [key]);
    return result.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Generic raw key/value writer for the `admin_settings` table. Used
 * to persist KYC provider secrets, risk thresholds, and other
 * non-GameConfig settings. Performs an UPSERT: if the key exists
 * the value (and optionally the description) is updated; otherwise
 * a new row is inserted. Never throws.
 */
export async function setRawSetting(
  key: string,
  value: string,
  description?: string,
): Promise<void> {
  await query(
    `INSERT INTO admin_settings (key, value, description, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2,
       description = COALESCE($3, admin_settings.description),
       updated_at = NOW()`,
    [key, value, description || null],
  );
}
