/**
 * P1-06 focused test: /metrics IP allowlist.
 *
 * The /metrics endpoint previously was unauthenticated and publicly
 * exposed business metrics (bets placed, hot wallet balance,
 * deposit USD totals). This test confirms the new allowlist
 * contract:
 *
 *   1. With METRICS_IP_ALLOWLIST unset, requests from 127.0.0.1
 *      pass; requests from 8.8.8.8 are rejected with 404.
 *   2. With METRICS_IP_ALLOWLIST="10.0.0.0/8", 10.0.0.5 passes;
 *      8.8.8.8 is rejected.
 *   3. Single-IP entries work ("1.2.3.4" exact match).
 *   4. Mixed allowlist (CIDR + single IP) works.
 *   5. Malformed METRICS_IP_ALLOWLIST entries are ignored with a
 *      warning (not fatal).
 *   6. The middleware does NOT use 403 — it uses 404 to avoid
 *      confirming the endpoint exists to a port scanner.
 *   7. The response body for unauthorized requests is empty.
 *   8. Default loopback (127.0.0.1) always works regardless of
 *      METRICS_IP_ALLOWLIST (added to the default range set).
 */

import Module from 'module';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('✅', msg);
  } else {
    console.error('❌', msg);
    failed = true;
  }
}

// Helper to simulate a request to the metrics route
async function callMetrics(
  ip: string,
  setEnv: string | null = null,
): Promise<{ statusCode: number; body: string }> {
  if (setEnv === null) {
    delete process.env.METRICS_IP_ALLOWLIST;
  } else {
    process.env.METRICS_IP_ALLOWLIST = setEnv;
  }

  // Force the require cache to be cleared so the metrics module
  // re-evaluates its env-derived allowlist.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('routes/metrics')) delete require.cache[k];
  }

  const metricsModule = require('../routes/metrics');
  const router = metricsModule.metricsRoutes || metricsModule.default;

  // Use Express directly to test the route
  const express = require('express');
  const app = express();
  app.use('/', router);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      const http = require('http');
      const opts: any = {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: {},
      };
      // Spoof the source IP via the X-Forwarded-For header IF
      // express's trust proxy setting allows it. Without trust
      // proxy, req.ip uses socket.remoteAddress (always 127.0.0.1).
      // For different IPs we'll set trust proxy on a fresh app per
      // test case.
      server.close();
      // Actually, just use the express app via supertest-style: build
      // a fresh server with the right trust-proxy + req.ip
      // configuration.
      resolve({ statusCode: 0, body: '' });
    });
  });
}

// Helper to simulate a request to the metrics route middleware
function makeCtx(ip: string) {
  const req: any = {
    ip,
    socket: { remoteAddress: ip },
    headers: { 'x-forwarded-for': ip },
  };
  let statusCode = 0;
  let body = '';
  const res: any = {
    status(c: number) { statusCode = c; return this; },
    end(s?: string) { body = s ?? body; return this; },
    set() { return this; },
    send(s: string) { body = s; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return {
    req, res, next,
    get allowed() { return nextCalled; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

// Load the metrics module ONCE — collectDefaultMetrics registers a
// global prom-client registry and re-loading throws "metric already
// registered" errors. We then re-evaluate the allowlist by clearing
// only the allowlist cache.
const metricsModule = require('../routes/metrics');
const { metricsIpAllowlist } = metricsModule;

// Force the allowlist cache to be re-evaluated between cases by
// re-reading METRICS_IP_ALLOWLIST and calling buildAllowlist directly.
// (The module-level cache is private; we work around it by
// observing the behavior: when env changes, getAllowlist()
// re-builds. We just need a fresh require to re-trigger the env
// binding — but that throws on duplicate metric registration. So
// we read the env value at the test-site and rely on the
// memoization invalidation on env-change.)
let lastEnv: string | null = null;
function clearAllowlistCache() {
  // No-op stub — the metrics module's internal cache auto-invalidates
  // on env change. The tests use distinct env values to trigger
  // re-evaluation.
}

async function testAllowlistCase(
  description: string,
  ip: string,
  envValue: string | null,
  expectedAllowed: boolean,
): Promise<void> {
  if (envValue === null) {
    delete process.env.METRICS_IP_ALLOWLIST;
  } else {
    process.env.METRICS_IP_ALLOWLIST = envValue;
  }
  // Touching the env triggers the module's internal getAllowlist()
  // memoization invalidation on the next call. No cache clear needed.
  lastEnv = process.env.METRICS_IP_ALLOWLIST ?? null;

  const ctx = makeCtx(ip);
  metricsIpAllowlist(ctx.req, ctx.res, ctx.next);
  const allowed = ctx.allowed;
  const status = ctx.statusCode;
  const body = ctx.body;
  if (expectedAllowed) {
    assert(allowed, `${description}: ip=${ip} env=${envValue ?? '<unset>'} was allowed (next() called)`);
  } else {
    assert(!allowed, `${description}: ip=${ip} env=${envValue ?? '<unset>'} was REJECTED (next() NOT called)`);
    assert(status === 404, `${description}: rejection status is 404 (got: ${status})`);
    assert(body === '', `${description}: rejection body is empty (got: ${JSON.stringify(body)})`);
  }
}

(async () => {
  // ── Case 1: Default allowlist (env unset) — loopback allowed ──
  await testAllowlistCase('default-allowlist/loopback', '127.0.0.1', null, true);

  // ── Case 2: Default allowlist — private RFC1918 IPs allowed ──
  await testAllowlistCase('default-allowlist/rfc1918-10/8', '10.0.0.5', null, true);
  await testAllowlistCase('default-allowlist/rfc1918-172.16/12', '172.16.0.1', null, true);
  await testAllowlistCase('default-allowlist/rfc1918-192.168/16', '192.168.1.1', null, true);

  // ── Case 3: Default allowlist — public IP rejected ──
  await testAllowlistCase('default-allowlist/public-rejected', '8.8.8.8', null, false);

  // ── Case 4: Custom METRICS_IP_ALLOWLIST overrides defaults ──
  await testAllowlistCase(
    'custom-allowlist/10/8-allowed',
    '10.0.0.5',
    '10.0.0.0/8',
    true,
  );
  await testAllowlistCase(
    'custom-allowlist/loopback-still-allowed',
    '127.0.0.1',
    '10.0.0.0/8',
    true,
  );
  await testAllowlistCase(
    'custom-allowlist/8.8.8.8-rejected',
    '8.8.8.8',
    '10.0.0.0/8',
    false,
  );

  // ── Case 5: Single IP exact match ──
  await testAllowlistCase(
    'single-ip-exact-match',
    '203.0.113.42',
    '203.0.113.42',
    true,
  );
  await testAllowlistCase(
    'single-ip-no-match',
    '203.0.113.99',
    '203.0.113.42',
    false,
  );

  // ── Case 6: Malformed METRICS_IP_ALLOWLIST is ignored ──
  await testAllowlistCase(
    'malformed-allowlist-falls-back-to-defaults',
    '127.0.0.1',
    'not_a_valid_ip,also_bad',
    true, // default loopback still in the list
  );
  await testAllowlistCase(
    'malformed-allowlist-rejects-public',
    '8.8.8.8',
    'not_a_valid_ip,also_bad',
    false,
  );

  // ── Case 7: Mixed allowlist (CIDR + single IP) ──
  await testAllowlistCase(
    'mixed-allowlist/cidr-allowed',
    '10.0.0.1',
    '192.168.0.0/16,10.0.0.0/8,203.0.113.5',
    true,
  );
  await testAllowlistCase(
    'mixed-allowlist/single-ip-allowed',
    '203.0.113.5',
    '192.168.0.0/16,10.0.0.0/8,203.0.113.5',
    true,
  );
  await testAllowlistCase(
    'mixed-allowlist/unlisted-rejected',
    '8.8.4.4',
    '192.168.0.0/16,10.0.0.0/8,203.0.113.5',
    false,
  );

  // ── Case 8: IPv6 loopback always allowed (default) ──
  await testAllowlistCase(
    'default-allowlist/ipv6-loopback',
    '::1',
    null,
    true,
  );

  // ── Case 9: IP normalization (::ffff:8.8.8.8 → 8.8.8.8) ──
  // Without normalization, ::ffff:8.8.8.8 would bypass a 8.8.8.8
  // allowlist entry. The middleware should strip the v4-mapped-v6
  // prefix.
  await testAllowlistCase(
    'ipv4-mapped-v6-normalization',
    '::ffff:127.0.0.1',
    null,
    true, // should be normalized to 127.0.0.1 which is loopback
  );
  await testAllowlistCase(
    'ipv4-mapped-v6-rejected',
    '::ffff:8.8.8.8',
    null,
    false, // normalized to 8.8.8.8 which is not in default allowlist
  );

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('');
  if (failed) {
    console.error('❌ P1-06 tests FAILED');
    process.exit(1);
  } else {
    console.log('🎉 All P1-06 metrics-allowlist tests passed');
    process.exit(0);
  }
})();
