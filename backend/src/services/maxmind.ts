/**
 * P3-4a — MaxMind GeoIP2 country lookup service.
 *
 * Resolves a client IP address to:
 *   - ISO 3166-1 alpha-2 country code
 *   - whether the IP is anonymous (Tor / VPN / proxy)
 *   - whether the IP is a hosting/datacenter range
 *   - the MaxMind connection-type label
 *   - a confidence value (0..1)
 *
 * Provider priority (admin-configurable via `geoip_provider`):
 *
 *   1. 'maxmind' (default) — official MaxMind GeoLite2-Country.mmdb
 *      via the `maxmind` npm package. Best accuracy, requires a
 *      downloaded .mmdb file. Path is admin-configurable via
 *      `geoip_mmdb_path` (default: /app/geoip/GeoLite2-Country.mmdb).
 *
 *   2. 'geoip_lite' — bundled IP->country database shipped with
 *      the `geoip-lite` npm package. Less accurate, but always
 *      available with zero setup. No anonymous/hosting detection.
 *
 *   3. 'noop' — no provider, returns synthetic result so the rest
 *      of the stack still works. Used in environments where the
 *      .mmdb file is unavailable (CI, dev sandboxes).
 *
 * Safe-fallback: if the configured provider fails to open the
 * .mmdb (file missing, corrupt, wrong type), the service logs
 * once and falls back to geoip_lite. A second failure in geoip_lite
 * falls back to noop. The risk engine and withdrawal pipeline
 * never see an exception from this module.
 *
 * Caching: every successful lookup is persisted to
 * `geoip_country_cache` (P3-4a migration 039) with a 7-day TTL.
 * The hot path does a single SELECT before opening the .mmdb
 * reader, so steady-state load doesn't touch the file system.
 *
 * Naming note: this is the *MaxMind* integration. The existing
 * `geoip-lite`-based middleware (`backend/src/middleware/geoip.ts`)
 * is left untouched for now — it handles the *blocking* layer
 * (hardcoded US/CU/IR/KP/SY). This service handles the *scoring*
 * layer (high-risk country weight, IP/KYC mismatch detection).
 * P3-4b will unify the two.
 */

import { promises as fs } from 'fs';
import path from 'path';
import maxmind from 'maxmind';
import type { Reader } from 'maxmind';
import geoip from 'geoip-lite';
import { query } from '../config/database';
import { getAdminSetting, getAdminSettingNumber } from './admin-settings.service';

// Minimal subset of the MaxMind GeoLite2-Country record shape. We
// only need the bits we actually consume; the upstream library
// (mmdb-lib) exports the full schema, but pulling all of it adds
// transitive type noise to a service that does one read-only lookup.
//
// If you need to add additional fields (city, location, ASN, etc.)
// just extend this interface — the runtime lookup will already return
// them, you just haven't typed them yet.
interface MmdbCountryRecord {
  country?: { iso_code?: string; names?: { en?: string } };
  registered_country?: { iso_code?: string };
  traits?: {
    is_anonymous?: boolean;
    is_anonymous_proxy?: boolean;
    is_anonymous_vpn?: boolean;
    is_hosting_provider?: boolean;
    is_tor_exit_node?: boolean;
    user_type?: string;
  };
  // AnonymousIP-only fields (only present if you load the
  // GeoIP2-Anonymous-IP.mmdb; we don't yet, but the cast is safe
  // because TS will just leave the value undefined).
  is_anonymous?: boolean;
  is_anonymous_vpn?: boolean;
  is_public_proxy?: boolean;
  is_residential_proxy?: boolean;
  // Connection-type-only fields (same caveat as above).
  connection_type?: 'Corporate' | 'Mobile' | 'Residential' | 'DataCenter' | string;
}

// Country type (matches MaxMind's `country` shape, narrowed)
export interface CountryRecord {
  countryCode: string | null;        // ISO 3166-1 alpha-2, uppercase
  isAnonymous: boolean;              // Tor / VPN / proxy
  isHosting: boolean;                 // datacenter / cloud / hosting
  sourceLabel: string | null;        // MaxMind connection_type label
  confidence: number;                // 0..1
  provider: 'maxmind' | 'geoip_lite' | 'noop';
}

const NOOP_RESULT: CountryRecord = {
  countryCode: null,
  isAnonymous: false,
  isHosting: false,
  sourceLabel: null,
  confidence: 0,
  provider: 'noop',
};

// Memoised reader + a guard so the file system is only touched once
// per process. Both the cache-check path and the lookup path can
// call into this without re-reading.
let cachedReader: Reader<MmdbCountryRecord> | null = null;
let cachedReaderPath: string | null = null;
let lastOpenError: string | null = null;
let lastOpenErrorLoggedAt = 0;

async function getReader(mmdbPath: string): Promise<Reader<MmdbCountryRecord> | null> {
  if (cachedReader && cachedReaderPath === mmdbPath) return cachedReader;
  try {
    const exists = await fs.access(mmdbPath).then(() => true).catch(() => false);
    if (!exists) {
      maybeLogOpenError(`maxmind db not found at ${mmdbPath}`);
      return null;
    }
    // The .mmdb library supports only `cache.max` (number of records
    // to memoise). Country assignments are stable on the order of
    // months, so memoise up to 1000 hot IPs.
    const reader = await maxmind.open<MmdbCountryRecord>(mmdbPath, {
      cache: { max: 1000 },
    });
    cachedReader = reader;
    cachedReaderPath = mmdbPath;
    return reader;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    maybeLogOpenError(`maxmind.open failed: ${msg}`);
    return null;
  }
}

function maybeLogOpenError(msg: string): void {
  // Log at most once per 60s to avoid flooding the log when the
  // file is genuinely missing.
  const now = Date.now();
  if (lastOpenError === msg && now - lastOpenErrorLoggedAt < 60_000) return;
  lastOpenError = msg;
  lastOpenErrorLoggedAt = now;
  console.warn(`[maxmind] ${msg} — falling back to geoip_lite`);
}

/**
 * Force the in-process MaxMind reader to be re-opened on the next
 * lookup. Used by the admin "switch provider" endpoint after it
 * changes `geoip_mmdb_path`. Safe to call at any time; subsequent
 * `lookupCountry()` calls will simply re-attempt `maxmind.open()`
 * if the new path is configured.
 *
 * Also resets `lastOpenError` so a freshly-mounted .mmdb file is
 * not silently hidden behind the rate-limited warning.
 */
export function invalidateReader(): void {
  cachedReader = null;
  cachedReaderPath = null;
  lastOpenError = null;
  lastOpenErrorLoggedAt = 0;
}

/**
 * Read-only snapshot of the in-process cache state. Used by the
 * admin "GeoIP status" endpoint to surface whether a real MaxMind
 * file is loaded and whether the in-process memo is stale.
 */
export interface ReaderState {
  loaded: boolean;
  path: string | null;
  lastError: string | null;
}
export function getReaderState(): ReaderState {
  return {
    loaded: cachedReader !== null,
    path: cachedReaderPath,
    lastError: lastOpenError,
  };
}

// Default country high-risk list. Admin can override per the plan
// (P3-4b will replace this with a DB-backed table). Codes follow
// ISO 3166-1 alpha-2, uppercase. Source: FATF high-risk + AML
// watchlists as of 2024 — operator reviews this list annually.
export const DEFAULT_HIGH_RISK_COUNTRIES: ReadonlySet<string> = new Set([
  'KP', // North Korea
  'IR', // Iran
  'MM', // Myanmar
  'AF', // Afghanistan
  'YE', // Yemen
  'SY', // Syria
  'SO', // Somalia
  'LY', // Libya
  'SD', // Sudan
  'CD', // DR Congo (some lists)
  'XX', // Reserved (placeholder)
  'YY', // Reserved (placeholder, AI risk engine uses this)
]);

export async function getHighRiskCountries(): Promise<Set<string>> {
  // Admin override: comma-separated list in admin_settings. Empty
  // means "use defaults". Stored key: `geoip_high_risk_countries`.
  const override = await getAdminSetting('geoip_high_risk_countries', '');
  if (!override || !override.trim()) return new Set(DEFAULT_HIGH_RISK_COUNTRIES);
  return new Set(
    override
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length === 2)
  );
}

/**
 * Raw MaxMind-only lookup. Returns the narrowest possible result
 * without any caching or admin lookups. Use this from tests; production
 * code should call `lookupCountry()` which wraps this with the cache
 * + admin-provider chain.
 */
export async function rawMaxmindLookup(
  ip: string,
  mmdbPath = '/app/geoip/GeoLite2-Country.mmdb',
): Promise<CountryRecord> {
  const reader = await getReader(mmdbPath);
  if (!reader) return NOOP_RESULT;
  try {
    const result = reader.get(ip) as MmdbCountryRecord | null | undefined;
    if (!result || !result.country) return NOOP_RESULT;
    const iso = result.country.iso_code;
    if (!iso) return NOOP_RESULT;
    // MaxMind connection_type is documented in the GeoIP2 ISP/City
    // databases; for the free Country db it's often absent. The
    // shape is { connection_type: 'Corporate' | 'Mobile' | 'Residential' | ... }
    // or undefined.
    const connType = (result as unknown as { connection_type?: string }).connection_type ?? null;
    const traits = (result as unknown as { traits?: { is_anonymous_proxy?: boolean; is_hosting_provider?: boolean } }).traits;
    return {
      countryCode: iso.toUpperCase(),
      isAnonymous: !!traits?.is_anonymous_proxy,
      isHosting: !!traits?.is_hosting_provider,
      sourceLabel: connType,
      confidence: 0.95, // MaxMind is the authoritative source
      provider: 'maxmind',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    maybeLogOpenError(`maxmind reader.get failed: ${msg}`);
    return NOOP_RESULT;
  }
}

/**
 * geoip_lite fallback. Always available, no .mmdb file needed,
 * but only returns countryCode (no isAnonymous / isHosting / sourceLabel).
 */
function rawGeoipLiteLookup(ip: string): CountryRecord {
  try {
    const result = geoip.lookup(ip);
    if (!result || !result.country) return NOOP_RESULT;
    return {
      countryCode: result.country,
      isAnonymous: false,
      isHosting: false,
      sourceLabel: null,
      confidence: 0.7, // geoip_lite is less accurate than MaxMind
      provider: 'geoip_lite',
    };
  } catch {
    return NOOP_RESULT;
  }
}

/**
 * Read a non-expired cache row for the given IP+provider.
 * Returns null if the row is missing or expired.
 */
async function readCache(
  ip: string,
  provider: 'maxmind' | 'geoip_lite',
): Promise<CountryRecord | null> {
  try {
    const r = await query(
      `SELECT country_code, is_anonymous, is_hosting, source_label, confidence
         FROM geoip_country_cache
        WHERE ip_address = $1::inet
          AND provider = $2
          AND expires_at > NOW()
        ORDER BY checked_at DESC
        LIMIT 1`,
      [ip, provider],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as {
      country_code: string;
      is_anonymous: boolean;
      is_hosting: boolean;
      source_label: string | null;
      confidence: number | null;
    };
    return {
      countryCode: row.country_code,
      isAnonymous: row.is_anonymous,
      isHosting: row.is_hosting,
      sourceLabel: row.source_label,
      confidence: row.confidence ?? 0.5,
      provider,
    };
  } catch {
    // Cache read failures are non-fatal. Fall through to live lookup.
    return null;
  }
}

/**
 * Persist a successful lookup to the cache. Failures are logged
 * at debug level only — the live lookup result is the source of
 * truth, the cache is just a hot-path accelerator.
 */
async function writeCache(ip: string, record: CountryRecord): Promise<void> {
  if (record.countryCode === null) return; // don't cache noop results
  if (record.provider === 'noop') return; // nothing useful to cache
  try {
    // De-dupe on (ip, provider) by deleting prior rows for the same
    // pair first, then inserting. There's no UNIQUE constraint on
    // (ip, provider) — just an index — so ON CONFLICT DO NOTHING
    // wouldn't fire anyway. A delete-then-insert keeps the schema
    // simple and the latest-read-wins semantic correct.
    await query(`DELETE FROM geoip_country_cache WHERE ip_address = $1::inet AND provider = $2`,
                 [ip, record.provider]);
    await query(
      `INSERT INTO geoip_country_cache
         (ip_address, provider, country_code, is_anonymous, is_hosting, source_label, confidence)
       VALUES ($1::inet, $2, $3, $4, $5, $6, $7)`,
      [
        ip,
        record.provider,
        record.countryCode,
        record.isAnonymous,
        record.isHosting,
        record.sourceLabel,
        record.confidence,
      ],
    );
  } catch (err) {
    // Use console.error during dev so silent failures show up. In
    // production, the hot-path lookup already returned the correct
    // answer; this cache is a warm-path accelerator, so any failure
    // here is non-fatal and only the next call will pay the full cost.
    console.error('[maxmind] cache write failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/**
 * The single entry point used by ai-risk-engine and withdrawal-risk.
 *
 * Flow:
 *   1. Read admin_setting `geoip_provider` (default: 'maxmind').
 *   2. If 'maxmind', check cache → if hit, return it.
 *   3. If miss, do MaxMind lookup → on success write cache + return.
 *   4. On any failure (no .mmdb, error), fall back to geoip_lite
 *      (with its own cache) → then to noop.
 *
 * Never throws. Always returns a CountryRecord.
 */
export async function lookupCountry(ip: string): Promise<CountryRecord> {
  // Skip private/loopback addresses — no point in caching those.
  // The middleware layer (geoip.ts) already does this; this is
  // defence in depth.
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:')) {
    return { ...NOOP_RESULT, sourceLabel: 'loopback' };
  }

  const provider = (await getAdminSetting('geoip_provider', 'maxmind')) ?? 'maxmind';
  const mmdbPath =
    (await getAdminSetting('geoip_mmdb_path', '/app/geoip/GeoLite2-Country.mmdb')) ??
    '/app/geoip/GeoLite2-Country.mmdb';

  // Try primary provider first
  if (provider === 'maxmind') {
    const cached = await readCache(ip, 'maxmind');
    if (cached) return cached;
    const result = await rawMaxmindLookup(ip, mmdbPath);
    if (result.countryCode !== null) {
      await writeCache(ip, result);
      return result;
    }
  }

  // Fallback to geoip_lite
  const fallbackCached = await readCache(ip, 'geoip_lite');
  if (fallbackCached) return fallbackCached;
  const fallback = rawGeoipLiteLookup(ip);
  if (fallback.countryCode !== null) {
    await writeCache(ip, fallback);
    return fallback;
  }

  return NOOP_RESULT;
}

/**
 * Detect a mismatch between the IP-derived country and the
 * KYC-declared country on the user record. Returns:
 *   - 'no_data'        : either side missing
 *   - 'match'          : same country (case-insensitive)
 *   - 'mismatch'       : different countries
 *   - 'suspicious'     : both countries exist but both are high-risk
 *                        (likely VPN + KYC fraud pattern)
 *
 * Used by the risk engine to surface an explicit signal rather
 * than just "high-risk country" — this is the real P3-4a insight.
 */
export type CountryMismatchResult =
  | { kind: 'no_data' }
  | { kind: 'match'; country: string }
  | { kind: 'mismatch'; ipCountry: string; kycCountry: string; ipHighRisk: boolean; kycHighRisk: boolean }
  | { kind: 'suspicious'; country: string };

export async function detectCountryMismatch(
  ip: string,
  kycCountry: string | null,
): Promise<{ result: CountryMismatchResult; record: CountryRecord }> {
  const record = await lookupCountry(ip);
  const ipCountry = record.countryCode;
  if (!ipCountry || !kycCountry) {
    return { result: { kind: 'no_data' }, record };
  }
  const ipUp = ipCountry.toUpperCase();
  const kycUp = kycCountry.toUpperCase();
  if (ipUp === kycUp) {
    return { result: { kind: 'match', country: ipUp }, record };
  }
  const highRisk = await getHighRiskCountries();
  const ipHighRisk = highRisk.has(ipUp);
  const kycHighRisk = highRisk.has(kycUp);
  if (ipHighRisk && kycHighRisk) {
    // Both ends are high-risk — most common pattern is: scammer
    // opens account with one KYC country, then logs in from
    // another high-risk jurisdiction. Treat as suspicious rather
    // than just "mismatch" so the risk engine can weight it.
    return { result: { kind: 'suspicious', country: ipUp }, record };
  }
  return {
    result: { kind: 'mismatch', ipCountry: ipUp, kycCountry: kycUp, ipHighRisk, kycHighRisk },
    record,
  };
}

/**
 * Suggest the .mmdb file location for a fresh install. The actual
 * file isn't shipped in the repo (MaxMind license) but the path
 * conventions are stable.
 */
export const DEFAULT_MMDB_PATHS = [
  '/app/geoip/GeoLite2-Country.mmdb',                // container default
  path.join(process.cwd(), 'geoip', 'GeoLite2-Country.mmdb'),
  '/usr/local/share/GeoLite2/GeoLite2-Country.mmdb',
];

// ── Risk-engine glue ─────────────────────────────────────────

/**
 * Signal codes written to fraud_signals by this service. Kept as
 * constants so ai-risk-engine and tests can reference them without
 * a typo.
 */
export const GEO_SIGNAL_TYPES = {
  /** IP country is on the high-risk list. Weight 12. */
  IP_HIGH_RISK_COUNTRY: 'ip_high_risk_country',
  /** IP country does not match the KYC-declared country. Weight 18. */
  IP_KYC_MISMATCH: 'ip_kyc_country_mismatch',
  /** Both IP and KYC are high-risk countries (e.g. layered KYC fraud). Weight 22. */
  IP_KYC_BOTH_HIGH_RISK: 'ip_kyc_both_high_risk',
  /** IP is anonymous (Tor / VPN / proxy). Weight 15. (Note: ip-reputation
   *  already writes 'ip_tor' / 'ip_vpn_proxy'; this is the MaxMind-derived
   *  variant with country context.) */
  IP_ANONYMOUS: 'ip_anonymous_maxmind',
  /** IP is a hosting / datacenter range. Weight 10. (Same as above,
   *  MaxMind variant for the country context.) */
  IP_HOSTING: 'ip_hosting_maxmind',
} as const;

/**
 * Resolve the IP+user, write fraud_signals rows that the AI risk
 * engine and withdrawal pipeline can pick up via the same
 * `loadUserContext()` path that already ingests ip_tor / ip_vpn_proxy
 * / ip_datacenter / ip_known_fraudster from ip-reputation.ts.
 *
 * Idempotent: if a fraud_signals row for this (user, signal_type)
 * already exists with a recent `detected_at`, the row is left alone
 * (we just touch `metadata`). This keeps the signal count stable
 * across multiple logins from the same IP.
 *
 * Failures (no DB, no IP, lookup failure) are non-fatal: we log and
 * return without throwing. The risk engine still computes a score.
 */
export async function persistIpGeoSignals(
  userId: string,
  ip: string,
  opts: { lookbackHours?: number } = {},
): Promise<{ country: CountryRecord; mismatch: CountryMismatchResult }> {
  const lookback = opts.lookbackHours ?? 24;
  // Find the country first (or noop)
  const mismatch = await detectCountryMismatch(ip, await kycCountryForUser(userId));
  const record = mismatch.record;

  // Helper to insert-or-touch a signal row
  const touch = async (
    signalType: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    metadata: Record<string, unknown>,
  ) => {
    try {
      const existing = await query(
        `SELECT id FROM fraud_signals
          WHERE user_id = $1::uuid AND signal_type = $2
            AND detected_at > NOW() - ($3::int || ' hours')::interval
          ORDER BY detected_at DESC LIMIT 1`,
        [userId, signalType, lookback],
      );
      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO fraud_signals
             (user_id, signal_type, severity, status, metadata, detected_at)
           VALUES ($1::uuid, $2, $3, 'open', $4::jsonb, NOW())`,
          [userId, signalType, severity, JSON.stringify(metadata)],
        );
      } else {
        await query(
          `UPDATE fraud_signals SET metadata = $2::jsonb, detected_at = NOW()
            WHERE id = $1::uuid`,
          [(existing.rows[0] as { id: string }).id, JSON.stringify(metadata)],
        );
      }
    } catch (err) {
      console.debug(
        '[maxmind] persistIpGeoSignals: signal write failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Country-derived signals
  if (record.countryCode) {
    const highRisk = await getHighRiskCountries();
    if (highRisk.has(record.countryCode)) {
      await touch(GEO_SIGNAL_TYPES.IP_HIGH_RISK_COUNTRY, 'medium', {
        country: record.countryCode,
        provider: record.provider,
        confidence: record.confidence,
        source: 'maxmind_geoip',
      });
    }
    if (record.isAnonymous) {
      await touch(GEO_SIGNAL_TYPES.IP_ANONYMOUS, 'high', {
        country: record.countryCode,
        source_label: record.sourceLabel,
        provider: record.provider,
      });
    }
    if (record.isHosting) {
      await touch(GEO_SIGNAL_TYPES.IP_HOSTING, 'medium', {
        country: record.countryCode,
        source_label: record.sourceLabel,
        provider: record.provider,
      });
    }
  }

  // KYC/IP mismatch signals (only if both sides have data)
  switch (mismatch.result.kind) {
    case 'mismatch':
      await touch(GEO_SIGNAL_TYPES.IP_KYC_MISMATCH, 'high', {
        ip_country: mismatch.result.ipCountry,
        kyc_country: mismatch.result.kycCountry,
        ip_high_risk: mismatch.result.ipHighRisk,
        kyc_high_risk: mismatch.result.kycHighRisk,
        provider: record.provider,
      });
      break;
    case 'suspicious':
      await touch(GEO_SIGNAL_TYPES.IP_KYC_BOTH_HIGH_RISK, 'critical', {
        ip_country: mismatch.result.country,
        note: 'Both IP-derived and KYC-declared countries are high-risk; layered KYC fraud pattern',
        provider: record.provider,
      });
      break;
    // 'match' and 'no_data' don't write signals
  }

  return { country: record, mismatch: mismatch.result };
}

async function kycCountryForUser(userId: string): Promise<string | null> {
  try {
    const r = await query(
      `SELECT kyc_country FROM users WHERE id = $1::uuid`,
      [userId],
    );
    if (r.rows.length === 0) return null;
    return ((r.rows[0] as { kyc_country: string | null }).kyc_country ?? null) as string | null;
  } catch {
    return null;
  }
}
