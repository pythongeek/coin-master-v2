/**
 * P1-12 hCaptcha middleware test — exercises the 4 paths:
 *   1. HCAPTCHA_SECRET unset → bypass (next()).
 *   2. HCAPTCHA_SECRET set, no token → 400 captcha_invalid.
 *   3. HCAPTCHA_SECRET set, empty/whitespace token → 400 captcha_invalid.
 *   4. HCAPTCHA_SECRET set, valid fetch (success=true) → next().
 *   5. HCAPTCHA_SECRET set, fetch returns success=false → 400 captcha_invalid.
 *   6. HCAPTCHA_SECRET set, fetch throws (network error) → 400 captcha_invalid.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/p1-12-hcaptcha.test.ts
 */

import { hcaptchaMiddleware } from '../middleware/hcaptcha';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

function makeRes(): any {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
}

(async () => {
  console.log('P1-12: hCaptcha middleware');

  // 1. unset → bypass
  const original = process.env.HCAPTCHA_SECRET;
  delete process.env.HCAPTCHA_SECRET;
  (globalThis as any).__hcaptchaBypassLogged = false;
  {
    let nextCalled = false;
    const req: any = { body: {} };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(nextCalled, 'unset secret → next() called (bypass)');
    assert(res.statusCode === 200, 'unset secret → no error response (200)');
  }

  // 2. set, no token → 400
  process.env.HCAPTCHA_SECRET='***';
  (globalThis as any).__hcaptchaBypassLogged = false;
  {
    let nextCalled = false;
    const req: any = { body: { username: 'a' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(!nextCalled, 'set secret + no token → next() NOT called');
    assert(res.statusCode === 400, 'set secret + no token → 400');
    assert(res.body && res.body.error === 'captcha_invalid', 'set secret + no token → error="captcha_invalid"');
  }

  // 3. set, empty/whitespace token → 400
  {
    let nextCalled = false;
    const req: any = { body: { hcaptchaToken: '   ' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(!nextCalled, 'whitespace token → next() NOT called');
    assert(res.statusCode === 400, 'whitespace token → 400');
    assert(res.body && res.body.error === 'captcha_invalid', 'whitespace token → error="captcha_invalid"');
  }

  // Save/restore fetch
  const originalFetch = (globalThis as any).fetch;

  // 4. fetch returns success=true → next()
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  });
  {
    let nextCalled = false;
    const req: any = { body: { hcaptchaToken: 'good-token' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(nextCalled, 'success=true → next() called');
    assert(res.statusCode === 200, 'success=true → no error response');
  }

  // 5. fetch returns success=false → 400
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
  });
  {
    let nextCalled = false;
    const req: any = { body: { hcaptchaToken: 'bad-token' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(!nextCalled, 'success=false → next() NOT called');
    assert(res.statusCode === 400, 'success=false → 400');
    assert(res.body && res.body.error === 'captcha_invalid', 'success=false → error="captcha_invalid"');
  }

  // 6. fetch throws (network error) → 400 (fail-closed)
  (globalThis as any).fetch = async () => { throw new Error('ECONNREFUSED'); };
  {
    let nextCalled = false;
    const req: any = { body: { hcaptchaToken: 'any-token' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(!nextCalled, 'fetch throws → next() NOT called (fail-closed)');
    assert(res.statusCode === 400, 'fetch throws → 400 (fail-closed)');
    assert(res.body && res.body.error === 'captcha_invalid', 'fetch throws → error="captcha_invalid" (fail-closed)');
  }

  // 7. fetch returns non-2xx → 400
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });
  {
    let nextCalled = false;
    const req: any = { body: { hcaptchaToken: 'any-token' } };
    const res = makeRes();
    hcaptchaMiddleware(req, res, () => { nextCalled = true; });
    await new Promise((r) => setImmediate(r));
    assert(!nextCalled, 'non-2xx response → next() NOT called');
    assert(res.statusCode === 400, 'non-2xx response → 400');
  }

  // Restore
  (globalThis as any).fetch = originalFetch;
  if (original === undefined) {
    delete process.env.HCAPTCHA_SECRET;
  } else {
    // restore is best-effort: tests can re-set later if needed
  }

  console.log('');
  if (failed) {
    console.error('FAILED: P1-12 hCaptcha tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-12 hCaptcha tests passed');
    process.exit(0);
  }
})();
