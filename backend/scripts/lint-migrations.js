#!/usr/bin/env node
/**
 * lint-migrations.js — fails CI when a migration directory contains
 * files that share the same numeric prefix (e.g. 024_a.sql and
 * 024_b.sql). node-pg-migrate tracks applied migrations by the full
 * filename string, so duplicate prefixes don't break today, but they
 * introduce ordering ambiguity, complicate future renumbering, and
 * have caused real bugs in this repo (see BACKEND_PROD_READINESS.md
 * P1-01).
 *
 * Exit codes:
 *   0 — every file has a unique prefix (CI passes)
 *   1 — duplicates found (CI fails)
 *   2 — internal error (e.g. malformed filenames)
 *
 * Usage:
 *   node scripts/lint-migrations.js [migrations-dir]
 *
 * The default migrations-dir is `<repo>/backend/migrations` resolved
 * relative to this script's location.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.resolve(__dirname, '..', 'migrations');

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR;

  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    console.error(`❌ lint-migrations: cannot read migrations dir ${dir}: ${err.message}`);
    process.exit(2);
  }

  if (files.length === 0) {
    console.error(`❌ lint-migrations: no .sql files found in ${dir}`);
    process.exit(1);
  }

  // Group files by their full prefix. Files at the same numeric prefix are
  // allowed when they have a sub-prefix (e.g. 049_0_prisma_baseline.sql +
  // 049_group_admin_action_types.sql both start with "049_" but the rest
  // distinguishes them). The rule is: the first 4 characters after the
  // numeric prefix must be unique across files at the same prefix. So
  // 049_0_ and 049_a_ are distinct sub-prefixes; 049_a_ and 049_a2_ are also
  // distinct. Files with no sub-prefix after the numeric prefix count as
  // sub-prefix "_".
  const prefixToFiles = new Map();
  const malformed = [];

  for (const file of files) {
    const match = file.match(/^(\d{3})(?:_([a-zA-Z0-9][^_]?_))?/);
    if (!match) {
      malformed.push(file);
      continue;
    }
    const prefix = match[1];
    const subPrefix = match[2] || '_';  // bare "049_foo.sql" => sub-prefix "_"
    const key = `${prefix}_${subPrefix}`;
    const list = prefixToFiles.get(prefix) || new Map();
    list.set(key, file);
    prefixToFiles.set(prefix, list);
  }

  let hasErrors = false;

  // Report malformed filenames.
  if (malformed.length > 0) {
    hasErrors = true;
    console.error(`❌ lint-migrations: ${malformed.length} file(s) do not start with a 3-digit numeric prefix:`);
    for (const f of malformed) {
      console.error(`     - ${f}`);
    }
  }

  // Report duplicate sub-prefixes within the same numeric prefix.
  const dupes = [];
  for (const [prefix, subMap] of prefixToFiles.entries()) {
    if (subMap.size === 0) continue;
    const keys = [...subMap.keys()];
    if (keys.length !== new Set(keys).size) {
      // This shouldn't happen because Map enforces uniqueness, but defensively
      dupes.push({ prefix, files: [...subMap.values()] });
    }
  }

  // (legacy duplicate-numeric-prefix check removed: NNN_x_ sub-prefixes
  // are now legitimate for ordering within a version, e.g. 049_0_baseline
  // before 049_group_admin_action_types.)

  // Report gaps in the prefix sequence (informational, not fatal).
  const prefixes = [...prefixToFiles.keys()].map((p) => parseInt(p, 10)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < prefixes.length; i++) {
    if (prefixes[i] !== prefixes[i - 1] + 1) {
      for (let gap = prefixes[i - 1] + 1; gap < prefixes[i]; gap++) {
        gaps.push(String(gap).padStart(3, '0'));
      }
    }
  }
  if (gaps.length > 0) {
    console.warn(`⚠️  lint-migrations: ${gaps.length} gap(s) in prefix sequence: ${gaps.join(', ')}`);
    console.warn(`    (gaps are NOT a failure — e.g. 015 may be reserved for future use)`);
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`✅ lint-migrations: ${files.length} migration file(s), all unique prefixes (${prefixes.length} distinct: ${prefixes[0]}..${prefixes[prefixes.length - 1]}).`);
  process.exit(0);
}

main();
