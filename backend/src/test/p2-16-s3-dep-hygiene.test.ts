/**
 * P2-16 focused test — S3 dependency hygiene in audit-backup.
 *
 * Verifies that:
 *   1. `@aws-sdk/client-s3` is declared in backend/package.json
 *      dependencies (not devDependencies, not omitted).
 *   2. `backend/src/services/audit-backup.ts` uses the S3Client
 *      class — confirming the dep is actually used, not orphaned.
 *   3. There are no leftover `try { require('@aws-sdk/...') }` patterns
 *      in source (the spec said to remove any "orphaned require" if
 *      S3 is unused; we kept S3 and verify it is used).
 *
 * Run with: npx ts-node --require ./src/test/setup.ts src/test/p2-16-s3-dep-hygiene.test.ts
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

console.log('P2-16: S3 dependency hygiene in audit-backup');

const pkg = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'package.json'),
    'utf-8',
  ),
);

// ── Case 1: @aws-sdk/client-s3 is in dependencies ──────────────
const deps = pkg.dependencies || {};
const devDeps = pkg.devDependencies || {};
assert(
  '@aws-sdk/client-s3' in deps,
  '@aws-sdk/client-s3 is declared in dependencies',
);
assert(
  !('@aws-sdk/client-s3' in devDeps),
  '@aws-sdk/client-s3 is NOT a devDependency (correct — runtime use)',
);
const s3Version = deps['@aws-sdk/client-s3'];
assert(
  typeof s3Version === 'string' && s3Version.length > 0,
  `@aws-sdk/client-s3 has a version: ${s3Version}`,
);

// ── Case 2: audit-backup.ts uses S3Client ────────────────────
const auditBackupSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'audit-backup.ts'),
  'utf-8',
);
assert(
  auditBackupSrc.includes("from '@aws-sdk/client-s3'"),
  'audit-backup.ts imports from @aws-sdk/client-s3',
);
assert(
  auditBackupSrc.includes('S3Client'),
  'audit-backup.ts references the S3Client class',
);
assert(
  auditBackupSrc.includes('new S3Client'),
  'audit-backup.ts instantiates an S3Client (not just a type import)',
);

// ── Case 3: no orphaned try/require patterns ────────────────
const orphanPatterns = auditBackupSrc.match(
  /try\s*\{[^}]*require\s*\(\s*['"]@aws-sdk/g,
);
// Should match zero — we use a static import
assert(
  !orphanPatterns,
  'no orphaned try/require pattern for @aws-sdk in audit-backup',
);

// ── Case 4: live dep is installed (npm ls check via package-lock) ──
const lockfile = fs.readFileSync(
  path.join(__dirname, '..', '..', 'package-lock.json'),
  'utf-8',
);
const lockHasS3 = lockfile.includes('"@aws-sdk/client-s3"');
assert(lockHasS3, '@aws-sdk/client-s3 is in package-lock.json (resolved)');

console.log('');
if (failed) {
  console.error('FAILED: P2-16 S3 dep hygiene tests did not all pass');
  process.exit(1);
} else {
  console.log('PASS: All P2-16 S3 dep hygiene tests passed');
  process.exit(0);
}
