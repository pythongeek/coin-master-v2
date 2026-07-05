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

const router = Router();

// All routes are admin-only
router.use(authMiddleware);
router.use(adminMiddleware);

// ── GET /api/admin/withdrawals ─────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) ?? 'pending';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const validStatuses = ['pending', 'confirmed', 'failed', 'cancelled'];
    if (!validStatuses.includes(status) && status !== 'all') {
      return res.status(400).json({ success: false, error: 'invalid status' });
    }
    const params: unknown[] = [];
    let where = '';
    if (status !== 'all') {
      where = 'WHERE t.status = $1';
      params.push(status);
    }
    params.push(limit);
    const r = await query(
      `SELECT t.id, t.user_id, t.amount, t.currency, t.direction, t.status,
              t.metadata, t.created_at, t.confirmed_at,
              u.username, u.email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       ${where}
       ${status === 'all' ? '' : ''}
       AND t.type = 'withdrawal'
       ORDER BY t.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ success: true, status, withdrawals: r.rows });
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
    const result = await approveWithdrawal(id, admin.userId);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: 'withdrawal not found or already processed' });
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
    const result = await rejectWithdrawal(id, admin.userId, reason);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: 'withdrawal not found or already processed' });
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