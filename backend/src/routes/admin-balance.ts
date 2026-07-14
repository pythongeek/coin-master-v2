/**
 * =============================================================
 *  ADMIN BALANCE ADJUSTMENT ROUTES
 * =============================================================
 *
 *  Endpoints:
 *    GET  /api/admin/balance/users/:userId/balances   - list user's wallets (for picker)
 *    POST /api/admin/balance/credit                    - credit coins
 *    POST /api/admin/balance/deduct                    - deduct coins
 *    GET  /api/admin/balance/history                   - paginated audit trail
 *
 *  All require super_admin role. All writes audit-logged.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { roleMiddleware } from '../middleware/auth';
import {
  adjustUserBalance,
  getUserBalances,
  getAdjustmentHistory,
  AdjustmentError,
  AdjustmentDirection,
  AdjustmentCategory,
} from '../services/admin-adjustment.service';

const router = Router();

interface AuthRequest extends Request {
  user?: AuthPayload;
}

router.use(authMiddleware, roleMiddleware(['super_admin']));

// =============================================================================
//  GET /api/admin/balance/users/:userId/balances
//  Returns all wallet balances for a user (so admin can pick which to adjust).
// =============================================================================
router.get('/users/:userId/balances', async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.userId || '');
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    const balances = await getUserBalances(userId);
    res.json({ success: true, userId, balances });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  POST /api/admin/balance/credit
//  Body: { userId, walletId, amount, reason, category? }
// =============================================================================
router.post('/credit', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as {
      userId?: string;
      walletId?: string;
      amount?: number;
      reason?: string;
      category?: AdjustmentCategory;
    };
    if (!body.userId || !body.walletId || !body.amount || !body.reason) {
      return res.status(400).json({
        success: false,
        error: 'userId, walletId, amount, and reason are required',
      });
    }
    const result = await adjustUserBalance({
      userId: body.userId,
      walletId: body.walletId,
      direction: 'credit',
      amount: body.amount,
      reason: body.reason,
      category: body.category,
      adminId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.json({ success: true, result });
  } catch (err: unknown) {
    if (err instanceof AdjustmentError) {
      const status = err.code === 'WALLET_NOT_FOUND' || err.code === 'USER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, error: err.message, code: err.code });
    }
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  POST /api/admin/balance/deduct
//  Body: { userId, walletId, amount, reason, category? }
// =============================================================================
router.post('/deduct', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as {
      userId?: string;
      walletId?: string;
      amount?: number;
      reason?: string;
      category?: AdjustmentCategory;
    };
    if (!body.userId || !body.walletId || !body.amount || !body.reason) {
      return res.status(400).json({
        success: false,
        error: 'userId, walletId, amount, and reason are required',
      });
    }
    const result = await adjustUserBalance({
      userId: body.userId,
      walletId: body.walletId,
      direction: 'debit',
      amount: body.amount,
      reason: body.reason,
      category: body.category,
      adminId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.json({ success: true, result });
  } catch (err: unknown) {
    if (err instanceof AdjustmentError) {
      const status = err.code === 'WALLET_NOT_FOUND' || err.code === 'USER_NOT_FOUND'
        || err.code === 'INSUFFICIENT_BALANCE' ? 404 : 400;
      return res.status(status).json({ success: false, error: err.message, code: err.code });
    }
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  GET /api/admin/balance/history
//  Paginated audit trail with filters.
// =============================================================================
router.get('/history', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const adminId = req.query.adminId as string | undefined;
    const direction = req.query.direction as AdjustmentDirection | undefined;
    const category = req.query.category as AdjustmentCategory | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const result = await getAdjustmentHistory({ userId, adminId, direction, category, limit, offset });
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

export default router;