/**
 * ═══════════════════════════════════════════════════════════════
 *  AUDIT BACKUP — periodic archival of `audit_log` rows.
 * ═══════════════════════════════════════════════════════════════
 *
 *  P0-04 fix: the previous implementation targeted a non-existent
 *  table `audit_logs` (plural) with columns that don't exist on
 *  the live `audit_log` (singular) table. The hourly archive worker
 *  failed silently every tick and never archived any rows.
 *
 *  New behavior:
 *    - SELECT / UPDATE against the LIVE `audit_log` table
 *      (singular) using the columns that actually exist there:
 *      id, user_id, category, action, severity, ip_address,
 *      user_agent, details, created_at, archived_at.
 *    - Migration 045 added `archived_at TIMESTAMPTZ` to the table.
 *    - Explicit `BACKUP_MODE` env (local | s3 | both). The operator
 *      picks the strategy at deploy time — never silently degraded.
 *    - On startup the worker asserts the table exists
 *      (`SELECT to_regclass('audit_log')`) and fails fast otherwise.
 *    - When `BACKUP_MODE` includes `s3`, missing AWS credentials
 *      cause the run to throw instead of silently writing only
 *      to local disk. This prevents the "configured S3 but didn't
 *      upload" footgun.
 *    - When `BACKUP_MODE` includes `local`, the existing
 *      `backups/s3-mock/` directory is used (kept for ops continuity).
 *
 *  Backups are JSON bundles of one run's worth of unarchived rows.
 *  After upload (or local write), `archived_at = NOW()` is set on
 *  those rows so the next run picks up only newly-inserted audit
 *  rows.
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'fs';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { query } from '../config/database';

export type BackupMode = 'local' | 's3' | 'both';

function readBackupMode(): BackupMode {
  const raw = (process.env.BACKUP_MODE || 'local').toLowerCase();
  if (raw !== 'local' && raw !== 's3' && raw !== 'both') {
    throw new Error(
      `FATAL: BACKUP_MODE must be one of "local", "s3", "both" (got "${process.env.BACKUP_MODE}"). Refusing to run with unknown mode.`,
    );
  }
  return raw;
}

function getS3ConfigOrThrow(): { bucket: string; client: S3Client } {
  const bucket = process.env.AWS_S3_AUDIT_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || 'us-east-1';
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'FATAL: BACKUP_MODE includes "s3" but AWS_S3_AUDIT_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not all set.',
    );
  }
  return {
    bucket,
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

/**
 * Assert that the `audit_log` table is reachable. Throws if the
 * relation does not exist (e.g. wrong DB, migration not run).
 */
export async function assertAuditLogTableExists(): Promise<void> {
  const result = await query(
    "SELECT to_regclass('public.audit_log') IS NOT NULL AS exists",
  );
  const exists = result.rows[0]?.exists === true;
  if (!exists) {
    throw new Error(
      'FATAL: audit_log table not found in database. Run migration 045 (or the full migrations/ set) before starting the audit backup worker.',
    );
  }
}

interface AuditLogRow {
  id: string;
  user_id: string | null;
  category: string;
  action: string;
  severity: string;
  ip_address: string | null;
  user_agent: string | null;
  details: unknown;
  created_at: Date;
}

interface BackupResult {
  mode: BackupMode;
  rowsArchived: number;
  uploadedToS3: boolean;
  writtenLocally: boolean;
  filename: string;
}

/**
 * Fetch unarchived audit rows, persist them as a JSON bundle, and
 * mark them archived.
 *
 * Exported for testing. The periodic worker calls this on a timer.
 */
export async function backupAuditLogs(): Promise<BackupResult> {
  const mode = readBackupMode();
  await assertAuditLogTableExists();

  const result = await query<AuditLogRow>(
    `SELECT id, user_id, category, action, severity, ip_address, user_agent, details, created_at
     FROM audit_log
     WHERE archived_at IS NULL
     ORDER BY id ASC`,
  );

  if (result.rows.length === 0) {
    if (process.env.NODE_ENV === 'development') {
      console.log('📝 Audit log backup: no new logs to archive.');
    }
    return {
      mode,
      rowsArchived: 0,
      uploadedToS3: false,
      writtenLocally: false,
      filename: '',
    };
  }

  const rows = result.rows;
  const maxId = rows[rows.length - 1].id;
  const filename = `audit-log-${Date.now()}-${maxId}.json`;
  const body = JSON.stringify(rows, null, 2);

  let uploadedToS3 = false;
  let writtenLocally = false;

  // ── S3 path ─────────────────────────────────────────────────────
  if (mode === 's3' || mode === 'both') {
    const { bucket, client } = getS3ConfigOrThrow();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `audit-log/${filename}`,
        Body: body,
        ContentType: 'application/json',
      }),
    );
    console.log(`☁️  Audit logs uploaded to S3: audit-log/${filename}`);
    uploadedToS3 = true;
  }

  // ── Local path ──────────────────────────────────────────────────
  if (mode === 'local' || mode === 'both') {
    const backupDir = path.join(__dirname, '../../backups/s3-mock');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(backupDir, filename);
    fs.writeFileSync(backupPath, body, 'utf8');
    console.log(`📁 Audit logs backed up locally: backups/s3-mock/${filename}`);
    writtenLocally = true;
  }

  // ── Mark archived ──────────────────────────────────────────────
  await query(
    'UPDATE audit_log SET archived_at = NOW() WHERE id <= $1 AND archived_at IS NULL',
    [maxId],
  );
  console.log(`✅ Marked ${rows.length} audit log row(s) as archived in DB.`);

  return {
    mode,
    rowsArchived: rows.length,
    uploadedToS3,
    writtenLocally,
    filename,
  };
}

let backupInterval: NodeJS.Timeout | null = null;

/**
 * Start the periodic audit backup worker.
 *
 * Runs an initial check immediately, then on the interval. If the
 * table assertion fails on startup, the worker logs the FATAL and
 * does NOT start the interval — the operator must fix the DB before
 * archival can resume.
 */
export function startAuditBackupWorker(intervalMs: number = 3_600_000): void {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }

  // First-tick assertion: if the table is missing, refuse to start.
  backupAuditLogs()
    .then((r) => {
      console.log(
        `⏰ Audit log backup worker started (interval: ${intervalMs / 1000}s, mode: ${r.mode}).`,
      );
      backupInterval = setInterval(() => {
        backupAuditLogs().catch((err) => {
          console.error('❌ Audit log backup tick failed:', err);
        });
      }, intervalMs);
    })
    .catch((err) => {
      console.error(
        '❌ Audit log backup worker FAILED TO START:',
        err.message,
      );
      // Do not schedule the interval. The operator must restart after
      // fixing the database / BACKUP_MODE / AWS credentials.
    });
}

/**
 * Stop the periodic audit backup worker.
 */
export function stopAuditBackupWorker(): void {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
    console.log('⏰ Audit log backup worker stopped.');
  }
}
