/**
 * P2-07 focused test — OpenAPI spec filtering.
 *
 * Verifies that:
 *   1. `publicOpenApiSpec` excludes every path whose operations are
 *      tagged with any of `ADMIN_TAGS`.
 *   2. `adminOpenApiSpec` includes every admin-tagged path.
 *   3. `publicOpenApiSpec.tags` excludes every admin tag.
 *   4. `adminOpenApiSpec.tags` includes every admin tag.
 *   5. The public spec retains every public path (sample of 6 known
 *      public paths).
 *   6. The deprecation alias `openApiSpec` matches `publicOpenApiSpec`.
 *   7. The `isAdminPath` helper correctly identifies admin paths.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/openapi-filter.test.ts
 */

import {
  publicOpenApiSpec,
  adminOpenApiSpec,
  openApiSpec,
  ADMIN_TAGS,
  isAdminPath,
} from '../config/openapi';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

// ── Case 1: ADMIN_TAGS export is non-empty ──────────────────────
assert(ADMIN_TAGS.length === 4, `ADMIN_TAGS has 4 entries (got ${ADMIN_TAGS.length})`);
assert(ADMIN_TAGS.includes('Admin'), 'ADMIN_TAGS includes "Admin"');
assert(ADMIN_TAGS.includes('Admin — Withdrawals'), 'ADMIN_TAGS includes "Admin — Withdrawals"');
assert(ADMIN_TAGS.includes('Admin — Health'), 'ADMIN_TAGS includes "Admin — Health"');
assert(ADMIN_TAGS.includes('Admin — Bonuses'), 'ADMIN_TAGS includes "Admin — Bonuses"');

// ── Case 2: Admin paths are absent from public spec ─────────────
// Sample admin paths that we know exist in the raw spec.
const knownAdminPaths = [
  '/api/admin/withdrawals',
  '/api/admin/withdrawals/stats',
  '/api/admin/withdrawals/{id}/approve',
  '/api/admin/withdrawals/{id}/reject',
  '/api/admin/health',
  '/api/admin/audit-logs',
  '/api/admin/fraud-logs',
  '/api/admin/change-password',
  '/api/admin/2fa/status',
  '/api/admin/seed/rotate',
  '/api/dashboard/admin/users',
  '/api/dashboard/admin/users/{id}',
  '/api/dashboard/admin/live',
  '/api/kyc/admin/list',
  '/api/bonus/active',
  '/api/bonus/claim',
];

for (const p of knownAdminPaths) {
  assert(
    !(p in (publicOpenApiSpec as any).paths),
    `public spec excludes admin path: ${p}`,
  );
}

// ── Case 3: Admin paths ARE in the admin spec ────────────────────
for (const p of knownAdminPaths) {
  assert(
    p in (adminOpenApiSpec as any).paths,
    `admin spec includes admin path: ${p}`,
  );
}

// ── Case 4: Public paths are still in the public spec ────────────
const knownPublicPaths = [
  '/api/health',
  '/api/public/banner',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/wallet',
  '/api/auth/2fa/setup',
  '/api/auth/2fa/verify',
  '/api/auth/2fa/login',
  '/api/game/bet',
  '/api/game/verify',
  '/api/game/jackpot',
  '/api/game/seed',
  '/api/game/history/{userId}',
  '/api/game/config',
  '/api/dashboard/stats/{userId}',
  '/api/dashboard/chart/{userId}',
  '/api/wallet/balances',
  '/api/wallet/transactions',
  '/api/payment/create',
  '/api/payment/orders',
  '/api/promo/validate',
  '/api/leaderboard',
  '/api/kyc/status',
  '/api/kyc/token',
  '/api/affiliate',
  '/api/affiliate/claim',
  '/api/webhooks/binance',
  '/api/webhooks/redot',
];

for (const p of knownPublicPaths) {
  assert(
    p in (publicOpenApiSpec as any).paths,
    `public spec includes public path: ${p}`,
  );
}

// ── Case 5: Admin tags are absent from public spec.tags ─────────
const publicTagNames = ((publicOpenApiSpec as any).tags || []).map(
  (t: { name: string }) => t.name,
);
for (const t of ADMIN_TAGS) {
  assert(!publicTagNames.includes(t), `public spec.tags excludes admin tag: "${t}"`);
}

// ── Case 6: Admin tags ARE in admin spec.tags ────────────────────
const adminTagNames = ((adminOpenApiSpec as any).tags || []).map(
  (t: { name: string }) => t.name,
);
for (const t of ADMIN_TAGS) {
  assert(adminTagNames.includes(t), `admin spec.tags includes admin tag: "${t}"`);
}

// ── Case 7: Public spec retains NON-admin tags ───────────────────
const expectedPublicTags = [
  'Auth',
  'Wallet',
  'Game',
  'Dashboard',
  'Public',
  'Webhooks',
  'KYC',
  'Affiliates',
  'Promos',
];
for (const t of expectedPublicTags) {
  assert(publicTagNames.includes(t), `public spec.tags retains: "${t}"`);
}

// ── Case 8: The deprecation alias is the public subset ──────────
assert(
  openApiSpec === publicOpenApiSpec,
  'openApiSpec === publicOpenApiSpec (backward-compat alias)',
);

// ── Case 9: isAdminPath helper identifies admin paths correctly ─
for (const p of knownAdminPaths) {
  assert(isAdminPath(p), `isAdminPath: ${p} → true`);
}
for (const p of knownPublicPaths) {
  assert(!isAdminPath(p), `isAdminPath: ${p} → false`);
}

// ── Case 10: Edge case — unknown path → false ───────────────────
assert(!isAdminPath('/api/unknown'), 'isAdminPath: /api/unknown → false');
assert(!isAdminPath(''), 'isAdminPath: empty → false');

// ── Case 11: Path-count regression check ────────────────────────
const publicPathCount = Object.keys((publicOpenApiSpec as any).paths).length;
const adminPathCount = Object.keys((adminOpenApiSpec as any).paths).length;
assert(
  adminPathCount > publicPathCount,
  `admin spec has more paths (admin=${adminPathCount} > public=${publicPathCount})`,
);
assert(
  adminPathCount === knownAdminPaths.length + knownPublicPaths.length,
  `admin spec contains every known path (got ${adminPathCount}, expected ${knownAdminPaths.length + knownPublicPaths.length})`,
);
const expectedAdminCount = 45;
const expectedPublicCount = 29;
assert(adminPathCount === expectedAdminCount, `admin spec has 45 paths (got ${adminPathCount})`);
assert(publicPathCount === expectedPublicCount, `public spec has 29 paths (got ${publicPathCount})`);
assert(
  publicPathCount === knownPublicPaths.length,
  `public spec contains only public paths (got ${publicPathCount}, expected ${knownPublicPaths.length})`,
);

// ── Case 12: OpenAPI structural validity ────────────────────────
assert(
  (publicOpenApiSpec as any).openapi === '3.1.0',
  'public spec declares OpenAPI 3.1.0',
);
assert(
  (adminOpenApiSpec as any).openapi === '3.1.0',
  'admin spec declares OpenAPI 3.1.0',
);
assert(
  (publicOpenApiSpec as any).info.title === 'CryptoFlip API',
  'public spec has correct title',
);
assert(
  (adminOpenApiSpec as any).info.title === 'CryptoFlip API',
  'admin spec has correct title',
);

console.log('');
if (failed) {
  console.error('FAILED: P2-07 openapi-filter tests did not all pass');
  process.exit(1);
} else {
  console.log('PASS: All P2-07 openapi-filter tests passed');
  process.exit(0);
}
