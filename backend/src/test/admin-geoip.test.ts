/**
 * P3-4b tests — Admin GeoIP endpoints.
 *
 * Run standalone:
 *   npx ts-node --require ./setup.ts admin-geoip.test.ts
 *
 * Approach: build a fresh Express app, mount the admin-geoip
 * router, send real HS256 JWTs in Authorization headers. The
 * router's authMiddleware verifies the token; roleMiddleware
 * enforces super_admin.
 */

import {
  GET_STATUS_CALLED,
  PUT_HRC_CALLED,
  PUT_PROVIDER_CALLED,
  PURGE_CALLED,
  PROBE_CALLED,
  resetCounters,
} from './helpers/admin-geoip-trace';
import express from 'express';
import adminGeoipRoutes from '../routes/admin-geoip';
import jwt from 'jsonwebtoken';

let failed = false;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`  ✅ ${label}`);
  else { console.error(`  ❌ ${label}`); failed = true; }
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ✅ ${label} (got ${JSON.stringify(actual)})`);
  } else {
    console.error(`  ❌ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed = true;
  }
}
function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// Mint a JWT for the requested role using JWT_SECRET from .env.
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_that_is_at_least_32_characters_long';
function mintToken(role: 'super_admin' | 'support' | 'finance' | 'auditor' | null): string {
  if (role === null) return '';
  const isAdmin = role === 'super_admin' || role === 'support' || role === 'finance';
  return jwt.sign({
    userId: '00000000-0000-0000-0000-000000000001',
    username: `test-${role}`,
    isAdmin,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, JWT_SECRET, { algorithm: 'HS256' });
}

// Install a query mock that counts by SQL prefix.
const baseMock = (global as unknown as { __TEST_MOCK_QUERY__?: (t: string, p: unknown[]) => unknown })
  .__TEST_MOCK_QUERY__;
(global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
  (text: string, params: unknown[]) => {
    const upper = text.toUpperCase();
    if (upper.startsWith('SELECT VALUE FROM ADMIN_SETTINGS')) {
      const key = String(params[0] ?? '');
      if (key === 'geoip_provider') GET_STATUS_CALLED.count++;
      if (key === 'geoip_high_risk_countries') GET_STATUS_CALLED.count++;
    }
    if (upper.startsWith('INSERT INTO ADMIN_SETTINGS')) {
      const key = String(params[0] ?? '');
      if (key === 'geoip_high_risk_countries') PUT_HRC_CALLED.count++;
      if (key === 'geoip_provider' || key === 'geoip_mmdb_path') PUT_PROVIDER_CALLED.count++;
    }
    if (upper.startsWith('DELETE FROM GEOIP_COUNTRY_CACHE')) PURGE_CALLED.count++;
    return baseMock
      ? baseMock(text, params)
      : { rows: [], rowCount: 0 };
  };

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/geoip', adminGeoipRoutes);
  return app;
}

interface TestResponse {
  status: number;
  body: any;
}
async function fetchWithRole(
  path: string,
  role: 'super_admin' | 'support' | 'finance' | 'auditor' | null,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<TestResponse> {
  const app = buildApp();
  const fullPath = path.startsWith('/api/admin/geoip') ? path : `/api/admin/geoip${path}`;
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers ?? {}),
  };
  if (role !== null) {
    headers['Authorization'] = `Bearer ${mintToken(role)}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}${fullPath}`, { ...init, headers });
  const text = await res.text();
  server.close();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* leave body null */ }
  return { status: res.status, body };
}

async function runTests(): Promise<void> {
  console.log('🧪 P3-4b Admin GeoIP Routes Tests');

  // ── 1. Auth + role gating ────────────────────────────────────
  section('Auth + role gating');
  {
    const r = await fetchWithRole('/status', null);
    assertEq(r.status, 401, 'no auth → 401');
  }
  {
    const r = await fetchWithRole('/status', 'support');
    assertEq(r.status, 403, 'non-super_admin (support) → 403');
  }
  {
    const r = await fetchWithRole('/status', 'finance');
    assertEq(r.status, 403, 'non-super_admin (finance) → 403');
  }

  // ── 2. GET /status ───────────────────────────────────────────
  section('GET /api/admin/geoip/status');
  resetCounters();
  {
    const r = await fetchWithRole('/status', 'super_admin');
    assertEq(r.status, 200, 'GET /status → 200');
    assertEq(r.body?.success, true, 'GET /status → success=true');
    assert(typeof r.body.data.provider === 'string', 'GET /status → has provider string');
    assert(typeof r.body.data.fileStat === 'object', 'GET /status → has fileStat object');
    assert(typeof r.body.data.cacheRowCounts === 'object', 'GET /status → has cacheRowCounts');
    assert(GET_STATUS_CALLED.count >= 1, `GET /status called admin_settings reads (got ${GET_STATUS_CALLED.count})`);
  }

  // ── 3. GET /high-risk-countries ──────────────────────────────
  section('GET /api/admin/geoip/high-risk-countries');
  resetCounters();
  {
    const r = await fetchWithRole('/high-risk-countries', 'super_admin');
    assertEq(r.status, 200, 'GET /high-risk-countries → 200');
    assertEq(r.body?.success, true, 'GET → success=true');
    assert(
      r.body.data.provenance === 'default' || r.body.data.provenance === 'admin_override',
      `provenance is default|admin_override (got ${r.body.data.provenance})`,
    );
    assert(Array.isArray(r.body.data.countries), 'countries is array');
    if (r.body.data.provenance === 'default') {
      assert(r.body.data.countries.includes('KP'), 'default list contains KP');
      assert(r.body.data.countries.includes('IR'), 'default list contains IR');
    }
  }

  // ── 4. PUT /high-risk-countries ──────────────────────────────
  section('PUT /api/admin/geoip/high-risk-countries');
  resetCounters();
  {
    const r = await fetchWithRole('/high-risk-countries', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ countries: ['KP', 'ABC', 'XX'] }),
    });
    assertEq(r.status, 400, 'PUT with invalid code → 400');
    assert(typeof r.body.error === 'string' && r.body.error.includes('ABC'), 'error message names invalid code');
  }
  {
    const r = await fetchWithRole('/high-risk-countries', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ countries: [] }),
    });
    assertEq(r.status, 200, 'PUT with empty list → 200');
    assertEq(r.body.data.provenance, 'admin_override', 'PUT empty → provenance=admin_override (CSV is "")');
  }
  {
    const r = await fetchWithRole('/high-risk-countries', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ countries: ['kp', 'ir', 'sy'] }),
    });
    assertEq(r.status, 200, 'PUT with valid codes → 200');
    assertEq(r.body.data.provenance, 'admin_override', 'PUT valid → provenance=admin_override');
    assertEq(r.body.data.countries.join(','), 'KP,IR,SY', 'codes normalised to uppercase + deduped');
    assert(PUT_HRC_CALLED.count >= 1, `setAdminSetting called at least once (got ${PUT_HRC_CALLED.count})`);
  }

  // ── 5. PUT /provider ─────────────────────────────────────────
  section('PUT /api/admin/geoip/provider');
  resetCounters();
  {
    const r = await fetchWithRole('/provider', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'invalid' }),
    });
    assertEq(r.status, 400, 'PUT with invalid provider → 400');
  }
  {
    const r = await fetchWithRole('/provider', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'maxmind', mmdb_path: '/nonexistent/path.mmdb' }),
    });
    assertEq(r.status, 400, 'PUT maxmind with bad path → 400');
    assert(typeof r.body.error === 'string' && r.body.error.includes('not usable'), 'error mentions not usable');
  }
  {
    const r = await fetchWithRole('/provider', 'super_admin', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'noop' }),
    });
    assertEq(r.status, 200, 'PUT noop → 200');
    assertEq(r.body.data.provider, 'noop', 'PUT noop → response.provider=noop');
    assert(PUT_PROVIDER_CALLED.count >= 1, `setAdminSetting called (got ${PUT_PROVIDER_CALLED.count})`);
  }

  // ── 6. POST /cache/purge ─────────────────────────────────────
  section('POST /api/admin/geoip/cache/purge');
  resetCounters();
  {
    const r = await fetchWithRole('/cache/purge', 'super_admin', {
      method: 'POST',
      body: JSON.stringify({ provider: 'maxmind' }),
    });
    assertEq(r.status, 200, 'POST /cache/purge → 200');
    assert(PURGE_CALLED.count >= 1, `cache DELETE called (got ${PURGE_CALLED.count})`);
  }
  {
    const r = await fetchWithRole('/cache/purge', 'super_admin', {
      method: 'POST',
      body: JSON.stringify({ provider: 'bogus' }),
    });
    assertEq(r.status, 400, 'POST /cache/purge with bogus provider → 400');
  }

  // ── 7. GET /probe ────────────────────────────────────────────
  section('GET /api/admin/geoip/probe');
  resetCounters();
  {
    const r = await fetchWithRole('/probe?ip=8.8.8.8', 'super_admin');
    assertEq(r.status, 200, 'GET /probe?ip=8.8.8.8 → 200');
    assertEq(r.body?.success, true, 'probe success=true');
    assertEq(r.body.data.ip, '8.8.8.8', 'probe echoes the input IP');
    assert(typeof r.body.data.record === 'object', 'probe returns record object');
    assert(typeof r.body.data.elapsedMs === 'number', 'probe elapsedMs is a number');
    PROBE_CALLED.count++;
    assert(PROBE_CALLED.count >= 1, `probe ran (got ${PROBE_CALLED.count})`);
  }
  {
    const r = await fetchWithRole('/probe', 'super_admin');
    assertEq(r.status, 400, 'GET /probe without ip → 400');
  }

  console.log('\n' + '='.repeat(48));
  if (failed) {
    console.error('❌ admin-geoip.test.ts: FAILED');
    process.exit(1);
  } else {
    console.log('✅ admin-geoip.test.ts: ALL PASSED');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});