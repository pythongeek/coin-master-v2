/**
 * P1-12 registerStrictLimiter — static source check.
 *
 * The registerStrictLimiter is a runtime instance of express-rate-limit
 * backed by RedisStore. Loading it triggers a `redis.connect()` at
 * module-load which the test environment cannot mock (the redis
 * dependency is an ESM `import` rather than a `require`). This test
 * therefore verifies the middleware configuration statically by
 * reading the source file and asserting the expected parameters.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/p1-12-register-strict-limiter.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

(async () => {
  console.log('P1-12: registerStrictLimiter static configuration check');

  const src = readFileSync(
    path.resolve(__dirname, '..', 'middleware', 'rate-limiter.ts'),
    'utf8',
  );

  // 1. registerStrictLimiter is exported
  assert(
    /export const registerStrictLimiter\s*:\s*RequestHandler/.test(src),
    'registerStrictLimiter is exported as RequestHandler',
  );

  // 2. windowMs is 1 minute
  const strictBlock = src.match(/registerStrictLimiter[\s\S]*?\}\);/);
  assert(strictBlock !== null, 'registerStrictLimiter block extractable');
  if (strictBlock) {
    const block = strictBlock[0];
    assert(
      /windowMs: 1 \* 60 \* 1000/.test(block),
      'registerStrictLimiter has windowMs = 1 minute',
    );
    assert(
      /limit: 3/.test(block),
      'registerStrictLimiter has limit = 3',
    );
    assert(
      /keyGenerator: \(req\) => `register-strict:/.test(block),
      'registerStrictLimiter has keyGenerator prefix `register-strict:`',
    );
    assert(
      /store: new RedisStore\(\)/.test(block),
      'registerStrictLimiter uses RedisStore (atomic Lua bucket)',
    );
  }

  // 3. The legacy registerLimiter is still in place (10/hour) — verify it
  // is NOT the one mounted on /register in auth.ts.
  const authSrc = readFileSync(
    path.resolve(__dirname, '..', 'routes', 'auth.ts'),
    'utf8',
  );
  assert(
    /registerStrictLimiter/.test(authSrc),
    'routes/auth.ts imports registerStrictLimiter',
  );
  // The P1-12 register route should NOT use the authLimiter (5/min)
  // because we swapped to registerStrictLimiter (3/min).
  // We search for "router.post('/register'" and assert registerStrictLimiter
  // appears before validateBody.
  const registerRoute = authSrc.match(/router\.post\(\s*['"`]\/register['"`],[\s\S]*?validateBody/);
  assert(registerRoute !== null, 'register route block extractable');
  if (registerRoute) {
    assert(
      /registerStrictLimiter/.test(registerRoute[0]),
      'register route uses registerStrictLimiter (3/min)',
    );
    // assert authLimiter is no longer used in the register route
    assert(
      !/authLimiter/.test(registerRoute[0]),
      'register route no longer uses authLimiter (5/min) for the dedicated register quota',
    );
  }

  // 4. hCaptcha middleware is mounted in the register route
  if (registerRoute) {
    assert(
      /hcaptchaMiddleware/.test(authSrc.match(/router\.post\(\s*['"`]\/register['"`][\s\S]*?async \(req/)?.[0] || ''),
      'register route mounts hcaptchaMiddleware (after validateBody)',
    );
  }

  // 5. The fingerprint cap helper is imported and called in the register
  // handler.
  assert(
    /checkFingerprintRegistrationCap/.test(authSrc),
    'routes/auth.ts imports checkFingerprintRegistrationCap',
  );
  assert(
    /checkFingerprintRegistrationCap\(fingerprint, ipAddress\)/.test(authSrc),
    'register handler calls checkFingerprintRegistrationCap(fingerprint, ipAddress)',
  );

  // 6. The cap is admin-tunable via admin_settings
  const fpCapSrc = readFileSync(
    path.resolve(__dirname, '..', 'services', 'fingerprint-fraud-cap.ts'),
    'utf8',
  );
  assert(
    /fraud_max_accounts_per_fingerprint_24h/.test(fpCapSrc),
    'fingerprint-fraud-cap.ts reads fraud_max_accounts_per_fingerprint_24h',
  );
  assert(
    /getAdminSettingNumber/.test(fpCapSrc),
    'fingerprint-fraud-cap.ts uses getAdminSettingNumber',
  );
  assert(
    /hashFingerprint/.test(fpCapSrc),
    'fingerprint-fraud-cap.ts uses hashFingerprint (from device-fingerprint)',
  );

  // 7. audit_log row written on at-cap block
  if (registerRoute) {
    const idx = authSrc.indexOf('checkFingerprintRegistrationCap(fingerprint, ipAddress)');
    const block = idx >= 0 ? authSrc.slice(idx, idx + 2000) : '';
    assert(
      /audit_log/.test(block),
      'fingerprint-cap at-cap path writes an audit_log row',
    );
    assert(
      /signup\.blocked\.fingerprint_rate_limit/.test(block),
      'audit_log action is signup.blocked.fingerprint_rate_limit',
    );
  }

  console.log('');
  if (failed) {
    console.error('FAILED: P1-12 register-strict-limiter static check did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-12 register-strict-limiter static check assertions passed');
    process.exit(0);
  }
})();
