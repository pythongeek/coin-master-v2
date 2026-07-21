/**
 * P3-5 — Admin endpoints for the Daily Fraud Report digest.
 *
 *   GET    /api/admin/fraud/reports
 *     History list (last N days).
 *
 *   GET    /api/admin/fraud/reports/preview?report_date=YYYY-MM-DD
 *     Render the digest payload without queueing the email. Useful
 *     for the admin UI to show what would be sent.
 *
 *   POST   /api/admin/fraud/reports/send-now
 *     Body: { force?: bool, recipient?: string, report_date?: string }
 *     Force-send a digest. force=true bypasses the idem-potency
 *     check (re-sends the same day) and the quiet-day threshold.
 *
 *   POST   /api/admin/fraud/reports/settings
 *     Body: { enabled?: bool, recipient?: string, send_hour_utc?: int,
 *             min_signals?: int }
 *     Update the admin_settings rows that drive the cron. All
 *     fields are optional — pass only what you want to change.
 *
 * Auth: authMiddleware + roleMiddleware(['super_admin']) on every
 * endpoint. Matches the canonical /api/admin pattern.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { query } from '../config/database';
import { setAdminSetting } from '../services/admin-settings.service';
import {
  sendDailyReport,
  listRecentDigests,
  previewDailyReport,
} from '../services/daily-fraud-report';

const router = Router();
router.use(authMiddleware, roleMiddleware(['super_admin']));

// ── GET /reports ──────────────────────────────────────────────
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30)));
    const data = await listRecentDigests(limit);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /reports/preview ──────────────────────────────────────
router.get('/reports/preview', async (req: Request, res: Response) => {
  try {
    const reportDate = typeof req.query.report_date === 'string' ? req.query.report_date : undefined;
    const data = await previewDailyReport(reportDate);
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── POST /reports/send-now ────────────────────────────────────
router.post('/reports/send-now', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      force?: boolean;
      recipient?: string;
      report_date?: string;
    };
    const data = await sendDailyReport({
      force: !!body.force,
      recipient: body.recipient,
      reportDate: body.report_date,
      reportKind: 'on_demand',
    });
    // Always 200 — the action was processed. The `data.sent` flag
    // tells the caller whether the email actually went out (false
    // when SMTP is disabled, etc.). The `data.reason` explains.
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── POST /reports/settings ────────────────────────────────────
router.post('/reports/settings', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      recipient?: string;
      send_hour_utc?: number;
      min_signals?: number;
    };
    const updates: Array<{ key: string; value: string; desc: string }> = [];
    if (typeof body.enabled === 'boolean') {
      updates.push({ key: 'daily_fraud_report_enabled', value: body.enabled ? 'true' : 'false',
        desc: 'Master switch for the 08:00 UTC daily fraud digest cron.' });
    }
    if (typeof body.recipient === 'string' && body.recipient.includes('@')) {
      updates.push({ key: 'daily_fraud_report_recipient', value: body.recipient.trim(),
        desc: 'Recipient address for the daily fraud digest.' });
    }
    if (typeof body.send_hour_utc === 'number'
        && Number.isInteger(body.send_hour_utc)
        && body.send_hour_utc >= 0 && body.send_hour_utc <= 23) {
      updates.push({ key: 'daily_fraud_report_send_hour_utc', value: String(body.send_hour_utc),
        desc: 'Hour of day (UTC, 0..23) to fire the daily digest.' });
    }
    if (typeof body.min_signals === 'number'
        && Number.isInteger(body.min_signals)
        && body.min_signals >= 0) {
      updates.push({ key: 'daily_fraud_report_min_signals', value: String(body.min_signals),
        desc: 'Minimum new fraud_signals in 24h before a digest is sent.' });
    }
    for (const u of updates) {
      await setAdminSetting(u.key, u.value, u.desc);
    }
    // Audit row
    const user = (req as Request & { user?: { userId?: string } }).user;
    if (user?.userId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'fraud.report_settings.update', 'info', $1::uuid, $2::jsonb)`,
        [user.userId, JSON.stringify(updates.map((u) => ({ key: u.key, value: u.value })))],
      );
    }
    res.json({ success: true, updated: updates.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /reports/settings (helper: read current values) ──────
router.get('/reports/settings', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT key, value, description FROM admin_settings
        WHERE key IN (
          'daily_fraud_report_enabled',
          'daily_fraud_report_recipient',
          'daily_fraud_report_send_hour_utc',
          'daily_fraud_report_min_signals'
        )`,
    );
    const data = r.rows.reduce<Record<string, string>>((acc, row) => {
      const r2 = row as { key: string; value: string };
      acc[r2.key] = r2.value;
      return acc;
    }, {});
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;