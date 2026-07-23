/**
 * P0-04 focused test: audit_log table name + hardened backup runner.
 *
 * The original `audit-backup.ts` targeted `audit_logs` (plural) with
 * columns that don't exist on the live `audit_log` (singular) table
 * that application code actually writes to. The hourly archive worker
 * failed silently every tick. Even on the legacy `audit_logs` table,
 * the `@aws-sdk/client-s3` require() was swallowed by a try/catch —
 * making S3 archival a no-op.
 *
 * This test confirms the new contract:
 *
 *   1. SELECT / UPDATE use the LIVE `audit_log` (singular) table.
 *   2. The columns referenced exist on the live table:
 *      id, user_id, category, action, severity, ip_address,
 *      user_agent, details, created_at, archived_at.
 *   3. BACKUP_MODE env is enforced: unknown value throws FATAL.
 *   4. `mode = s3` with missing AWS credentials throws FATAL (no
 *      silent local-only fallback).
 *   5. `mode = local` writes to backups/s3-mock/ and does NOT touch S3.
 *   6. `mode = both` writes locally AND uploads to S3.
 *   7. Table-existence assertion fails when audit_log is missing.
 *   8. @aws-sdk/client-s3 is a real import (not require'd in a try/catch).
 *   9. Migration 045 adds `archived_at` column to `audit_log`.
 */

import Module from 'module';
import fs from 'fs';
import path from 'path';

let failed = false;
function assert(cond: boolean, msg: string) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log('✅', msg);
  } else {
    // eslint-disable-next-line no-console
    console.error('❌', msg);
    failed = true;
  }
}

// ---------------------------------------------------------------------------
// 1. Source-level: the SQL uses `audit_log` (singular) — NOT `audit_logs`.
// ---------------------------------------------------------------------------
const backupSrc = fs.readFileSync(
  path.join(__dirname, '../services/audit-backup.ts'),
  'utf8',
);
const singularSelects = (backupSrc.match(/FROM\s+audit_log\b/g) || []).length;
const singularUpdates = (backupSrc.match(/UPDATE\s+audit_log\b/g) || []).length;
const pluralRefs = (backupSrc.match(/\baudit_logs\b/g) || []).length;
// Plural refs in comments are OK; only count SQL statements.
const pluralSelects = (backupSrc.match(/FROM\s+audit_logs\b/g) || []).length;
const pluralUpdates = (backupSrc.match(/UPDATE\s+audit_logs\b/g) || []).length;

assert(singularSelects >= 1, 'audit-backup.ts has at least one SELECT FROM audit_log (singular)');
assert(singularUpdates >= 1, 'audit-backup.ts has at least one UPDATE audit_log (singular)');
assert(pluralSelects === 0, 'audit-backup.ts has zero SELECT FROM audit_logs (plural) statements');
assert(pluralUpdates === 0, 'audit-backup.ts has zero UPDATE audit_logs (plural) statements');

// ---------------------------------------------------------------------------
// 2. Source-level: columns referenced in the SELECT exist on the live table.
// ---------------------------------------------------------------------------
const requiredColumns = [
  'id', 'user_id', 'category', 'action', 'severity',
  'ip_address', 'user_agent', 'details', 'created_at',
];
const missingCols = requiredColumns.filter((c) => !new RegExp(`\\b${c}\\b`).test(backupSrc));
assert(missingCols.length === 0, `SELECT clause references all live-table columns (missing: ${missingCols.join(', ') || 'none'})`);

// ---------------------------------------------------------------------------
// 3. Source-level: BACKUP_MODE env is enforced.
// ---------------------------------------------------------------------------
assert(/BACKUP_MODE/.test(backupSrc), 'audit-backup.ts reads BACKUP_MODE env');
assert(/must be one of/i.test(backupSrc), 'audit-backup.ts throws FATAL on unknown BACKUP_MODE value');

// ---------------------------------------------------------------------------
// 4. Source-level: S3 credentials failure is loud, not silent.
// ---------------------------------------------------------------------------
assert(/AWS_S3_AUDIT_BUCKET/.test(backupSrc), 'audit-backup.ts references AWS_S3_AUDIT_BUCKET');
assert(/AWS_ACCESS_KEY_ID/.test(backupSrc), 'audit-backup.ts references AWS_ACCESS_KEY_ID');
assert(/AWS_SECRET_ACCESS_KEY/.test(backupSrc), 'audit-backup.ts references AWS_SECRET_ACCESS_KEY');
assert(/FATAL.*AWS/i.test(backupSrc) || /FATAL[\s\S]*AWS/i.test(backupSrc),
  'audit-backup.ts emits a FATAL message when AWS env is missing in s3 mode');

// ---------------------------------------------------------------------------
// 5. Source-level: @aws-sdk/client-s3 is a real ES import (no try/catch wrap).
// ---------------------------------------------------------------------------
assert(/^import\s+\{[^}]*\}\s+from\s+['"]@aws-sdk\/client-s3['"]/m.test(backupSrc),
  '@aws-sdk/client-s3 is a static ES import (not a swallowed require)');
const swallowCount = (backupSrc.match(/try\s*\{[^}]*require\(['"]@aws-sdk/g) || []).length;
assert(swallowCount === 0, 'audit-backup.ts no longer wraps @aws-sdk/client-s3 require() in a try/catch');

// ---------------------------------------------------------------------------
// 6. Source-level: table-existence assertion is wired in.
// ---------------------------------------------------------------------------
assert(/to_regclass/i.test(backupSrc), 'audit-backup.ts runs a to_regclass() assertion');
assert(/assertAuditLogTableExists/.test(backupSrc),
  'audit-backup.ts exports assertAuditLogTableExists()');

// ---------------------------------------------------------------------------
// 7. Package.json: @aws-sdk/client-s3 is declared.
// ---------------------------------------------------------------------------
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
);
const declared = pkg.dependencies?.['@aws-sdk/client-s3'];
assert(typeof declared === 'string' && declared.length > 0,
  `package.json declares @aws-sdk/client-s3 (got: ${JSON.stringify(declared)})`);

// ---------------------------------------------------------------------------
// 8. Runtime: @aws-sdk/client-s3 import resolves.
// ---------------------------------------------------------------------------
let s3Mod: any;
let s3ImportThrew = false;
try {
  s3Mod = require('@aws-sdk/client-s3');
} catch {
  s3ImportThrew = true;
}
assert(!s3ImportThrew, '@aws-sdk/client-s3 resolves at runtime (package is installed)');
assert(typeof s3Mod?.S3Client === 'function', '@aws-sdk/client-s3 exports S3Client class');
assert(typeof s3Mod?.PutObjectCommand === 'function', '@aws-sdk/client-s3 exports PutObjectCommand class');

// ---------------------------------------------------------------------------
// 9. Migration 045 exists and adds `archived_at` to `audit_log`.
// ---------------------------------------------------------------------------
const migrationPath = path.join(__dirname, '../../migrations/045_audit_log_archived_at.sql');
assert(fs.existsSync(migrationPath), 'migration 045_audit_log_archived_at.sql exists');
if (fs.existsSync(migrationPath)) {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert(/ADD COLUMN IF NOT EXISTS\s+archived_at/i.test(sql),
    'migration 045 adds archived_at column (idempotent)');
  assert(/audit_log\b/i.test(sql),
    'migration 045 targets the audit_log (singular) table');
}

// ---------------------------------------------------------------------------
// 10. Runtime: backupAuditLogs honors BACKUP_MODE=local with no S3 client.
//    Mocks the DB query to return one row, asserts local file is written
//    and no S3 upload is attempted.
// ---------------------------------------------------------------------------
const captured: { sql: string[]; calls: number } = { sql: [], calls: 0 };
const fakeS3Calls: any[] = [];

const stubDb = {
  query: async (text: string, _params: any[] = []) => {
    captured.sql.push(text.replace(/\s+/g, ' ').trim());
    captured.calls++;
    // First call = to_regclass assertion (must succeed)
    if (text.includes('to_regclass')) {
      return { rows: [{ exists: true }] };
    }
    // Second call = SELECT unarchived rows (return one synthetic row)
    if (text.includes('FROM audit_log') && text.includes('archived_at IS NULL')) {
      return {
        rows: [{
          id: '11111111-1111-1111-1111-111111111111',
          user_id: null,
          category: 'auth',
          action: 'login',
          severity: 'info',
          ip_address: '127.0.0.1',
          user_agent: 'test-agent',
          details: { test: true },
          created_at: new Date(),
        }],
      };
    }
    // Third call = UPDATE archived_at
    if (text.startsWith('UPDATE audit_log SET archived_at')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
};

const stubRedis = { incr: async () => 0, get: async () => null };

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async connect() { return this; }
      async quit() { return 'OK'; }
      async disconnect() { return 'OK'; }
      async get() { return null; }
      async set() { return 'OK'; }
      async incr() { return 1; }
      async del() { return 1; }
      async expire() { return 1; }
    };
  }
  if (id.includes('config/database')) return stubDb;
  if (id.includes('config/redis')) return stubRedis;
  return originalRequire.apply(this, arguments as unknown as [string]);
};

(async () => {
  // ── Case A: BACKUP_MODE=local — file is written, no S3 access ──────
  process.env.BACKUP_MODE = 'local';
  delete process.env.AWS_S3_AUDIT_BUCKET;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  // Wipe the test backup dir before this case
  const backupDir = path.join(__dirname, '../../backups/s3-mock');
  if (fs.existsSync(backupDir)) {
    for (const f of fs.readdirSync(backupDir)) fs.unlinkSync(path.join(backupDir, f));
  }
  // Force a fresh require so the BACKUP_MODE change is picked up.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('audit-backup')) delete require.cache[k];
  }
  const ab = require('../services/audit-backup');

  captured.calls = 0;
  captured.sql = [];
  let resA: any;
  try {
    resA = await ab.backupAuditLogs();
  } catch (e: any) {
    assert(false, `BACKUP_MODE=local backupAuditLogs threw: ${e.message}`);
  }
  if (resA) {
    assert(resA.mode === 'local', `BACKUP_MODE=local: returned mode === 'local' (got: ${resA.mode})`);
    assert(resA.rowsArchived === 1, `BACKUP_MODE=local: archived 1 row (got: ${resA.rowsArchived})`);
    assert(resA.uploadedToS3 === false, 'BACKUP_MODE=local: did NOT upload to S3');
    assert(resA.writtenLocally === true, 'BACKUP_MODE=local: wrote file locally');
    assert(
      captured.sql.some((s) => s.startsWith('SELECT to_regclass')),
      'BACKUP_MODE=local: ran to_regclass() assertion',
    );
    assert(
      captured.sql.some((s) => s.includes('FROM audit_log') && s.includes('archived_at IS NULL')),
      'BACKUP_MODE=local: SELECT used audit_log (singular) and archived_at IS NULL',
    );
    assert(
      captured.sql.some((s) => s.startsWith('UPDATE audit_log SET archived_at')),
      'BACKUP_MODE=local: UPDATE used audit_log (singular)',
    );
    // File should exist
    if (resA.filename) {
      const fp = path.join(backupDir, resA.filename);
      assert(fs.existsSync(fp), `BACKUP_MODE=local: backup file written to ${path.relative(process.cwd(), fp)}`);
    }
  }

  // ── Case B: BACKUP_MODE=s3 with no AWS env — throws FATAL ─────────
  for (const k of Object.keys(require.cache)) {
    if (k.includes('audit-backup')) delete require.cache[k];
  }
  process.env.BACKUP_MODE = 's3';
  delete process.env.AWS_S3_AUDIT_BUCKET;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  const ab2 = require('../services/audit-backup');
  let threw = false;
  let msg = '';
  try {
    await ab2.backupAuditLogs();
  } catch (e: any) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'BACKUP_MODE=s3 with missing AWS env throws (no silent local fallback)');
  assert(
    msg.includes('AWS_S3_AUDIT_BUCKET') || msg.includes('AWS_ACCESS_KEY_ID') || msg.includes('AWS_SECRET_ACCESS_KEY'),
    `BACKUP_MODE=s3 error message references AWS env vars (got: "${msg.slice(0, 120)}")`,
  );

  // ── Case C: BACKUP_MODE=both with valid AWS env — uploads AND writes ─
  for (const k of Object.keys(require.cache)) {
    if (k.includes('audit-backup')) delete require.cache[k];
  }
  process.env.BACKUP_MODE = 'both';
  process.env.AWS_S3_AUDIT_BUCKET = 'test-bucket';
  process.env.AWS_ACCESS_KEY_ID = 'AKIA-TEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
  process.env.AWS_REGION = 'us-east-1';

  // Monkey-patch the S3 client so we can intercept the PutObject call.
  // The require'd module's S3Client is a class; we replace its `send`
  // method on a captured instance via a subclass wrapper.
  const realS3 = require('@aws-sdk/client-s3');
  const origSend = realS3.S3Client.prototype.send;
  realS3.S3Client.prototype.send = async function (cmd: any) {
    fakeS3Calls.push(cmd);
    return { $metadata: { httpStatusCode: 200 } };
  };

  const ab3 = require('../services/audit-backup');
  let resC: any;
  try {
    resC = await ab3.backupAuditLogs();
  } catch (e: any) {
    assert(false, `BACKUP_MODE=both backupAuditLogs threw: ${e.message}`);
  } finally {
    realS3.S3Client.prototype.send = origSend;
  }
  if (resC) {
    assert(resC.mode === 'both', `BACKUP_MODE=both: returned mode === 'both' (got: ${resC.mode})`);
    assert(resC.uploadedToS3 === true, 'BACKUP_MODE=both: uploadedToS3 === true');
    assert(resC.writtenLocally === true, 'BACKUP_MODE=both: writtenLocally === true');
    assert(fakeS3Calls.length === 1, `BACKUP_MODE=both: exactly one S3 PutObject call (got: ${fakeS3Calls.length})`);
    if (fakeS3Calls[0]) {
      assert(fakeS3Calls[0].input?.Bucket === 'test-bucket',
        `BACKUP_MODE=both: S3 PutObject targets correct bucket (got: ${fakeS3Calls[0].input?.Bucket})`);
      assert(typeof fakeS3Calls[0].input?.Key === 'string' && fakeS3Calls[0].input.Key.startsWith('audit-log/'),
        `BACKUP_MODE=both: S3 Key uses audit-log/ prefix (got: ${fakeS3Calls[0].input?.Key})`);
    }
  }

  // ── Case D: BACKUP_MODE=invalid — throws FATAL ────────────────────
  for (const k of Object.keys(require.cache)) {
    if (k.includes('audit-backup')) delete require.cache[k];
  }
  process.env.BACKUP_MODE = 'ftp';  // invalid
  const ab4 = require('../services/audit-backup');
  threw = false;
  msg = '';
  try {
    await ab4.backupAuditLogs();
  } catch (e: any) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'BACKUP_MODE=<unknown value> throws FATAL');
  assert(msg.includes('local') && msg.includes('s3') && msg.includes('both'),
    'Invalid BACKUP_MODE error message lists the valid options');

  // ── Case E: assertAuditLogTableExists — table missing throws ───────
  // Reset module to pick up stubbed DB.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('audit-backup')) delete require.cache[k];
  }
  // Swap in a DB stub that says audit_log does NOT exist
  const stubDbNoTable = {
    query: async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ exists: false }] };
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  };
  Module.prototype.require = function (id: string) {
    if (id === 'ioredis') return class MockRedis { on(){return this} async connect(){return this} async quit(){return 'OK'} };
    if (id.includes('config/database')) return stubDbNoTable;
    if (id.includes('config/redis')) return stubRedis;
    return originalRequire.apply(this, arguments as unknown as [string]);
  };
  process.env.BACKUP_MODE = 'local';
  const ab5 = require('../services/audit-backup');
  threw = false;
  msg = '';
  try {
    await ab5.assertAuditLogTableExists();
  } catch (e: any) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'assertAuditLogTableExists throws when audit_log table is missing');
  assert(msg.includes('audit_log') && (msg.includes('not found') || msg.includes('FATAL')),
    `Missing-table error mentions audit_log + FATAL (got: "${msg.slice(0, 120)}")`);

  // ── Summary ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('');
  if (failed) {
    // eslint-disable-next-line no-console
    console.error('❌ P0-04 tests FAILED');
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.log('🎉 All P0-04 audit-backup tests passed');
    process.exit(0);
  }
})();
