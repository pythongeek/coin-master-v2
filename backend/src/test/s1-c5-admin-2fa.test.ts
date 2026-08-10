/**
 * S1-C5 — requireAdmin2FA middleware regression tests
 *
 * Audit ref:  PROD_AUDIT_2026-08-07.md → C5, ACCESS-1
 * Severity:   CRITICAL — stolen super_admin token otherwise drains all
 *              pending withdrawals.
 *
 * Bug:  POST /api/admin/withdrawals/:id/approve and /:id/reject had no
 *       2FA enforcement, despite `admin_2fa_required` setting existing
 *       in admin_settings.
 *
 * Fix:  New middleware `requireAdmin2FA` reads `admin_2fa_required`
 *       from DB; if true, validates `X-Admin-2FA-Token` header against
 *       the admin's TOTP secret. Honors grace window via `totp_verified_at`.
 *       Audit-logs every success/failure.
 *
 * Runs via:
 *   npx ts-node --require ./src/test/setup.ts src/test/s1-c5-admin-2fa.test.ts
 *
 * Tests exercise the middleware in isolation (Express req/res mocks)
 * because the admin routes hold a complex dependency tree that's not
 * worth rebuilding for unit tests.
 */

import {
  resetAllMocks,
  MOCK_USERS,
  MOCK_SETTINGS,
  MOCK_AUDIT_LOGS,
  setQueryInterceptor,
} from './helpers/test-mocks';

const { requireAdmin2FA } = require('../middleware/require-admin-2fa');
const { verifyTotp } = require('../utils/totp');
const { decryptSecret } = require('../utils/totp');

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✅ ${msg}`); pass++; }
  else { console.error(`  ❌ ${msg}`); fail++; }
}

function getTOTP(secret: string): string {
  // Use the same TOTP algorithm as production. The utility exports
  // generateTotpHelper? No — verifyTotp takes a pre-computed token.
  // For tests we hardcode a known good token based on a fixed secret.
  // In real test runs, we set totp_verified_at to bypass the grace path.
  return '';
}

function makeReqRes(user: any, headers: Record<string, string> = {}) {
  const req: any = { headers, user };
  const res: any = {
    statusCode: 200,
    headers: {},
    body: null,
    locals: {},
    status(code: number) { this.statusCode = code; return this; },
    json(obj: any) { this.body = obj; return this; },
  };
  let nextCalled = false; const next: any = () => { nextCalled = true; };
  return { req, res, next, getNextCalled: () => nextCalled };
}

function installMock(adminRecord: any, settings: any[] = []) {
  setQueryInterceptor(async (text: string, params: any[]) => {
    const upper = text.trim().replace(/\s+/g, ' ').toUpperCase();

    // SELECT totp_enabled, totp_secret_encrypted, totp_verified_at FROM users WHERE id = $1
    if (upper.startsWith('SELECT TOTP_ENABLED, TOTP_SECRET_ENCRYPTED, TOTP_VERIFIED_AT')) {
      return { rows: adminRecord ? [adminRecord] : [] };
    }

    // UPDATE users SET totp_verified_at = NOW() WHERE id = $1
    if (upper.startsWith('UPDATE USERS SET TOTP_VERIFIED_AT')) {
      return { rows: [], rowCount: 1 };
    }

    // SELECT key, value FROM admin_settings WHERE key = $1
    if (upper.includes('FROM ADMIN_SETTINGS') && upper.includes('WHERE KEY')) {
      const key = params[0];
      const found = settings.find((s: any) => s.key === key);
      return { rows: found ? [{ key: found.key, value: found.value }] : [] };
    }

    // INSERT INTO audit_log (category, action, severity, user_id, details)
    // Two different call-site patterns:
    //   bonus.ts: VALUES (literal, literal, literal, $1, $2) — params[0]=user_id, params[1]=JSON
    //   require-admin-2fa.ts: VALUES (literal, literal, $1, $2, $3) — params[0]=severity, params[1]=user_id, params[2]=JSON
    // Detect by examining the SQL literal in the VALUES clause.
    if (upper.startsWith('INSERT INTO AUDIT_LOG')) {
      const m = upper.match(/VALUES\s*\(["']?(SECURITY|WITHDRAWAL)["']?,\s*["']?[A-Z0-9_.]+["']?/);
      if (m && m[1] === 'SECURITY') {
        // require-admin-2fa.ts pattern: params[0]=severity, params[1]=user_id, params[2]=JSON
        MOCK_AUDIT_LOGS.push({
          user_id: params[1],
          category: 'security',
          action: upper.includes('ADMIN_2FA.BLOCKED') ? 'admin_2fa.blocked' : 'admin_2fa.ok',
          severity: params[0],
          details: params[2] || {},
          created_at: new Date(),
        });
      } else {
        // bonus.ts pattern: params[0]=user_id, params[1]=JSON
        MOCK_AUDIT_LOGS.push({
          user_id: params[0],
          category: 'withdrawal',
          action: upper.includes('WITHDRAWAL.APPROVED') ? 'withdrawal.approved' : 'withdrawal.rejected',
          severity: params[3] || 'warn',
          details: params[1] || {},
          created_at: new Date(),
        });
      }
      return { rows: [] };
    }

    return undefined;
  });
}

async function runTests() {
  console.log('🧪 S1-C5 requireAdmin2FA middleware tests\n');

  const adminId = 'admin-uuid-aaaa-bbbb-cccc-dddddddddddd';

  // ─────────────────────────────────────────────────────────────
  // Test A: admin_2fa_required=false → bypass
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test A: admin_2fa_required=false → bypass ──');
    resetAllMocks();
    installMock(null, [{ key: 'admin_2fa_required', value: 'false' }]);

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() === true, 'next() called');
    assert(res.statusCode === 200, 'no error status');
    assert(res.locals.admin2fa?.result === 'bypassed', 'res.locals.admin2fa.result = bypassed');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test B: admin_2fa_required=true, no TOTP enrolled → 403
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test B: admin_2fa_required=true, no TOTP → 403 ──');
    resetAllMocks();
    installMock(
      { totp_enabled: false, totp_secret_encrypted: null, totp_verified_at: null },
      [{ key: 'admin_2fa_required', value: 'true' }],
    );

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() !== true, 'next() NOT called');
    assert(res.statusCode === 403, 'status 403');
    assert(res.body?.error?.includes('not enrolled'), 'error mentions enrollment');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test C: admin_2fa_required=true, TOTP enrolled, missing header → 403
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test C: TOTP enrolled, X-Admin-2FA-Token missing → 403 ──');
    resetAllMocks();
    installMock(
      { totp_enabled: true, totp_secret_encrypted: 'encrypted-secret', totp_verified_at: null },
      [{ key: 'admin_2fa_required', value: 'true' }],
    );

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() !== true, 'next() NOT called');
    assert(res.statusCode === 403, 'status 403');
    assert(res.body?.requires_2fa === true, 'response.requires_2fa = true');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test D: admin_2fa_required=true, TOTP enrolled, valid TOTP within grace → ok
  // (grace window via totp_verified_at within 5 min)
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test D: TOTP within grace window → ok via grace ──');
    resetAllMocks();
    const recentVerify = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    installMock(
      { totp_enabled: true, totp_secret_encrypted: require('../utils/totp').encryptSecret('JBSWY3DPEHPK3PXP'), totp_verified_at: recentVerify },
      [
        { key: 'admin_2fa_required', value: 'true' },
        { key: 'admin_2fa_grace_minutes', value: '5' },
      ],
    );

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() === true, 'next() called (grace bypass)');
    assert(res.locals.admin2fa?.result === 'ok', 'result=ok');
    assert(res.locals.admin2fa?.via === 'grace', 'via=grace');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test E: admin_2fa_required=true, TOTP enrolled, grace expired, missing header → 403
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test E: grace expired, missing header → 403 ──');
    resetAllMocks();
    const oldVerify = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    installMock(
      { totp_enabled: true, totp_secret_encrypted: require('../utils/totp').encryptSecret('JBSWY3DPEHPK3PXP'), totp_verified_at: oldVerify },
      [
        { key: 'admin_2fa_required', value: 'true' },
        { key: 'admin_2fa_grace_minutes', value: '5' },
      ],
    );

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() !== true, 'next() NOT called');
    assert(res.statusCode === 403, 'status 403');
    assert(res.body?.requires_2fa === true, 'response.requires_2fa = true');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test F: admin_2fa_required=true, TOTP enrolled, grace expired, invalid TOTP → 403
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test F: grace expired, invalid TOTP → 403 ──');
    resetAllMocks();
    const oldVerify = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Use a valid Base32 secret so decryptSecret doesn't crash on length.
    // The token we send is wrong so verifyTotp should fail.
    installMock(
      {
        totp_enabled: true,
        totp_secret_encrypted: require('../utils/totp').encryptSecret('JBSWY3DPEHPK3PXP'),
        totp_verified_at: oldVerify,
      },
      [
        { key: 'admin_2fa_required', value: 'true' },
        { key: 'admin_2fa_grace_minutes', value: '5' },
      ],
    );

    const { req, res, next, getNextCalled } = makeReqRes(
      { userId: adminId, isAdmin: true },
      { 'x-admin-2fa-token': '000000' },
    );
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() !== true, 'next() NOT called');
    assert(res.statusCode === 403, 'status 403');
    assert(res.body?.error?.includes('Invalid'), 'error says invalid');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test G: admin_2fa_required=true, TOTP enrolled, grace expired, valid TOTP → ok
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test G: grace expired, valid TOTP → ok via totp ──');
    resetAllMocks();
    const oldVerify = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Use a real Base32 secret (JBSWY3DPEHPK3PXP is the canonical example).
    const realSecret = 'JBSWY3DPEHPK3PXP';
    // Compute current TOTP for this secret.
    const { generateHotp } = require('../utils/totp'); const step = Math.floor(Date.now() / 30000); const totp = generateHotp(realSecret, step);
    installMock(
      {
        totp_enabled: true,
        totp_secret_encrypted: require('../utils/totp').encryptSecret(realSecret),
        totp_verified_at: oldVerify,
      },
      [
        { key: 'admin_2fa_required', value: 'true' },
        { key: 'admin_2fa_grace_minutes', value: '5' },
      ],
    );

    const { req, res, next, getNextCalled } = makeReqRes(
      { userId: adminId, isAdmin: true },
      { 'x-admin-2fa-token': totp },
    );
    await requireAdmin2FA(req, res, next);

    assert(getNextCalled() === true, 'next() called (TOTP valid)');
    assert(res.locals.admin2fa?.result === 'ok', 'result=ok');
    assert(res.locals.admin2fa?.via === 'totp', 'via=totp');
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // Test H: every failure writes an audit_log entry
  // ─────────────────────────────────────────────────────────────
  {
    console.log('── Test H: every blocked attempt writes admin_2fa.blocked audit_log ──');
    resetAllMocks();
    installMock(
      { totp_enabled: true, totp_secret_encrypted: require('../utils/totp').encryptSecret('JBSWY3DPEHPK3PXP'), totp_verified_at: null },
      [{ key: 'admin_2fa_required', value: 'true' }],
    );

    const { req, res, next, getNextCalled } = makeReqRes({ userId: adminId, isAdmin: true });
    await requireAdmin2FA(req, res, next);

    const blocked = MOCK_AUDIT_LOGS.filter(
      (a: any) => a.action === 'admin_2fa.blocked',
    );
    assert(blocked.length >= 1, 'audit_log admin_2fa.blocked entry written');
    assert(blocked[0]?.user_id === adminId, 'audit_log user_id matches admin');
    console.log('');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  else process.exit(0);
}

// Bootstrap: install mocks then run
const { installCommonMocks } = require('./helpers/test-mocks');
installCommonMocks();

runTests().catch((err: any) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
