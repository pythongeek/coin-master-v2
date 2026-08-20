/**
 * ═══════════════════════════════════════════════════════════════
 *  DATABASE MIGRATIONS CLI (P0-03)
 *
 *  Standalone migration runner. Invoked by `npm run migrate`, by
 *  the dedicated `migrate` one-shot service in docker-compose, or
 *  manually via `npx ts-node src/migrate-cli/run-migrations.ts`. The backend
 *  process no longer runs migrations on boot — that path used to
 *  call `process.exit(1)` on any future bad migration and trigger
 *  an endless restart loop on the orchestrator.
 *
 *  Resolves the migrations directory EXPLICITLY relative to this
 *  file's location (`path.join(__dirname, '../../migrations')`) so
 *  the runner is robust against the calling shell's `cwd` —
 *  previously the runner used `process.cwd()` which broke silently
 *  if invoked from anywhere other than the backend repo root.
 *
 *  Exit codes:
 *    0 — all migrations applied (or already applied) successfully
 *    1 — at least one migration failed; logs include the failing
 *        file's name and the underlying error
 *    2 — internal error (DATABASE_URL missing, migrations dir missing,
 *        node-pg-migrate not installed)
 * ═══════════════════════════════════════════════════════════════
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Paths (resolved relative to THIS file, never to process.cwd())
// ---------------------------------------------------------------------------

// This file lives at backend/src/migrate-cli/run-migrations.ts. Going up
// two levels gets us to the backend repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const NPM_BIN = path.resolve(REPO_ROOT, 'node_modules', '.bin', 'node-pg-migrate');

// Fallback: some installs put the bin directly in node_modules/
const NODE_PG_MIGRATE_BIN = fs.existsSync(NPM_BIN)
  ? NPM_BIN
  : path.resolve(REPO_ROOT, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');

/** Programmatic entry point. Returns the process exit code. */
export async function runMigrationsCli(
  direction: 'up' | 'down' = 'up',
  options: { dryRun?: boolean } = {},
): Promise<number> {
  // ── Pre-flight checks ─────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] FATAL: DATABASE_URL is not set.');
    console.error('        Set it via .env / docker-compose env_file / k8s Secret.');
    return 2;
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`[migrate] FATAL: migrations directory not found at ${MIGRATIONS_DIR}`);
    return 2;
  }
  if (!fs.existsSync(NODE_PG_MIGRATE_BIN)) {
    console.error(`[migrate] FATAL: node-pg-migrate binary not found at ${NODE_PG_MIGRATE_BIN}`);
    console.error('        Run `npm install` in backend/.');
    return 2;
  }

  const startedAt = Date.now();
  const dryRunFlag = options.dryRun ? ' (dry-run)' : '';
  console.log(`[migrate] direction=${direction}${dryRunFlag} dir=${MIGRATIONS_DIR}`);

  // Build the node-pg-migrate argv.
  //
  // `--dry-run` is supported by node-pg-migrate directly: it prints
  // the SQL it would run, but does NOT execute it. Useful in CI to
  // catch SQL parse errors + dependency-on-previous-migration bugs
  // without writing to the DB.
  const args: string[] = [
    NODE_PG_MIGRATE_BIN,
    direction,
    '--no-check-order',
    '--migrations-dir', MIGRATIONS_DIR,
    '--migration-file-language', 'sql',
  ];
  if (options.dryRun) {
    args.push('--dry-run');
  }

  return new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,                              // node
      args,
      {
        stdio: 'inherit',
        env: process.env,
        // Spawn in the repo root so node-pg-migrate's default config
        // discovery (which reads `package.json` from cwd) works.
        cwd: REPO_ROOT,
      },
    );

    child.on('error', (err) => {
      console.error('[migrate] FATAL: failed to spawn node-pg-migrate:', err.message);
      resolve(2);
    });

    child.on('close', (code) => {
      const elapsedMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[migrate] OK (${elapsedMs}ms${dryRunFlag}).`);
      } else {
        console.error(`[migrate] FAILED with exit code ${code} after ${elapsedMs}ms${dryRunFlag}.`);
        console.error('[migrate] The backend container was NOT started — fix the migration');
        console.error('         and re-run this script before deploying.');
      }
      resolve(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint — invoked when this file is run directly
// ---------------------------------------------------------------------------
if (require.main === module) {
  // Parse: [up|down] [--dry-run]
  //
  // We accept --dry-run in any position (after the direction, or
  // before it). The flag is consumed by node-pg-migrate directly so
  // the same parser semantics apply (it errors on unknown flags).
  const rawArgs = process.argv.slice(2);
  let direction: 'up' | 'down' = 'up';
  let dryRun = false;

  for (const a of rawArgs) {
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === 'up' || a === 'down') {
      direction = a;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: ts-node src/migrate-cli/run-migrations.ts [up|down] [--dry-run]');
      console.log('  up      Apply pending migrations (default)');
      console.log('  down    Roll back the last applied migration');
      console.log('  --dry-run   Print SQL without executing (uses node-pg-migrate --dry-run)');
      process.exit(0);
    } else {
      console.error(`[migrate] Unknown argument: ${a}`);
      console.error('[migrate] Usage: ts-node src/migrate-cli/run-migrations.ts [up|down] [--dry-run]');
      process.exit(2);
    }
  }

  runMigrationsCli(direction, { dryRun }).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('[migrate] FATAL: unhandled error:', err);
    process.exit(2);
  });
}
