#!/usr/bin/env node
// =============================================================================
// check-no-legacy-rate-limit.mjs
// =============================================================================
// P1-07 — Verify the legacy in-memory rate limiter is never reintroduced.
//
// Fails with exit code 1 if any of the following are found in `src/`:
//   - the file      src/middleware/rate-limit.ts
//   - a route file  imports from ../middleware/rate-limit  (the deleted legacy path)
//
// Run as:  npm run lint:legacy
//   or:     node scripts/check-no-legacy-rate-limit.mjs
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const legacyFile = path.join(srcRoot, 'middleware', 'rate-limit.ts');
const newFile    = path.join(srcRoot, 'middleware', 'rate-limiter.ts');

const errors = [];

// 1. The legacy file itself should not exist.
if (fs.existsSync(legacyFile)) {
  errors.push(
    `\n[LEGACY-FILE]  src/middleware/rate-limit.ts exists.\n` +
    `              The legacy in-memory limiter was deleted in P1-07.\n` +
    `              Use src/middleware/rate-limiter.ts (Redis-backed Lua bucket) instead.`,
  );
}

// 2. No file under src/ should import from '../middleware/rate-limit'.
const LEGACY_PATH_RX = /(\bfrom\s+|\brequire\()['"](\.\.\/)?(middleware\/)?rate-limit['"]/;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === 'check-no-legacy-rate-limit.mjs') continue;
    if (!/\.ts$|\.tsx$/.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (LEGACY_PATH_RX.test(line)) {
        const rel = path.relative(repoRoot, full);
        errors.push(`\n[LEGACY-IMPORT]  ${rel}:${i + 1}  →  ${line.trim()}`);
      }
    }
  }
}

if (fs.existsSync(srcRoot)) walk(srcRoot);

if (errors.length > 0) {
  console.error('\n[P1-07 LINT FAIL]  Legacy rate-limiter re-introduction detected:');
  console.error('---');
  for (const e of errors) console.error(e);
  console.error('');
  console.error('Fix:');
  console.error('  - Restore   src/middleware/rate-limiter.ts (Redis Lua bucket).');
  console.error('  - Replace   `from \'../middleware/rate-limit\'` with');
  console.error('             `from \'../middleware/rate-limiter\'` in the offender.');
  console.error('');
  process.exit(1);
}

console.log('[P1-07] legacy-rate-limit check passed.');
console.log(`        - legacy file absent:  ${!fs.existsSync(legacyFile) ? 'OK' : 'MISSING'}`);
console.log(`        - new file present:     ${fs.existsSync(newFile) ? 'OK' : 'MISSING'}`);
console.log('        - no legacy imports:    OK');
process.exit(0);
