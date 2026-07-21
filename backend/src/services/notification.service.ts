/**
 * =============================================================
 *  NOTIFICATION SERVICE - email queue + SMTP worker
 * =============================================================
 *
 *  Two responsibilities:
 *    1. queueEmail()       - write a row to email_queue (sync, fast)
 *    2. drainEmailQueue()  - background loop (every 10s) that sends pending
 *
 *  Design:
 *    - SMTP latency MUST NEVER block HTTP requests - that's why we queue.
 *    - Retry with exponential backoff: 30s, 2m, 10m, 1h
 *    - Max 4 attempts; permanent failure after that
 *    - Rate limit: 1 email per (recipient, event_type) per 60s (prevents flooding
 *      in case of a bug or attack)
 *    - Graceful: if SMTP_HOST is unset, marks rows failed with last_error='smtp_disabled'
 *      so admin can see in queue viewer that it's not actually sending
 *
 *  Variables in templates:
 *    subject_template and body_*_template use {{var_name}} which is replaced
 *    by the context_json values at send time.
 *
 *  How it gets called:
 *    - binance-pay-ledger-monitor.service.ts: AUTO_CREDIT path -> queueEmail
 *    - admin-withdrawals.ts: POST /:id/approve and /:id/reject -> queueEmail
 *    - admin-payments-qr.ts: AUTO_CREDIT path -> queueEmail
 *    - withdrawal-risk.service.ts (after scoring) -> queueEmail for critical/held
 *    - The withdrawal scorer does NOT queue email directly; the routes do after action.
 *
 *  Adding new event types:
 *    1. INSERT a row into admin_email_templates with event_type + templates
 *    2. Call queueEmail({ event_type: 'your.event', ...context })
 *    3. Done - admin can edit template + toggle recipients via admin UI
 */

import nodemailer from 'nodemailer';
import { query } from '../config/database';

// =============================================================
//  SMTP transport (lazy - only created when needed)
// =============================================================

let cachedTransport: nodemailer.Transporter | null = null;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  fromAddress: string;
  fromName: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST || '';
  if (!host) return null;  // SMTP not configured
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return {
    host,
    port,
    secure: port === 465,    // SMTPS for 465, STARTTLS otherwise
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    fromAddress: process.env.SMTP_FROM || 'noreply@cryptoflip.local',
    fromName: process.env.SMTP_FROM_NAME || 'CryptoFlip',
  };
}

function getTransport(): nodemailer.Transporter | null {
  if (cachedTransport) return cachedTransport;
  const cfg = getSmtpConfig();
  if (!cfg) return null;
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: {
      // Self-signed cert OK for local MailHog; strict in prod
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTH !== 'false',
    },
  });
  return cachedTransport;
}

// =============================================================
//  Template rendering (handle {{var}} + missing/null values)
// =============================================================

export function renderTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const val = context[key];
    if (val === undefined || val === null || val === '') return '[n/a]';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

// =============================================================
//  queueEmail - sync write to email_queue
// =============================================================

export interface QueueEmailInput {
  recipient: string;
  recipient_kind?: 'admin' | 'user';
  user_id?: string | null;
  event_type: string;
  context: Record<string, any>;
  subject_override?: string;
}

export interface QueueEmailResult {
  queued: boolean;
  reason?: string;
  queueId?: number;
}

/**
 * Queue an email for async sending. Returns immediately.
 * Skips silently if:
 *   - event_type is disabled in admin_email_templates (is_enabled=false)
 *   - rate-limited (same recipient + event_type in last 60s)
 *   - admin_email_config for this recipient has the event toggle off (admin kind only)
 */
export async function queueEmail(input: QueueEmailInput): Promise<QueueEmailResult> {
  try {
    // 1. Load template (English by default; pull BN columns + user pref to switch)
    let language: 'en' | 'bn' = 'en';
    if (input.user_id) {
      const langRow = await query(
        `SELECT preferred_language FROM users WHERE id = $1`,
        [input.user_id]
      );
      if (langRow.rows[0]?.preferred_language === 'bn') language = 'bn';
    }
    const tplRow = await query(
      `SELECT subject_template, body_html_template, body_text_template, is_enabled,
              subject_bn, body_html_bn, body_text_bn
       FROM admin_email_templates WHERE event_type = $1`,
      [input.event_type]
    );
    if (tplRow.rows.length === 0) {
      // No template registered - silently skip (don't break flow)
      return { queued: false, reason: 'no template registered' };
    }
    const tpl = tplRow.rows[0];
    if (!tpl.is_enabled) {
      return { queued: false, reason: 'event type disabled' };
    }

    // 2. For admin recipients, check the recipient config + per-event toggle
    if (input.recipient_kind === 'admin' || !input.recipient_kind) {
      const cfgRow = await query(
        `SELECT * FROM admin_email_config WHERE email = $1 AND is_enabled = true`,
        [input.recipient]
      );
      if (cfgRow.rows.length === 0) {
        // No admin config for this recipient - silently skip
        return { queued: false, reason: 'recipient not configured' };
      }
      const cfg = cfgRow.rows[0];
      const toggleCol = 'notify_' + input.event_type.replace(/\./g, '_');
      if (toggleCol in cfg && !cfg[toggleCol]) {
        return { queued: false, reason: 'recipient opted out of this event' };
      }
    }

    // 3. Rate limit: 1 email per (recipient, event_type) per 60s
    const rateRow = await query(
      `SELECT COUNT(*)::int AS c FROM email_queue
       WHERE recipient = $1 AND event_type = $2
         AND created_at >= NOW() - INTERVAL '60 seconds'`,
      [input.recipient, input.event_type]
    );
    if (rateRow.rows[0].c > 0) {
      return { queued: false, reason: 'rate limited (1 per 60s)' };
    }

    // 4. Render templates (BN version if language=bn AND bn fields exist, else fallback to EN)
    const useBn = language === 'bn' && tpl.subject_bn && tpl.body_text_bn;
    const subject = input.subject_override || renderTemplate(useBn ? tpl.subject_bn : tpl.subject_template, input.context);
    const bodyHtml = renderTemplate(useBn ? tpl.body_html_bn : tpl.body_html_template, input.context);
    const bodyText = renderTemplate(useBn ? tpl.body_text_bn : tpl.body_text_template, input.context);

    // 5. Insert into queue
    const r = await query(
      `INSERT INTO email_queue
        (recipient, recipient_kind, user_id, event_type, subject, body_html, body_text, context_json, next_attempt_at)
       VALUES ($1, $2::varchar(20), $3::uuid, $4, $5, $6, $7, $8::jsonb, NOW())
       RETURNING id`,
      [
        input.recipient,
        input.recipient_kind || 'admin',    // P3-5 fix: cast in SQL below; the literal is text by default
        input.user_id || null,
        input.event_type,
        subject,
        bodyHtml,
        bodyText,
        JSON.stringify(input.context),
      ]
    );
    // Force the recipient_kind parameter type to match the column
    // (varchar(20)). Without this explicit cast, Postgres infers the
    // first argument ('admin') as text and the parameter as varchar,
    // returning "inconsistent types deduced for parameter $2".
    // See daily-fraud-report.ts P3-5 verification on a live stack.
    return { queued: true, queueId: r.rows[0].id };
  } catch (err: unknown) {
    // Never fail the calling code path because of an email problem
    const m = err instanceof Error ? err.message : String(err);
    console.error('[notify] queueEmail failed (silent):', m);
    return { queued: false, reason: m };
  }
}

/**
 * Convenience: queue email to ALL enabled admin recipients who have toggled on this event.
 * Skips per-recipient rate limiting (uses one queue row per recipient).
 */
export async function queueAdminEmail(input: Omit<QueueEmailInput, 'recipient' | 'recipient_kind'> & { recipient_kind?: 'admin' }): Promise<QueueEmailResult[]> {
  const recipients = await query(
    `SELECT email FROM admin_email_config WHERE is_enabled = true`
  );
  const results: QueueEmailResult[] = [];
  for (const r of recipients.rows) {
    const result = await queueEmail({
      ...input,
      recipient: r.email,
      recipient_kind: 'admin',
    });
    results.push(result);
  }
  return results;
}

// =============================================================
//  drainEmailQueue - background worker, called every 10s
// =============================================================

const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];  // 30s, 2m, 10m, 1h

/**
 * Pick up pending emails from the queue, send via SMTP, update status.
 * Safe to call concurrently (uses SELECT ... FOR UPDATE SKIP LOCKED).
 */
export async function drainEmailQueue(): Promise<{ sent: number; failed: number; skipped: number }> {
  const transport = getTransport();
  const stats = { sent: 0, failed: 0, skipped: 0 };

  // Load pending rows (cap at 20 per tick to avoid stampede)
  let pending;
  try {
    pending = await query(
      `SELECT id, recipient, subject, body_text, body_html, attempts, max_attempts
       FROM email_queue
       WHERE status IN ('pending', 'failed')
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC
       LIMIT 20
       FOR UPDATE SKIP LOCKED`,
    );
  } catch (err: unknown) {
    console.error('[notify] drainEmailQueue query failed:', err instanceof Error ? err.message : err);
    return stats;
  }

  if (pending.rows.length === 0) return stats;

  for (const row of pending.rows as any[]) {
    // Mark sending
    await query(
      `UPDATE email_queue SET status = 'sending', attempts = attempts + 1, last_attempt_at = NOW()
       WHERE id = $1`,
      [row.id]
    );

    // If SMTP not configured, fail with smtp_disabled
    if (!transport) {
      await query(
        `UPDATE email_queue SET status = 'failed',
            last_error = 'smtp_disabled (set SMTP_HOST in .env)',
            next_attempt_at = NOW() + (INTERVAL '1 hour')
         WHERE id = $1`,
        [row.id]
      );
      stats.skipped += 1;
      continue;
    }

    const cfg = getSmtpConfig()!;
    try {
      await transport.sendMail({
        from: `${cfg.fromName} <${cfg.fromAddress}>`,
        to: row.recipient,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html,
      });
      await query(
        `UPDATE email_queue SET status = 'sent', sent_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [row.id]
      );
      stats.sent += 1;
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      if (attempts >= row.max_attempts) {
        await query(
          `UPDATE email_queue SET status = 'failed', last_error = $1
           WHERE id = $2`,
          [m, row.id]
        );
      } else {
        const backoffIdx = Math.min(attempts - 1, BACKOFF_MS.length - 1);
        await query(
          `UPDATE email_queue SET status = 'pending', last_error = $1,
              next_attempt_at = NOW() + ($2::int || ' milliseconds')::interval
           WHERE id = $3`,
          [m, String(BACKOFF_MS[backoffIdx]), row.id]
        );
      }
      stats.failed += 1;
    }
  }
  return stats;
}

// =============================================================
//  Worker loop - call drainEmailQueue every N seconds
// =============================================================

let workerStarted = false;
let workerTimer: NodeJS.Timeout | null = null;

export function startEmailWorker(intervalMs = 10_000) {
  if (workerStarted) return;
  workerStarted = true;
  console.log(`[notify] email worker started (interval=${intervalMs}ms, smtp=${getSmtpConfig() ? 'configured' : 'disabled'})`);
  const tick = async () => {
    try {
      const stats = await drainEmailQueue();
      if (stats.sent > 0 || stats.failed > 0 || stats.skipped > 0) {
        console.log(`[notify] drain: sent=${stats.sent} failed=${stats.failed} skipped=${stats.skipped}`);
      }
    } catch (err: unknown) {
      console.error('[notify] worker tick error:', err instanceof Error ? err.message : err);
    } finally {
      workerTimer = setTimeout(tick, intervalMs);
    }
  };
  workerTimer = setTimeout(tick, intervalMs);
}

export function stopEmailWorker() {
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  workerStarted = false;
}
