#!/usr/bin/env node
/**
 * lint-prisma-parity.js — fail CI when prisma/schema.prisma declares a
 * model or enum that has no corresponding table or type in the live DB.
 *
 * The Prisma client compiles queries against the schema at build time, but
 * the runtime DB is whatever node-pg-migrate has applied. If the two
 * drift (e.g. someone adds a model but forgets to write a migration),
 * the client will generate SQL against a non-existent relation and the
 * first real query will crash with `relation "X" does not exist`.
 *
 * The gate that catches this drift is built from two parts:
 *   1. Regenerate the "what the schema says" set by running
 *      `prisma migrate diff --from-empty --to-schema-datamodel --script`
 *      and parsing the emitted DDL for CREATE TYPE / CREATE TABLE names.
 *   2. Compare against the "what the DB has" set by querying
 *      pg_type / pg_tables for the same names.
 *
 * Anything in (1) but not in (2) is drift — the model exists in code but
 * the table/type does not exist in the migrated DB. Fail the build.
 *
 * Run after the bootstrap + migrations step in CI; the runner must have
 * already applied all migrations for the "what the DB has" query to be
 * meaningful. The script accepts the DATABASE_URL via env; if absent it
 * skips the DB query and only validates that the schema generates
 * (which is a weaker check).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/lint-prisma-parity.js
 *
 * Exit codes:
 *   0 — parity holds (all schema types/tables exist in DB)
 *   1 — drift detected (a schema type or table is missing in DB)
 *   2 — internal error (Prisma diff failed, DB query failed, etc.)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Helpers ─────────────────────────────────────────────────────────

function parseDiffForDeclared(ddlText) {
  // Extract every CREATE TYPE "X" AS ENUM and CREATE TABLE "X" name.
  // We don't care about columns, indexes, or anything else — just the
  // names. Schema names are always double-quoted in Prisma's emit.
  const types = [];
  const tables = [];

  const typeRe = /CREATE TYPE\s+"([^"]+)"\s+AS\s+ENUM\b/g;
  // Match CREATE TABLE "name" (with or without a following "(").
  // The previous \b-based regex failed because `"` is non-word and
  // the literal `(` after the name isn't a word boundary either.
  const tableRe = /CREATE TABLE\s+"([^"]+)"\s*[(,]/g;

  let match;
  while ((match = typeRe.exec(ddlText)) !== null) {
    types.push(match[1]);
  }
  while ((match = tableRe.exec(ddlText)) !== null) {
    tables.push(match[1]);
  }
  return { types, tables };
}

function diffSchemas(a, b) {
  // Case-sensitive set difference, returning the names in a but not b.
  const setB = new Set(b);
  return a.filter((x) => !setB.has(x));
}

// ── Step 1: regenerate the diff and parse the declared set ──────────

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA = path.join(REPO_ROOT, 'prisma', 'schema.prisma');

if (!fs.existsSync(SCHEMA)) {
  console.error(`❌ lint-prisma-parity: schema not found at ${SCHEMA}`);
  process.exit(2);
}

let diffText;
try {
  // --from-empty → emit CREATE statements for every type and table.
  // The output is a single SQL script; we don't execute it.
  diffText = execSync(
    `npx prisma migrate diff --from-empty --to-schema-datamodel "${SCHEMA}" --script`,
    {
      cwd: REPO_ROOT,
      env: { ...process.env, // Suppress Prisma's interactive prompts
             PRISMA_USER_CONSENT_FOR_ANALYTICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ).toString();
} catch (err) {
  console.error('❌ lint-prisma-parity: prisma migrate diff failed.');
  console.error(err.stderr ? err.stderr.toString() : err.message);
  process.exit(2);
}

const declared = parseDiffForDeclared(diffText);
console.log(`📐 Prisma schema declares ${declared.types.length} enum(s) and ${declared.tables.length} table(s):`);
console.log(`   types:  ${declared.types.join(', ')}`);
console.log(`   tables: ${declared.tables.join(', ')}`);

// ── Step 2: query the DB for the migrated set ────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('');
  console.warn('⚠️  lint-prisma-parity: DATABASE_URL is not set.');
  console.warn('   Skipping the DB cross-check. The script will only assert that');
  console.warn('   the schema generates (a weaker check). To run the full gate,');
  console.warn('   set DATABASE_URL in the CI step that invokes this script.');
  console.warn('');
  // We can't fail without DB access — drift in (declared) not in (db)
  // is what the gate is supposed to catch, and we have no DB set to
  // compare against. Exit 0 with the warning.
  process.exit(0);
}

let pg;
try {
  pg = require('pg');
} catch (err) {
  console.error('❌ lint-prisma-parity: pg module not available. Run `npm install`.');
  process.exit(2);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();

    // Read enums from pg_type (typname is the unqualified type name).
    // pg_enum is empty for our purposes; we just want the names.
    const enumResult = await client.query(
      `SELECT t.typname AS name
         FROM pg_type t
        WHERE t.typtype = 'e'
          AND t.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`
    );
    const dbTypes = enumResult.rows.map((r) => r.name);

    // Read tables from pg_tables (schemaname='public').
    const tableResult = await client.query(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`
    );
    const dbTables = tableResult.rows.map((r) => r.name);

    console.log(`🗄️  DB has ${dbTypes.length} enum(s) and ${dbTables.length} table(s) in public schema.`);

    // ── Step 3: compute drift ─────────────────────────────────────────
    const missingTypes = diffSchemas(declared.types, dbTypes);
    const missingTables = diffSchemas(declared.tables, dbTables);

    if (missingTypes.length === 0 && missingTables.length === 0) {
      console.log('✅ Prisma schema ↔ migrated DB: parity holds.');
      console.log(`   All ${declared.types.length} enum(s) and ${declared.tables.length} table(s) declared in Prisma exist in the DB.`);
      process.exit(0);
    }

    if (missingTypes.length > 0) {
      console.error('');
      console.error(`❌ Missing enums (declared in Prisma, absent in DB): ${missingTypes.join(', ')}`);
      console.error('   Fix: write a node-pg-migrate migration that creates these types.');
      console.error('   Then re-run `npm run lint:prisma-parity`.');
    }
    if (missingTables.length > 0) {
      console.error('');
      console.error(`❌ Missing tables (declared in Prisma, absent in DB): ${missingTables.join(', ')}`);
      console.error('   Fix: write a node-pg-migrate migration that creates these tables.');
      console.error('   Then re-run `npm run lint:prisma-parity`.');
    }
    process.exit(1);
  } catch (err) {
    console.error('❌ lint-prisma-parity: DB query failed.');
    console.error(err.message);
    process.exit(2);
  } finally {
    await client.end().catch(() => {});
  }
}

main();