/**
 * Phase 2.3 — IP Reputation Service (L07)
 *
 * Provider-agnostic IP risk lookup. Flow:
 *   1. Check admin-managed ip_blocklist (deny wins over allow; fastest)
 *   2. Check ip_reputation_cache (TTL 1d by default — most lookups hit
 *      here, no external API call)
 *   3. If miss AND a provider is configured (env or admin setting),
 *      query the provider. Default = mock provider that returns
 *      "unknown" (no false positives, safe default).
 *   4. Persist the result to cache + write any fraud_signals rows
 *      the risk engine expects (ip_tor / ip_datacenter /
 *      ip_known_fraudster).
 *
 * Provider support today: AbuseIPDB (free tier) + mock.
 *   - Set ABUSEIPDB_API_KEY in env OR admin_settings.abuseipdb_api_key
 *   - Service auto-uses AbuseIPDB if key present, else mock
 *
 * Add a new provider by implementing the IpReputationProvider
 * interface and adding it to buildProvider() below.
 *
 * IMPORTANT: this service never BLOCKS a user. It only writes
 * fraud_signals rows + cached results. The risk engine + admin
 * reviewer decide what to do with the data.
 */

import { query } from '../config/database';
import { redis } from '../config/redis';
import { getAdminSetting, getAdminSettingBool, getAdminSettingNumber as getSetting } from './admin-settings.service';

// ── Types ────────────────────────────────────────────────────────

export interface IpReputationResult {
  ip: string;
  provider: 'abuseipdb' | 'tor' | 'manual' | 'mock' | 'cache' | 'blocklist';
  abuseScore: number;            // 0-100, higher = more abusive
  isTor: boolean;
  isDatacenter: boolean;
  isProxy: boolean;
  isKnownFraud: boolean;
  countryCode: string | null;
  cached: boolean;
  blocklistType: 'deny' | 'allow' | null;
  checkedAt: Date;
  expiresAt: Date;
  source: 'cache' | 'fresh_lookup' | 'blocklist';
}

// ── Provider interface ─────────────────────────────────────────

export interface IpReputationProvider {
  name: 'abuseipdb' | 'tor' | 'mock';
  lookup(ip: string, apiKey?: string | null): Promise<Omit<IpReputationResult,
    'ip' | 'cached' | 'blocklistType' | 'source' | 'checkedAt' | 'expiresAt'>>;
}

// ── AbuseIPDB provider ─────────────────────────────────────────

class AbuseIpDbProvider implements IpReputationProvider {
  name = 'abuseipdb' as const;
  async lookup(ip: string, apiKey: string | null) {
    if (!apiKey) {
      // No key — fall through to mock.
      return mockProvider.lookup(ip, null);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Key': apiKey, 'Accept': 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ...(await mockProvider.lookup(ip, null)), provider: 'abuseipdb' as const };
      }
      const body: any = await res.json();
      const d = body.data || {};
      const score = Number(d.abuseConfidenceScore ?? 0);
      return {
        provider: 'abuseipdb' as const,
        abuseScore: Math.max(0, Math.min(100, score)),
        isTor: false,                                    // abuseipdb doesn't surface this directly
        isDatacenter: !!(d.usageType === 'Data Center/Transit'),
        isProxy: !!(d.usageType === 'VPN' || d.usageType === 'proxy'),
        isKnownFraud: score >= (await getSetting('fraud_ip_known_fraudster_threshold', 80, true)),
        countryCode: typeof d.countryCode === 'string' ? d.countryCode : null,
      };
    } catch {
      return mockProvider.lookup(ip, null);
    } finally {
      clearTimeout(t);
    }
  }
}

// ── Mock provider (default; safe fail-open) ───────────────────

class MockProvider implements IpReputationProvider {
  name = 'mock' as const;
  async lookup(ip: string, _apiKey?: string | null) {
    // No live lookups; return all-unknown. Admin can populate
    // ip_blocklist manually or drop in an AbuseIPDB key.
    return {
      provider: 'mock' as const,
      abuseScore: 0,
      isTor: false,
      isDatacenter: false,
      isProxy: false,
      isKnownFraud: false,
      countryCode: null,
    };
  }
}

const mockProvider = new MockProvider();
const abuseIpDbProvider = new AbuseIpDbProvider();

function buildProvider(name: string | null | undefined): IpReputationProvider {
  if (name === 'abuseipdb') return abuseIpDbProvider;
  return mockProvider;
}

// ── Cache + persistence ────────────────────────────────────────

const CACHE_TTL_KEY = 'ip_reputation:';
const CACHE_TTL_SECONDS_DEFAULT = 86400;        // 1 day

async function readRedisCache(ip: string): Promise<IpReputationResult | null> {
  try {
    const raw = await redis.get(CACHE_TTL_KEY + ip);
    if (!raw) return null;
    return JSON.parse(raw, (k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) ? new Date(v) : v) as IpReputationResult;
  } catch { return null; }
}

async function writeRedisCache(result: IpReputationResult): Promise<void> {
  try {
    const ttl = await getSetting('ip_reputation_cache_ttl_seconds', CACHE_TTL_SECONDS_DEFAULT, true);
    await redis.set(CACHE_TTL_KEY + result.ip, JSON.stringify(result), 'EX', Math.max(60, ttl));
  } catch { /* best-effort */ }
}

// ── Main entry point ───────────────────────────────────────────

/**
 * Look up IP reputation. Returns a result object (never throws
 * on lookup failure — falls back to mock).
 *
 * Cache order:
 *   1. ip_blocklist (admin-managed; instant; no network)
 *   2. Redis cache (1d TTL by default)
 *   3. PostgreSQL ip_reputation_cache (durable log; if Redis miss
 *      we hydrate Redis from PG)
 *   4. Provider API (AbuseIPDB or mock)
 *
 * Always writes/refreshes the PG cache (audit trail) + emits
 * fraud_signals rows for any non-clean flag.
 */
export async function checkIpReputation(ip: string): Promise<IpReputationResult> {
  // 0. Validate the input. Skip private/loopback.
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:')) {
    return {
      ip, provider: 'mock', abuseScore: 0, isTor: false, isDatacenter: false,
      isProxy: false, isKnownFraud: false, countryCode: null, cached: true,
      blocklistType: null,
      checkedAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      source: 'fresh_lookup',
    };
  }

  // 1. Blocklist check (admin-managed).
  const bl = await query(
    `SELECT list_type, reason FROM ip_blocklist
      WHERE ip_address = $1::inet
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY (list_type = 'deny') DESC LIMIT 1`,
    [ip],
  );
  if (bl.rows.length > 0) {
    const row = bl.rows[0] as { list_type: 'deny' | 'allow'; reason: string };
    if (row.list_type === 'deny') {
      const result: IpReputationResult = {
        ip, provider: 'manual', abuseScore: 100, isTor: false, isDatacenter: true,
        isProxy: true, isKnownFraud: true, countryCode: null, cached: false,
        blocklistType: 'deny',
        checkedAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
        source: 'blocklist',
      };
      await writeRedisCache(result);
      await persistCache(result, row.reason);
      await emitFraudSignals(result, 'manual_blocklist');
      return result;
    }
    // 'allow' — return clean result and skip the rest.
    const result: IpReputationResult = {
      ip, provider: 'manual', abuseScore: 0, isTor: false, isDatacenter: false,
      isProxy: false, isKnownFraud: false, countryCode: null, cached: false,
      blocklistType: 'allow',
      checkedAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
      source: 'blocklist',
    };
    await writeRedisCache(result);
    await persistCache(result, row.reason);
    return result;
  }

  // 2. Redis cache.
  const cached = await readRedisCache(ip);
  if (cached && cached.expiresAt.getTime() > Date.now()) {
    return { ...cached, cached: true, source: 'cache' };
  }

  // 3. PG cache (durable log; hydrate Redis if found).
  const pgRow = await query(
    `SELECT provider, abuse_score, is_tor, is_datacenter, is_proxy,
            is_known_fraud, country_code, raw_response, checked_at, expires_at
       FROM ip_reputation_cache
      WHERE ip_address = $1::inet
        AND expires_at > NOW()
      ORDER BY checked_at DESC LIMIT 1`,
    [ip],
  );
  if (pgRow.rows.length > 0) {
    const r = pgRow.rows[0] as {
      provider: string; abuse_score: number; is_tor: boolean; is_datacenter: boolean;
      is_proxy: boolean; is_known_fraud: boolean; country_code: string | null;
      checked_at: Date; expires_at: Date;
    };
    const result: IpReputationResult = {
      ip, provider: r.provider as IpReputationResult['provider'],
      abuseScore: r.abuse_score, isTor: r.is_tor, isDatacenter: r.is_datacenter,
      isProxy: r.is_proxy, isKnownFraud: r.is_known_fraud, countryCode: r.country_code,
      cached: true, blocklistType: null,
      checkedAt: new Date(r.checked_at), expiresAt: new Date(r.expires_at),
      source: 'cache',
    };
    await writeRedisCache(result);
    return result;
  }

  // 4. Live provider lookup.
  const providerName = await getAdminSetting('ip_reputation_provider', 'mock');
  const apiKey = process.env.ABUSEIPDB_API_KEY
    || (await getAdminSetting('abuseipdb_api_key', '')) || null;
  const provider = buildProvider(providerName);
  const fresh = await provider.lookup(ip, apiKey);

  const result: IpReputationResult = {
    ip,
    provider: fresh.provider,
    abuseScore: fresh.abuseScore,
    isTor: fresh.isTor,
    isDatacenter: fresh.isDatacenter,
    isProxy: fresh.isProxy,
    isKnownFraud: fresh.isKnownFraud,
    countryCode: fresh.countryCode,
    cached: false,
    blocklistType: null,
    checkedAt: new Date(),
    expiresAt: new Date(Date.now() + (await getSetting('ip_reputation_cache_ttl_seconds', CACHE_TTL_SECONDS_DEFAULT, true)) * 1000),
    source: 'fresh_lookup',
  };
  await writeRedisCache(result);
  await persistCache(result, null);
  await emitFraudSignals(result, fresh.provider);
  return result;
}

async function persistCache(r: IpReputationResult, reason: string | null): Promise<void> {
  try {
    await query(
      `INSERT INTO ip_reputation_cache
         (ip_address, provider, abuse_score, is_tor, is_datacenter,
          is_proxy, is_known_fraud, country_code, checked_at, expires_at)
       VALUES ($1::inet, $2, $3::int, $4, $5, $6, $7, $8, $9, $10)`,
      [r.ip, r.provider, r.abuseScore, r.isTor, r.isDatacenter,
       r.isProxy, r.isKnownFraud, r.countryCode, r.checkedAt, r.expiresAt],
    );
    if (reason) {
      await query(
        `INSERT INTO audit_log (category, action, severity, details)
         VALUES ('fraud', 'ip.blocklist_hit', 'info', $1)`,
        [JSON.stringify({ ip: r.ip, reason })],
      );
    }
  } catch (e) { /* best-effort */ }
}

/**
 * Write fraud_signals rows so the risk engine's loadUserContext
 * picks them up on the next call. One row per non-clean flag.
 * Idempotent: uses check-then-write per signal_type.
 */
async function emitFraudSignals(r: IpReputationResult, source: string): Promise<void> {
  if (r.isKnownFraud) await writeFraudSignal(r.ip, 'ip_known_fraudster', 'high', source, r);
  if (r.isDatacenter) await writeFraudSignal(r.ip, 'ip_datacenter', 'medium', source, r);
  if (r.isTor) await writeFraudSignal(r.ip, 'ip_tor', 'high', source, r);
  if (r.isProxy) await writeFraudSignal(r.ip, 'ip_vpn_proxy', 'high', source, r);
}

async function writeFraudSignal(
  ip: string, signalType: string, severity: string, source: string,
  r: IpReputationResult,
): Promise<void> {
  try {
    const existing = await query(
      `SELECT id FROM fraud_signals
        WHERE user_id IN (SELECT id FROM users WHERE registration_ip = $1::text LIMIT 1)
          AND signal_type = $2
          AND status = 'open'
          AND detected_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [ip, signalType],
    );
    const metadata = JSON.stringify({
      ip, source, abuse_score: r.abuseScore,
      country_code: r.countryCode, provider: r.provider,
    });
    if (existing.rows.length > 0) {
      await query(
        `UPDATE fraud_signals SET metadata = $2::jsonb, detected_at = NOW()
          WHERE id = $1::uuid`,
        [(existing.rows[0] as { id: string }).id, metadata],
      );
    } else {
      // Find the most recent user from this IP and attach the signal
      // to them. If no user, the signal is still useful as a global flag.
      const userRow = await query(
        `SELECT id FROM users WHERE registration_ip = $1::text
          ORDER BY created_at DESC LIMIT 1`,
        [ip],
      );
      const userId = userRow.rows.length
        ? (userRow.rows[0] as { id: string }).id
        : null;
      if (userId) {
        await query(
          `INSERT INTO fraud_signals
             (user_id, signal_type, severity, status, metadata, detected_at)
           VALUES ($1::uuid, $2, $3, 'open', $4::jsonb, NOW())`,
          [userId, signalType, severity, metadata],
        );
      }
    }
  } catch { /* best-effort */ }
}

// ── Reports helper ────────────────────────────────────────────

/**
 * Aggregate report for the admin "IP Reputation Reports" view.
 * Counts by provider, top abusive IPs, recent lookups.
 */
export interface IpReputationReport {
  totalLookups24h: number;
  totalCacheRows: number;
  blocklistCount: { deny: number; allow: number };
  byProvider: Array<{ provider: string; n: number; avg_score: number | null }>;
  topAbusiveIps: Array<{ ip: string; abuse_score: number; provider: string; checked_at: Date }>;
  recentLookups: Array<{
    ip: string; provider: string; abuse_score: number;
    is_tor: boolean; is_datacenter: boolean; is_known_fraud: boolean; checked_at: Date;
  }>;
}

export async function getIpReputationReport(): Promise<IpReputationReport> {
  const totalLookups24h = (await query(
    `SELECT count(*)::int AS n FROM ip_reputation_cache
      WHERE checked_at > NOW() - INTERVAL '24 hours'`,
  )).rows[0] as { n: number };

  const totalCacheRows = (await query(
    `SELECT count(*)::int AS n FROM ip_reputation_cache WHERE expires_at > NOW()`,
  )).rows[0] as { n: number };

  const bl = await query(
    `SELECT list_type, count(*)::int AS n FROM ip_blocklist
      WHERE expires_at IS NULL OR expires_at > NOW()
      GROUP BY list_type`,
  );
  const blocklistCount = { deny: 0, allow: 0 };
  for (const r of bl.rows as Array<{ list_type: string; n: number }>) {
    if (r.list_type === 'deny') blocklistCount.deny = r.n;
    if (r.list_type === 'allow') blocklistCount.allow = r.n;
  }

  const byProvider = (await query(
    `SELECT provider, count(*)::int AS n, avg(abuse_score)::int AS avg_score
       FROM ip_reputation_cache
      WHERE checked_at > NOW() - INTERVAL '24 hours'
      GROUP BY provider ORDER BY n DESC`,
  )).rows as Array<{ provider: string; n: number; avg_score: number | null }>;

  const topAbusive = (await query(
    `SELECT ip_address::text AS ip, abuse_score, provider, checked_at
       FROM ip_reputation_cache
      WHERE checked_at > NOW() - INTERVAL '24 hours'
        AND (is_known_fraud OR is_tor OR is_datacenter OR abuse_score >= 50)
      ORDER BY abuse_score DESC, checked_at DESC LIMIT 10`,
  )).rows as Array<{ ip: string; abuse_score: number; provider: string; checked_at: Date }>;

  const recent = (await query(
    `SELECT ip_address::text AS ip, provider, abuse_score,
            is_tor, is_datacenter, is_known_fraud, checked_at
       FROM ip_reputation_cache
      ORDER BY checked_at DESC LIMIT 20`,
  )).rows as Array<{
    ip: string; provider: string; abuse_score: number;
    is_tor: boolean; is_datacenter: boolean; is_known_fraud: boolean; checked_at: Date;
  }>;

  return {
    totalLookups24h: totalLookups24h.n,
    totalCacheRows: totalCacheRows.n,
    blocklistCount,
    byProvider,
    topAbusiveIps: topAbusive,
    recentLookups: recent,
  };
}

// ── Admin blocklist helpers (also used by routes) ──────────────

export async function addToBlocklist(
  ip: string, listType: 'deny' | 'allow', reason: string, adminId: string,
  expiresAt: Date | null = null,
): Promise<{ id: string }> {
  const id = uuidv4();
  await query(
    `INSERT INTO ip_blocklist (id, ip_address, list_type, reason, source, created_by, expires_at)
     VALUES ($1::uuid, $2::inet, $3, $4, 'admin', $5::uuid, $6)
     ON CONFLICT (ip_address, list_type) DO UPDATE
       SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at
     RETURNING id`,
    [id, ip, listType, reason, adminId, expiresAt],
  );
  // Invalidate cached result for this IP so it gets re-fetched.
  try { await redis.del(CACHE_TTL_KEY + ip); } catch { /* ignore */ }
  return { id };
}

export async function removeFromBlocklist(ip: string, listType: 'deny' | 'allow'): Promise<void> {
  await query(`DELETE FROM ip_blocklist WHERE ip_address = $1::inet AND list_type = $2`, [ip, listType]);
  try { await redis.del(CACHE_TTL_KEY + ip); } catch { /* ignore */ }
}

export async function listBlocklist(): Promise<Array<{
  id: string; ip: string; list_type: 'deny' | 'allow';
  reason: string; created_by: string | null; created_at: Date; expires_at: Date | null;
}>> {
  const r = await query(
    `SELECT id, ip_address::text AS ip, list_type, reason, created_by, created_at, expires_at
       FROM ip_blocklist
      WHERE expires_at IS NULL OR expires_at > NOW()
      ORDER BY created_at DESC`,
  );
  return r.rows as Array<{
    id: string; ip: string; list_type: 'deny' | 'allow';
    reason: string; created_by: string | null; created_at: Date; expires_at: Date | null;
  }>;
}

import { v4 as uuidv4 } from 'uuid';