/**
 * =============================================================
 *  ADMIN EMAIL ROUTES - manage recipients + templates + queue
 * =============================================================
 *
 *  Mounted under /api/admin/email (super_admin only)
 *
 *  Endpoints:
 *    GET    /api/admin/email/recipients      - list admin email recipients
 *    POST   /api/admin/email/recipients      - add new recipient
 *    PATCH  /api/admin/email/recipients/:id  - update toggles or enabled
 *    DELETE /api/admin/email/recipients/:id  - remove recipient
 *
 *    GET    /api/admin/email/templates       - list event templates
 *    PATCH  /api/admin/email/templates/:event - update subject/body/toggle
 *    POST   /api/admin/email/templates/:event/preview
 *                                            - render template with sample data
 *
 *    GET    /api/admin/email/queue           - list email_queue (filter status)
 *    POST   /api/admin/email/queue/:id/retry - force retry of a failed row
 *
 *    POST   /api/admin/email/test            - send a test email to self
 *
 *    GET    /api/admin/email/smtp-status     - check SMTP connectivity
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { query } from '../config/database';
import {
  renderTemplate,
  drainEmailQueue,
  getSmtpConfig,
} from '../services/notification.service';
import nodemailer from 'nodemailer';

const router = Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// =============================================================
//  RECIPIENTS
// =============================================================

router.get('/recipients', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT id, email, display_name, role, is_enabled,
              notify_deposit_credited, notify_withdrawal_critical, notify_withdrawal_held,
              notify_withdrawal_rejected, notify_withdrawal_approved,
              notify_user_kyc_approved, notify_system_error,
              notes, created_at, updated_at
       FROM admin_email_config
       ORDER BY email ASC`
    );
    res.json({ success: true, recipients: r.rows });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/recipients', async (req: Request, res: Response) => {
  try {
    const { email, display_name, role, is_enabled, notes, toggles } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email required' });
    }
    // Build toggle columns dynamically from toggles object
    const toggleCols = [
      'notify_deposit_credited', 'notify_withdrawal_critical', 'notify_withdrawal_held',
      'notify_withdrawal_rejected', 'notify_withdrawal_approved',
      'notify_user_kyc_approved', 'notify_system_error',
    ];
    const sets: string[] = ['email', 'display_name', 'role', 'is_enabled', 'notes'];
    const vals: unknown[] = [email, display_name || null, role || 'admin', is_enabled !== false, notes || null];
    let idx = 1;
    if (toggles && typeof toggles === 'object') {
      for (const col of toggleCols) {
        if (col in toggles) {
          sets.push(col);
          vals.push(!!toggles[col]);
        }
      }
    }
    const cols = sets.map((c) => c + ' ($' + (++idx) + ')').join(', ');
    // Re-build with proper numbering
    const cols2: string[] = [];
    const vals2: unknown[] = [];
    let i = 1;
    const items: [string, unknown][] = [
      ['email', email],
      ['display_name', display_name || null],
      ['role', role || 'admin'],
      ['is_enabled', is_enabled !== false],
      ['notes', notes || null],
    ];
    if (toggles && typeof toggles === 'object') {
      for (const col of toggleCols) {
        if (col in toggles) items.push([col, !!toggles[col]]);
      }
    }
    for (const [col, val] of items) {
      cols2.push(col);
      vals2.push(val);
    }
    // Build parameterized placeholders $1..$N
    const placeholders = vals2.map((_v, j) => '$' + (j + 1)).join(', ');
    const r = await query(
      `INSERT INTO admin_email_config (${cols2.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals2
    );
    res.json({ success: true, recipient: r.rows[0] });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes('duplicate key')) {
      return res.status(409).json({ success: false, error: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: m });
  }
});

router.patch('/recipients/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const body = req.body || {};
    const allowed = ['display_name', 'role', 'is_enabled', 'notes',
      'notify_deposit_credited', 'notify_withdrawal_critical', 'notify_withdrawal_held',
      'notify_withdrawal_rejected', 'notify_withdrawal_approved',
      'notify_user_kyc_approved', 'notify_system_error',
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 0;
    for (const key of allowed) {
      if (key in body) {
        vals.push(body[key]);
        sets.push(key + ' = $' + (++i));
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    vals.push(id);
    const r = await query(
      `UPDATE admin_email_config SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${i + 1} RETURNING *`,
      vals
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Recipient not found' });
    }
    res.json({ success: true, recipient: r.rows[0] });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/recipients/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const r = await query(`DELETE FROM admin_email_config WHERE id = $1`, [id]);
    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Recipient not found' });
    }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  TEMPLATES
// =============================================================

router.get('/templates', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT id, event_type, display_name, subject_template, body_html_template, body_text_template,
              is_enabled, available_variables, updated_at
       FROM admin_email_templates ORDER BY event_type`
    );
    res.json({ success: true, templates: r.rows });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch('/templates/:event', async (req: Request, res: Response) => {
  try {
    const event = String(req.params.event);
    const body = req.body || {};
    const allowed = ['display_name', 'subject_template', 'body_html_template', 'body_text_template', 'is_enabled'];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of allowed) {
      if (key in body) {
        vals.push(body[key]);
        sets.push(key + ' = $' + vals.length);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    vals.push(event);
    const r = await query(
      `UPDATE admin_email_templates SET ${sets.join(', ')}, updated_at = NOW()
       WHERE event_type = $${vals.length} RETURNING *`,
      vals
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    res.json({ success: true, template: r.rows[0] });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Preview template with sample data
router.post('/templates/:event/preview', async (req: Request, res: Response) => {
  try {
    const event = String(req.params.event);
    const context = req.body?.context || {};
    const r = await query(
      `SELECT subject_template, body_html_template, body_text_template FROM admin_email_templates
       WHERE event_type = $1`,
      [event]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    const tpl = r.rows[0];
    res.json({
      success: true,
      preview: {
        subject: renderTemplate(tpl.subject_template, context),
        body_html: renderTemplate(tpl.body_html_template, context),
        body_text: renderTemplate(tpl.body_text_template, context),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  QUEUE
// =============================================================

router.get('/queue', async (req: Request, res: Response) => {
  try {
    const status = String(req.query.status || 'all');
    const event = String(req.query.event || '');
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
    const conds: string[] = [];
    const params: unknown[] = [];
    let i = 0;
    if (status !== 'all') {
      conds.push('status = $' + (++i));
      params.push(status);
    }
    if (event) {
      conds.push('event_type = $' + (++i));
      params.push(event);
    }
    const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(limit);
    // limit is the last parameter, so its placeholder index is i + 1
    const limitPlaceholder = '$' + (i + 1);
    const r = await query(
      `SELECT id, recipient, recipient_kind, event_type, subject,
              status, attempts, max_attempts, last_error,
              last_attempt_at, next_attempt_at, sent_at, created_at
       FROM email_queue ${where}
       ORDER BY created_at DESC
       LIMIT ${limitPlaceholder}::int`,
      params
    );
    const stats = await query(
      `SELECT status, COUNT(*)::int AS count FROM email_queue GROUP BY status`
    );
    res.json({ success: true, queue: r.rows, stats: stats.rows });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/queue/:id/retry', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const r = await query(
      `UPDATE email_queue SET status = 'pending', next_attempt_at = NOW(),
         attempts = 0, last_error = NULL
       WHERE id = $1 RETURNING id, status`,
      [id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Queue row not found' });
    }
    // Try draining immediately so the user sees feedback fast
    drainEmailQueue().catch(() => { /* silent */ });
    res.json({ success: true, id: r.rows[0].id, status: r.rows[0].status });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Manual drain trigger
router.post('/queue/drain', async (_req: Request, res: Response) => {
  try {
    const stats = await drainEmailQueue();
    res.json({ success: true, ...stats });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  TEST EMAIL + SMTP STATUS
// =============================================================

router.post('/test', async (req: Request, res: Response) => {
  try {
    const recipient = String(req.body?.recipient || '');
    if (!recipient.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid recipient email required' });
    }
    // Use a simple inline template - bypasses admin_email_config gates
    const cfg = getSmtpConfig();
    if (!cfg) {
      return res.status(400).json({ success: false, error: 'SMTP not configured (set SMTP_HOST in .env)' });
    }
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
      tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTH !== 'false' },
    });
    await transport.sendMail({
      from: cfg.fromName + ' <' + cfg.fromAddress + '>',
      to: recipient,
      subject: 'CryptoFlip admin - test email',
      text: 'This is a test email from the CryptoFlip admin panel.\n\nIf you received this, SMTP is working correctly.\n\nTimestamp: ' + new Date().toISOString(),
      html: '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#22c55e">Test email OK</h1><p>SMTP is working correctly. Sent from CryptoFlip admin panel.</p><p style="color:#888;font-size:12px">' + new Date().toISOString() + '</p></div>',
    });
    res.json({ success: true, sent: true, recipient });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/smtp-status', async (_req: Request, res: Response) => {
  try {
    const cfg = getSmtpConfig();
    if (!cfg) {
      return res.json({ success: true, configured: false, message: 'SMTP_HOST not set - emails will queue but not send' });
    }
    res.json({
      success: true,
      configured: true,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      fromAddress: cfg.fromAddress,
      fromName: cfg.fromName,
      auth: cfg.user ? 'configured' : 'none',
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
