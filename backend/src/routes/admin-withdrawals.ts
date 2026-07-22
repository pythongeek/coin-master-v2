/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN WITHDRAWAL ROUTES — /api/admin/withdrawals
 * ═══════════════════════════════════════════════════════════════
 *
 *  Session 1 of roadmap-2026.md — admin queue for approving/rejecting
 *  user withdrawal requests.
 *
 *  All routes require admin role (mounted under app.use('/api/admin',
 *  with authMiddleware + adminMiddleware applied).
 *
 *  Mounted in index.ts BEFORE the catch-all admin router (so the more
 *  specific /api/admin/withdrawals path matches before /api/admin).
 *
 *  Endpoints:
 *    GET    /api/admin/withdrawals           → list (filter by ?status=pending)
 *    POST   /api/admin/withdrawals/:id/approve → mark confirmed + audit
 *    POST   /api/admin/withdrawals/:id/reject  → mark failed + refund user
 *    GET    /api/admin/withdrawals/stats     → aggregates (volume by day, pending count)
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware, AuthPayload } from '../middleware/auth';
import {
  approveWithdrawal, rejectWithdrawal, expireBonuses,
} from '../services/bonus';
import { query } from '../config/database';
import { scoreWithdrawalRisk, scoreWithdrawalsBatch } from '../services/withdrawal-risk.service';
import { queueAdminEmail, queueEmail } from '../services/notification.service';
import { coinsToCurrency } from '../services/rate-fetcher';

const router = Router();

// All routes are admin-only
router.use(authMiddleware);
router.use(adminMiddleware);

// ── GET /api/admin/withdrawals ─────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) ?? 'pending';
    const minRisk = (req.query.minRisk as string) ?? null; // 'low'|'medium'|'high'|'critical'
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const validStatuses = ['pending', 'confirmed', 'failed', 'cancelled'];
    if (!validStatuses.includes(status) && status !== 'all') {
      return res.status(400).json({ success: false, error: 'invalid status' });
    }
    const params: unknown[] = [];
    const conditions: string[] = ["t.type = 'withdrawal'"];
    let pIdx = 1;
    if (status !== 'all') {
      conditions.push(`t.status = $${pIdx++}`);
      params.push(status);
    }
    params.push(limit);
    const where = 'WHERE ' + conditions.join(' AND ');
    const r = await query(
      `SELECT t.id, t.user_id, t.amount, t.currency, t.direction, t.status,
              t.metadata, t.created_at, t.completed_at,
              t.ip_address, t.user_agent,
              u.username, u.email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${pIdx}`,
      params,
    );

    // Score each withdrawal in parallel (capped concurrency)
    const rows = r.rows as any[];
    const riskMap = await scoreWithdrawalsBatch(rows);

    // Optional filter by minimum risk level
    const levelOrder: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const minLevelIdx = minRisk ? (levelOrder[minRisk] ?? -1) : -1;

    // Fetch rates once for the whole batch (cached for 5 min)
    const { getAllCoinRates } = await import('../services/rate-fetcher');
    const allRates = await getAllCoinRates();
    const enriched = rows.map((row) => {
      const risk = riskMap.get(row.id);
      if (minLevelIdx >= 0 && (!risk || levelOrder[risk.level] < minLevelIdx)) return null;
      const amt = parseFloat(String(row.amount));
      return {
        ...row,
        risk,
        equivalent: {
          usdt: parseFloat(amt.toFixed(8)),
          usd:  parseFloat((amt * allRates.USD).toFixed(8)),
          bdt:  parseFloat((amt * allRates.BDT).toFixed(2)),
        },
      };
    }).filter(Boolean);

    res.json({ success: true, status, withdrawals: enriched });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/admin/withdrawals/:id - full detail + risk signals
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const r = await query(
      `SELECT t.id, t.user_id, t.amount, t.currency, t.direction, t.status,
              t.metadata, t.created_at, t.completed_at,
              t.ip_address, t.user_agent,
              u.username, u.email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.type = 'withdrawal'`,
      [id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'withdrawal not found' });
    }
    const row = r.rows[0] as any;
    const risk = await scoreWithdrawalRisk(row);
    const { getAllCoinRates } = await import('../services/rate-fetcher');
    const allRates = await getAllCoinRates();
    const amt = parseFloat(String(row.amount));
    const equivalent = {
      usdt: parseFloat(amt.toFixed(8)),
      usd:  parseFloat((amt * allRates.USD).toFixed(8)),
      bdt:  parseFloat((amt * allRates.BDT).toFixed(2)),
    };

    // Fire admin alerts based on risk level (idempotent - rate-limit guards)
    // Get admin URL for the email link
    const adminBase = process.env.ADMIN_PANEL_URL || 'http://46.62.247.167:3002';
    const adminUrl = `${adminBase}/api/admin/withdrawals/${row.id}`;
    if (risk.level === 'critical' || risk.level === 'high') {
      queueAdminEmail({
        event_type: 'withdrawal.critical',
        user_id: row.user_id,
        context: {
          withdrawal_id: row.id,
          username: row.username || row.user_id,
          user_email: row.email || '',
          amount_usdt: amt.toFixed(2),
          amount_usd: equivalent.usd.toFixed(2),
          amount_bdt: equivalent.bdt.toFixed(2),
          ip_address: row.ip_address || 'unknown',
          risk_score: risk.score,
          risk_level: risk.level,
          risk_suggestion: risk.suggestion,
          risk_reasons: risk.reasons.map((r: string) => `- ${r}`).join('\n'),
          created_at: row.created_at,
          admin_url: adminUrl,
        },
      }).catch(() => { /* silent */ });
    } else if (risk.level === 'medium') {
      queueAdminEmail({
        event_type: 'withdrawal.held',
        user_id: row.user_id,
        context: {
          withdrawal_id: row.id,
          username: row.username || row.user_id,
          amount_usdt: amt.toFixed(2),
          amount_usd: equivalent.usd.toFixed(2),
          risk_score: risk.score,
          risk_level: risk.level,
          admin_url: adminUrl,
        },
      }).catch(() => { /* silent */ });
    }

    res.json({ success: true, withdrawal: row, risk, equivalent });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/admin/withdrawals/:id/approve ────────────────────
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { user: AuthPayload }).user;
    const id = String(req.params.id);
    // Look up user + amount for the confirmation email before approving
    const wr = await query(
      `SELECT t.id, t.amount, t.user_id, u.email, u.username
       FROM transactions t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.type = 'withdrawal'`,
      [id]
    );
    const result = await approveWithdrawal(id, admin.userId);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: 'withdrawal not found or already processed' });
    }
    // Queue confirmation email to user (silent if no email)
    if (wr.rows.length > 0 && wr.rows[0].email) {
      const amt = parseFloat(String(wr.rows[0].amount));
      queueEmail({
        recipient: wr.rows[0].email,
        recipient_kind: 'user',
        user_id: wr.rows[0].user_id,
        event_type: 'withdrawal.approved',
        context: { amount_usdt: amt.toFixed(2), withdrawal_id: id },
      }).catch(() => { /* silent */ });
    }
    res.json({ success: true, withdrawalId: id, status: 'confirmed' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/admin/withdrawals/:id/reject ─────────────────────
// body: { reason: string } — required
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { user: AuthPayload }).user;
    const id = String(req.params.id);
    const reason = (req.body?.reason ?? '').toString().trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'rejection reason required' });
    }
    const wr = await query(
      `SELECT t.id, t.amount, t.user_id, u.email, u.username
       FROM transactions t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.type = 'withdrawal'`,
      [id]
    );
    const result = await rejectWithdrawal(id, admin.userId, reason);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: 'withdrawal not found or already processed' });
    }
    if (wr.rows.length > 0 && wr.rows[0].email) {
      const amt = parseFloat(String(wr.rows[0].amount));
      queueEmail({
        recipient: wr.rows[0].email,
        recipient_kind: 'user',
        user_id: wr.rows[0].user_id,
        event_type: 'withdrawal.rejected',
        context: { amount_usdt: amt.toFixed(2), reason },
      }).catch(() => { /* silent */ });
    }
    res.json({
      success: true,
      withdrawalId: id,
      status: 'failed',
      refundedCoins: result.refundedCoins,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/admin/withdrawals/stats ──────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                       AS pending,
         COUNT(*) FILTER (WHERE status = 'confirmed')                      AS confirmed,
         COUNT(*) FILTER (WHERE status = 'failed')                         AS failed,
         COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0)      AS total_confirmed,
         COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)        AS total_pending,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))   AS today_total
       FROM transactions WHERE type = 'withdrawal'`,
    );
    res.json({ success: true, stats: r.rows[0] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/admin/withdrawals/cron/expire-bonuses ────────────
// Manual trigger of bonus expiry cron (in production this runs via cron job)
router.post('/cron/expire-bonuses', async (_req: Request, res: Response) => {
  try {
    const result = await expireBonuses();
    res.json({
      success: true,
      expiredCount: result.expiredCount,
      message: `${result.expiredCount} টি বোনাসের মেয়াদ শেষ হয়েছে।`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;