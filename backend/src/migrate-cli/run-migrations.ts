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
export async function runMigrationsCli(direction: 'up' | 'down' = 'up'): Promise<number> {
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
  console.log(`[migrate] direction=${direction} dir=${MIGRATIONS_DIR}`);

  return new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,                              // node
      [
        NODE_PG_MIGRATE_BIN,
        direction,
        '--no-check-order',
        '--migrations-dir', MIGRATIONS_DIR,
        '--migration-file-language', 'sql',
      ],
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
        console.log(`[migrate] OK (${elapsedMs}ms).`);
      } else {
        console.error(`[migrate] FAILED with exit code ${code} after ${elapsedMs}ms.`);
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
  const arg = process.argv[2];
  const direction: 'up' | 'down' = arg === 'down' ? 'down' : 'up';
  if (arg && arg !== 'up' && arg !== 'down') {
    console.error(`[migrate] Unknown argument: ${arg}`);
    console.error('[migrate] Usage: ts-node src/migrate-cli/run-migrations.ts [up|down]');
    process.exit(2);
  }

  runMigrationsCli(direction).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('[migrate] FATAL: unhandled error:', err);
    process.exit(2);
  });
}
