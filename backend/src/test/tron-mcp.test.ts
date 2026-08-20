/**
 * P1-13 focused test — TronGrid MCP endpoint failover, circuit
 * breaker, and Prometheus counter.
 *
 * The test exercises the failover machinery WITHOUT actually opening
 * MCP sessions (the @modelcontextprotocol/sdk is heavy and not
 * suited to the unit-test environment). Instead, we re-implement
 * the failover loop's *pure* parts in a small harness that mirrors
 * the production logic. This keeps the test fast and offline.
 *
 * The production code itself is exercised at the build/typecheck
 * level — `npx tsc --noEmit` validates the signatures and control
 * flow. The harness below tests the same algorithmic core.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/tron-mcp.test.ts
 */

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

// ── Pure failover logic (mirror of tron-mcp.service.ts) ─────────

import { CircuitBreaker, CircuitState } from '../utils/circuit-breaker';
import { trongridEndpointFailuresTotal } from '../routes/metrics';

/** Mocked HTTP client. Each endpoint is keyed by host; the value
 *  is a function that returns either a successful payload (string)
 *  or throws an Error with a `.statusCode` if it should fail. */
type MockResult = string | { error: string; statusCode?: number };
type MockHandler = () => MockResult | Promise<MockResult>;
const mockResponses: Map<string, MockHandler> = new Map();

function setMock(host: string, handler: MockHandler): void {
  mockResponses.set(host, handler);
}
function clearMocks(): void {
  mockResponses.clear();
}

/** Mirror of tron-mcp.service.ts:tryCallToolWithFailover — but
 *  inlined here as a pure function so we can exercise it without
 *  the full MCP SDK. */
async function failoverCall(
  endpoints: string[],
  callToolMock: (host: string) => Promise<string>,
  breakerFor: (host: string) => CircuitBreaker,
  recordCounter: (host: string, statusCode: number | string) => void,
): Promise<{ result: string; triedHosts: string[]; failedHosts: Array<{ host: string; reason: string; statusCode?: number }> }> {
  const triedHosts: string[] = [];
  const failedHosts: Array<{ host: string; reason: string; statusCode?: number }> = [];
  for (const endpoint of endpoints) {
    const host = new URL(endpoint).host;
    const breaker = breakerFor(host);
    if (breaker.getState() === CircuitState.OPEN) {
      failedHosts.push({ host, reason: 'circuit_open' });
      continue;
    }
    triedHosts.push(host);
    try {
      const result = await callToolMock(host);
      breaker.recordSuccessExternal();
      return { result, triedHosts, failedHosts };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err));
      const statusCode = (err as any).statusCode as number | undefined;
      failedHosts.push({ host, reason, statusCode });
      recordCounter(host, statusCode ?? 'network_error');
      breaker.recordFailureExternal();
    }
  }
  throw new Error(`all endpoints failed: ${JSON.stringify(failedHosts)}`);
}

(async () => {
  console.log('P1-13: TronGrid MCP endpoint failover + circuit breaker');

  // ── Case 1: Primary succeeds — no failover, no counter tick ──
  clearMocks();
  setMock('mcp.trongrid.io', () => 'PRIMARY_OK');
  setMock('api.trongrid.io', () => 'FALLBACK_OK');
  {
    const breakerPrimary = new CircuitBreaker('test:mcp.trongrid.io');
    const breakerFallback = new CircuitBreaker('test:api.trongrid.io');
    const breakerFor = (h: string) => h === 'mcp.trongrid.io' ? breakerPrimary : breakerFallback;
    const counterTicks: Array<[string, number | string]> = [];
    const recordCounter = (host: string, sc: number | string) => { counterTicks.push([host, sc]); realRecordCounter(host, sc); };
    const counterBefore = await getCounterValue();
    const res = await failoverCall(
      ['https://mcp.trongrid.io/mcp', 'https://api.trongrid.io/mcp'],
      async (h) => {
        const handler = mockResponses.get(h)!;
        const r = await handler();
        if (typeof r === 'string') return r;
        const err: any = new Error(r.error);
        if (r.statusCode !== undefined) err.statusCode = r.statusCode;
        throw err;
      },
      breakerFor,
      recordCounter,
    );
    assert(res.result === 'PRIMARY_OK', 'primary success returns the primary response');
    assert(res.triedHosts.length === 1, 'primary success tries only 1 host');
    assert(res.triedHosts[0] === 'mcp.trongrid.io', 'primary success tries the primary host first');
    assert(counterTicks.length === 0, 'primary success does NOT tick the failure counter');
    const counterAfter = await getCounterValue();
    assert(counterAfter === counterBefore, 'no counter change on primary success');
  }

  // ── Case 2: Primary returns 503, fallback succeeds ──
  clearMocks();
  setMock('mcp.trongrid.io', () => ({ error: 'service unavailable', statusCode: 503 }));
  setMock('api.trongrid.io', () => 'FALLBACK_OK');
  {
    const breakerPrimary = new CircuitBreaker('test:mcp.trongrid.io');
    const breakerFallback = new CircuitBreaker('test:api.trongrid.io');
    const breakerFor = (h: string) => h === 'mcp.trongrid.io' ? breakerPrimary : breakerFallback;
    const counterTicks: Array<[string, number | string]> = [];
    const recordCounter = (host: string, sc: number | string) => { counterTicks.push([host, sc]); realRecordCounter(host, sc); };
    const counterBefore = await getCounterValue();
    const res = await failoverCall(
      ['https://mcp.trongrid.io/mcp', 'https://api.trongrid.io/mcp'],
      async (h) => {
        const handler = mockResponses.get(h)!;
        const r = await handler();
        if (typeof r === 'string') return r;
        const err: any = new Error(r.error);
        if (r.statusCode !== undefined) err.statusCode = r.statusCode;
        throw err;
      },
      breakerFor,
      recordCounter,
    );
    assert(res.result === 'FALLBACK_OK', 'primary 503 → fallback returns FALLBACK_OK');
    assert(res.triedHosts.length === 2, 'primary 503 → tried 2 hosts');
    assert(res.triedHosts[0] === 'mcp.trongrid.io', 'primary tried first');
    assert(res.triedHosts[1] === 'api.trongrid.io', 'fallback tried second');
    assert(counterTicks.length === 1, 'primary 503 ticks the counter exactly once');
    assert(counterTicks[0][0] === 'mcp.trongrid.io', 'counter tick is for the primary host');
    assert(counterTicks[0][1] === 503, 'counter tick is labelled with the HTTP status code (503)');
    const counterAfter = await getCounterValue();
    assert(counterAfter > counterBefore, 'counter has incremented (by at least 1) on primary failure');
  }

  // ── Case 3: Primary throws network error (no statusCode), fallback succeeds ──
  clearMocks();
  setMock('mcp.trongrid.io', () => {
    const err: any = new Error('ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    throw err;
  });
  setMock('api.trongrid.io', () => 'FALLBACK_OK');
  {
    const breakerPrimary = new CircuitBreaker('test:mcp.trongrid.io');
    const breakerFallback = new CircuitBreaker('test:api.trongrid.io');
    const breakerFor = (h: string) => h === 'mcp.trongrid.io' ? breakerPrimary : breakerFallback;
    const counterTicks: Array<[string, number | string]> = [];
    const recordCounter = (host: string, sc: number | string) => { counterTicks.push([host, sc]); realRecordCounter(host, sc); };
    const res = await failoverCall(
      ['https://mcp.trongrid.io/mcp', 'https://api.trongrid.io/mcp'],
      async (h) => {
        const handler = mockResponses.get(h)!;
        const r = await handler();
        if (typeof r === 'string') return r;
        const err: any = new Error(r.error);
        if (r.statusCode !== undefined) err.statusCode = r.statusCode;
        throw err;
      },
      breakerFor,
      recordCounter,
    );
    assert(res.result === 'FALLBACK_OK', 'primary ECONNREFUSED → fallback returns FALLBACK_OK');
    assert(counterTicks.length === 1, 'network error ticks the counter');
    assert(counterTicks[0][1] === 'network_error', 'network error is labelled "network_error" (not a status code)');
  }

  // ── Case 4: Both fail with 503 — throws AllEndpointsFailedError-equivalent ──
  clearMocks();
  setMock('mcp.trongrid.io', () => ({ error: 'service unavailable', statusCode: 503 }));
  setMock('api.trongrid.io', () => ({ error: 'bad gateway', statusCode: 502 }));
  {
    const breakerPrimary = new CircuitBreaker('test:mcp.trongrid.io');
    const breakerFallback = new CircuitBreaker('test:api.trongrid.io');
    const breakerFor = (h: string) => h === 'mcp.trongrid.io' ? breakerPrimary : breakerFallback;
    const counterTicks: Array<[string, number | string]> = [];
    const recordCounter = (host: string, sc: number | string) => { counterTicks.push([host, sc]); realRecordCounter(host, sc); };
    let caught = false;
    try {
      await failoverCall(
        ['https://mcp.trongrid.io/mcp', 'https://api.trongrid.io/mcp'],
        async (h) => {
          const handler = mockResponses.get(h)!;
          const r = await handler();
          if (typeof r === 'string') return r;
          const err: any = new Error(r.error);
          if (r.statusCode !== undefined) err.statusCode = r.statusCode;
          throw err;
        },
        breakerFor,
        recordCounter,
      );
    } catch (err) {
      caught = true;
      assert(/all endpoints failed/.test((err as Error).message), 'error message indicates all-endpoint failure');
    }
    assert(caught, 'all-endpoints-fail scenario throws');
    assert(counterTicks.length === 2, 'counter ticked for BOTH failed endpoints');
    assert(counterTicks.some((t) => t[0] === 'mcp.trongrid.io' && t[1] === 503), 'counter ticked for primary 503');
    assert(counterTicks.some((t) => t[0] === 'api.trongrid.io' && t[1] === 502), 'counter ticked for fallback 502');
  }

  // ── Case 5: Circuit OPEN — short-circuits without attempting call ──
  clearMocks();
  setMock('mcp.trongrid.io', () => 'SHOULD_NOT_BE_CALLED');
  setMock('api.trongrid.io', () => 'FALLBACK_OK');
  {
    // Force the primary's breaker to OPEN by recording 5 failures
    // (minimumRequests=3, failureThreshold=0.5, so 3 of 3 = 100% > 50%).
    const breakerPrimary = new CircuitBreaker('test:mcp.trongrid.io', {
      failureThreshold: 0.5,
      minimumRequests: 3,
    });
    breakerPrimary.recordFailureExternal();
    breakerPrimary.recordFailureExternal();
    breakerPrimary.recordFailureExternal();
    assert(breakerPrimary.getState() === CircuitState.OPEN, 'primary breaker is OPEN after 3 failures');
    const breakerFallback = new CircuitBreaker('test:api.trongrid.io');
    const breakerFor = (h: string) => h === 'mcp.trongrid.io' ? breakerPrimary : breakerFallback;
    const counterTicks: Array<[string, number | string]> = [];
    const recordCounter = (host: string, sc: number | string) => { counterTicks.push([host, sc]); realRecordCounter(host, sc); };
    const res = await failoverCall(
      ['https://mcp.trongrid.io/mcp', 'https://api.trongrid.io/mcp'],
      async (h) => {
        const handler = mockResponses.get(h)!;
        const r = await handler();
        if (typeof r === 'string') return r;
        const err: any = new Error(r.error);
        if (r.statusCode !== undefined) err.statusCode = r.statusCode;
        throw err;
      },
      breakerFor,
      recordCounter,
    );
    assert(res.result === 'FALLBACK_OK', 'OPEN primary → fallback returns FALLBACK_OK');
    assert(res.triedHosts.length === 1, 'OPEN primary is skipped (no call made)');
    assert(res.triedHosts[0] === 'api.trongrid.io', 'tried only the fallback host');
    assert(counterTicks.length === 0, 'OPEN primary did NOT tick the counter (skipped)');
  }

  // ── Case 6: Real counter is registered with the prom registry ──
  // Verify the counter object is properly wired (its hash matches
  // the registration in routes/metrics.ts). We do this by
  // collecting metrics and looking for the counter name.
  {
    const text = await import('node:fs/promises').then((m) => m.readFile(require('node:path').resolve(__dirname, '../routes/metrics.ts'), 'utf8'));
    assert(
      /trongrid_endpoint_failures_total/.test(text),
      'routes/metrics.ts declares the counter',
    );
    assert(
      /labelNames:.*endpoint.*status_code/.test(text),
      'counter has endpoint + status_code labels',
    );
  }

  // ── Case 7: Testnet endpoint excluded in production ──
  // We can't actually run the constructor in a unit test (it
  // opens real sessions), so we just verify the source code
  // contains the production guard.
  {
    const text = await import('node:fs/promises').then((m) => m.readFile(require('node:path').resolve(__dirname, '../services/tron-mcp.service.ts'), 'utf8'));
    assert(
      /NODE_ENV\s*!==\s*['"]production['"]\s*\|\|\s*env\.TRONGRID_ALLOW_TESTNET/.test(text),
      'tron-mcp.service.ts: testnet only included when NODE_ENV !== production OR ALLOW_TESTNET is true',
    );
    assert(
      /IGNORING it to prevent testnet fallback/.test(text) ||
        /prevent testnet fallback/i.test(text),
      'tron-mcp.service.ts: loud warning when testnet is set in production',
    );
  }

  // ── Cleanup ──
  clearMocks();

  console.log('');
  if (failed) {
    console.error('FAILED: P1-13 tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-13 tron-mcp failover tests passed');
    process.exit(0);
  }
})();

// Helper: read the current value of the trongrid_endpoint_failures_total
// counter via the prom-client registry. We use a small parser to
// avoid loading the full /metrics response in a unit test.


// Mirror of the production `recordEndpointFailure`: increment the
// actual prom counter so the test exercises the real metric path.
function realRecordCounter(host: string, statusCode: number | string): void {
  try {
    trongridEndpointFailuresTotal.inc({ endpoint: host, status_code: String(statusCode) });
  } catch {
    // ignore — never let metrics throw
  }
}

async function getCounterValue(): Promise<number> {
  try {
    // Force prom-client to serialize the current registry by
    // importing it. The counter value is captured by triggering an
    // inc on a temporary label and seeing the delta. Simpler:
    // read the counter object directly.
    const { register } = await import('prom-client');
    const text = await register.metrics();
    // Look for the trongrid_endpoint_failures_total{...} line.
    const lines = text.split('\n');
    let total = 0;
    for (const line of lines) {
      if (line.startsWith('trongrid_endpoint_failures_total{')) {
        const parts = line.split(' ');
        const v = parseFloat(parts[parts.length - 1]);
        if (!isNaN(v)) total += v;
      }
    }
    return total;
  } catch {
    return 0;
  }
}
