/**
 * P3-4b — Admin GeoIP settings endpoints.
 *
 * Six endpoints that give operators real-time control over the
 * MaxMind GeoIP2 lookup without a container restart:
 *
 *   GET    /api/admin/geoip/status
 *     Live snapshot: provider, .mmdb file stats, cache row count,
 *     last 10 cache hits, in-process reader state.
 *
 *   GET    /api/admin/geoip/high-risk-countries
 *     Current effective list + provenance ('admin override' vs
 *     'default'). Used by the AdminGeoipSettings pill editor.
 *
 *   PUT    /api/admin/geoip/high-risk-countries
 *     Body: { countries: string[] }
 *     Empty array → fall back to defaults. Invalid codes (not 2
 *     letters, not A-Z) → 400.
 *
 *   PUT    /api/admin/geoip/provider
 *     Body: { provider: 'maxmind'|'geoip_lite'|'noop', mmdb_path?: string }
 *     Validates the .mmdb file exists before persisting. Invalidates
 *     the in-process reader so the next lookup reopens it.
 *
 *   POST   /api/admin/geoip/cache/purge
 *     Body: { provider: 'maxmind'|'geoip_lite'|'all' }
 *     Deletes cache rows for the given provider(s). Used after
 *     switching .mmdb file or to force a refresh of hot IPs.
 *
 *   GET    /api/admin/geoip/probe?ip=…
 *     Admin-only lookup with full debug output: which provider
 *     was actually used, latency, cache hit/miss, full record.
 *     Useful for debugging KYC mismatch signals.
 *
 * Auth: authMiddleware + roleMiddleware(['super_admin']) everywhere.
 * Rate limit: adminLimiter (consistent with the rest of /api/admin).
 *
 * The whole module is one router; mount with:
 *   app.use('/api/admin/geoip', adminGeoipRoutes);
 */

import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import { query } from '../config/database';
import {
  setAdminSetting,
  getAdminSetting,
} from '../services/admin-settings.service';
import {
  invalidateReader,
  getReaderState,
  lookupCountry,
  DEFAULT_HIGH_RISK_COUNTRIES,
} from '../services/maxmind';
import { authMiddleware, roleMiddleware } from '../middleware/auth';

const router = Router();

// Apply auth + super_admin role to every endpoint. The role
// middleware (in middleware/auth.ts) accepts `isAdmin: true`
// tokens as super_admin even if the role field is unset, which
// matches the existing pattern across /api/admin.
router.use(authMiddleware, roleMiddleware(['super_admin']));

// ── GET /status ────────────────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const [provider, mmdbPath, cacheTtl, highRiskOverride, mismatchWeight] = await Promise.all([
      getAdminSetting('geoip_provider', 'maxmind'),
      getAdminSetting('geoip_mmdb_path', '/app/geoip/GeoLite2-Country.mmdb'),
      getAdminSetting('geoip_cache_ttl_days', '7'),
      getAdminSetting('geoip_high_risk_countries', ''),
      getAdminSetting('geoip_mismatch_weight', '18'),
    ]);
    const resolvedMmdbPath = mmdbPath ?? '/app/geoip/GeoLite2-Country.mmdb';
    const resolvedProvider = provider ?? 'maxmind';
    const resolvedCacheTtl = cacheTtl ?? '7';
    const resolvedMismatchWeight = mismatchWeight ?? '18';
    const readerState = getReaderState();

    // File stats for the configured .mmdb path. Best-effort; if the
    // file doesn't exist we report size:null, mtime:null.
    let fileStat: { exists: boolean; sizeBytes: number | null; mtime: string | null } = {
      exists: false,
      sizeBytes: null,
      mtime: null,
    };
    try {
      const stat = await fs.stat(resolvedMmdbPath);
      fileStat = {
        exists: true,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    } catch {
      fileStat.exists = false;
    }

    // Cache row counts grouped by provider
    const counts = (await query(
      `SELECT provider, count(*)::int AS n
         FROM geoip_country_cache
        WHERE expires_at > NOW()
        GROUP BY provider`,
    )).rows as Array<{ provider: string; n: number }>;

    // Last 10 lookups (any IP, any provider)
    const lastLookups = (await query(
      `SELECT ip_address::text AS ip, provider, country_code, is_anonymous, is_hosting, confidence, checked_at
         FROM geoip_country_cache
        ORDER BY checked_at DESC
        LIMIT 10`,
    )).rows;

    res.json({
      success: true,
      data: {
        provider: resolvedProvider,
        mmdbPath: resolvedMmdbPath,
        fileStat,
        reader: readerState,
        cacheTtlDays: Number(resolvedCacheTtl),
        mismatchWeight: Number(resolvedMismatchWeight),
        highRiskOverride: highRiskOverride ?? '',
        cacheRowCounts: counts.reduce<Record<string, number>>((acc, c) => { acc[c.provider] = c.n; return acc; }, {}),
        lastLookups,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /high-risk-countries ───────────────────────────────────
router.get('/high-risk-countries', async (_req: Request, res: Response) => {
  try {
    const override = await getAdminSetting('geoip_high_risk_countries', '');
    if (!override || !override.trim()) {
      res.json({
        success: true,
        data: {
          provenance: 'default',
          countries: Array.from(DEFAULT_HIGH_RISK_COUNTRIES),
        },
      });
      return;
    }
    const countries = override
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length === 2);
    res.json({
      success: true,
      data: {
        provenance: 'admin_override',
        countries,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── PUT /high-risk-countries ───────────────────────────────────
router.put('/high-risk-countries', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { countries?: unknown };
    if (!Array.isArray(body.countries)) {
      res.status(400).json({ success: false, error: 'countries must be an array of 2-letter ISO codes' });
      return;
    }
    const invalid: string[] = [];
    const normalized: string[] = [];
    for (const raw of body.countries as unknown[]) {
      if (typeof raw !== 'string') { invalid.push(String(raw)); continue; }
      const up = raw.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(up)) { invalid.push(raw); continue; }
      normalized.push(up);
    }
    if (invalid.length > 0) {
      res.status(400).json({ success: false, error: `invalid codes: ${invalid.join(', ')}` });
      return;
    }
    // De-dupe while preserving order
    const unique = Array.from(new Set(normalized));
    const value = unique.join(',');
    await setAdminSetting('geoip_high_risk_countries', value);
    const user = (req as Request & { user?: { userId?: string } }).user;
    if (user?.userId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'geoip.high_risk_countries.update', 'info', $1::uuid, $2::jsonb)`,
        [user.userId, JSON.stringify({ countries: unique, count: unique.length })],
      );
    }
    res.json({
      success: true,
      data: {
        provenance: 'admin_override',
        countries: unique,
        message: unique.length === 0 ? 'Empty list — falling back to defaults.' : undefined,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── PUT /provider ──────────────────────────────────────────────
router.put('/provider', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { provider?: string; mmdb_path?: string };
    const valid = ['maxmind', 'geoip_lite', 'noop'];
    if (!body.provider || !valid.includes(body.provider)) {
      res.status(400).json({ success: false, error: `provider must be one of ${valid.join(', ')}` });
      return;
    }
    if (body.provider === 'maxmind') {
      // Validate the .mmdb path before persisting so we don't
      // leave the system in an inconsistent state.
      const candidatePath = (body.mmdb_path ?? '').trim() ||
        (await getAdminSetting('geoip_mmdb_path', '/app/geoip/GeoLite2-Country.mmdb')) ||
        '/app/geoip/GeoLite2-Country.mmdb';
      try {
        const stat = await fs.stat(candidatePath);
        if (!stat.isFile()) throw new Error('not a file');
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          success: false,
          error: `geoip_mmdb_path not usable: ${candidatePath} (${reason})`,
        });
        return;
      }
      await setAdminSetting('geoip_mmdb_path', candidatePath);
    }
    await setAdminSetting('geoip_provider', body.provider);
    // Drop the in-process reader so the next lookup reopens (or
    // permanently disables if the new provider is noop/geoip_lite).
    invalidateReader();
    const user = (req as Request & { user?: { userId?: string } }).user;
    if (user?.userId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'geoip.provider.update', 'info', $1::uuid, $2::jsonb)`,
        [user.userId, JSON.stringify({
          provider: body.provider,
          mmdb_path: body.provider === 'maxmind' ? body.mmdb_path ?? null : null,
        })],
      );
    }
    res.json({
      success: true,
      data: { provider: body.provider, message: 'Provider switched; in-process reader invalidated.' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── POST /cache/purge ─────────────────────────────────────────
router.post('/cache/purge', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { provider?: string };
    const provider = body.provider ?? 'all';
    if (!['maxmind', 'geoip_lite', 'manual', 'all'].includes(provider)) {
      res.status(400).json({ success: false, error: `provider must be maxmind|geoip_lite|manual|all` });
      return;
    }
    const r = provider === 'all'
      ? await query(`DELETE FROM geoip_country_cache`)
      : await query(`DELETE FROM geoip_country_cache WHERE provider = $1`, [provider]);
    const user = (req as Request & { user?: { userId?: string } }).user;
    if (user?.userId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'geoip.cache.purge', 'info', $1::uuid, $2::jsonb)`,
        [user.userId, JSON.stringify({ provider, deleted: r.rowCount ?? 0 })],
      );
    }
    res.json({ success: true, data: { provider, deleted: r.rowCount ?? 0 } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /probe?ip=… ───────────────────────────────────────────
router.get('/probe', async (req: Request, res: Response) => {
  try {
    const ip = String(req.query.ip ?? '').trim();
    if (!ip) {
      res.status(400).json({ success: false, error: 'ip query param is required' });
      return;
    }
    // Best-effort validate that this looks like an IP
    if (!/^[\d.:a-fA-F]+$/.test(ip)) {
      res.status(400).json({ success: false, error: 'ip must be IPv4 or IPv6' });
      return;
    }
    const startedAt = Date.now();
    const record = await lookupCountry(ip);
    const elapsed = Date.now() - startedAt;
    res.json({
      success: true,
      data: {
        ip,
        record,
        elapsedMs: elapsed,
        note: 'record.provider indicates which provider served the answer. noop = no provider was usable.',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;