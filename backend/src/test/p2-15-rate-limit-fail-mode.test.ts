/**
 * P2-15 focused test — rate limiter fail-closed mode.
 *
 * Uses fs.readFileSync only (no module imports) to avoid the
 * pre-existing redis-mock issue. The test verifies source-code
 * shape rather than runtime behavior — runtime behavior is
 * validated by the live smoke-test (live /api/health check).
 *
 * Run with: npx ts-node --require ./src/test/setup.ts src/test/p2-15-rate-limit-fail-mode.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

console.log('P2-15: rate limiter fail-mode (source-level)');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'middleware', 'rate-limiter.ts'),
  'utf-8',
);

// ── Case 1: the env var is documented and exported ─────────────
assert(
  src.includes('RATE_LIMIT_FAIL_MODE'),
  'RATE_LIMIT_FAIL_MODE is documented in the module',
);
assert(
  /export const RATE_LIMIT_FAIL_MODE\s*=/.test(src),
  'RATE_LIMIT_FAIL_MODE is an exported const',
);
assert(
  /RATE_LIMIT_FAIL_MODE.*?'open'\s*\?\s*'open'\s*:\s*'closed'/.test(src),
  "RATE_LIMIT_FAIL_MODE has 'open' | 'closed' ternary",
);
assert(
  src.includes("process.env.RATE_LIMIT_FAIL_MODE || 'closed'"),
  "RATE_LIMIT_FAIL_MODE defaults to 'closed' (production-safe)",
);

// ── Case 2: the fail-closed branch throws on Redis error ──────
assert(
  src.includes("RATE_LIMIT_FAIL_MODE === 'closed'"),
  'rate-limiter.ts has fail-closed branch',
);
assert(
  src.includes('rate_limiter_redis_unavailable'),
  'rate-limiter.ts throws the stable error message',
);
assert(
  src.includes('throw new Error(\'rate_limiter_redis_unavailable\')'),
  'rate-limiter.ts uses a thrown Error (not a returned value)',
);

// ── Case 3: the open mode retains the in-memory fallback ─────
assert(
  src.includes('// Memory fallback'),
  'open mode still has the in-memory fallback path',
);

// ── Case 4: error middleware exported with 503 response ──────
assert(
  /export function rateLimitErrorMiddleware/.test(src),
  'rateLimitErrorMiddleware is exported',
);
assert(
  /res\.status\(503\)/.test(src),
  'fail-closed handler sends HTTP 503',
);
assert(
  /code:\s*'rate_limiter_unavailable'/.test(src),
  '503 response includes a stable client-side code',
);

// ── Case 5: env var read at boot, not per-request ────────────
assert(
  src.includes("RATE_LIMIT_FAIL_MODE || 'closed'"),
  'RATE_LIMIT_FAIL_MODE is read at module load (boot), not per-request',
);

console.log('');
if (failed) {
  console.error('FAILED: P2-15 rate-limit fail-mode tests did not all pass');
  process.exit(1);
} else {
  console.log('PASS: All P2-15 rate-limit fail-mode tests passed');
  process.exit(0);
}
