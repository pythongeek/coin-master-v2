import { Router, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { query, db } from '../config/database';
import { invalidateCache } from '../services/cache';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Extend Request type locally
interface AuthRequest extends Request {
  user?: AuthPayload;
}

/**
 * GET /api/wallet/affiliate
 * Get referral code and statistics for the authenticated user
 */
router.get('/affiliate', authMiddleware, async (req: any, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'অননুমোদিত।' });
    }

    const userResult = await query(
      'SELECT referral_code, pending_affiliate_balance, total_affiliate_earned FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const user = userResult.rows[0];

    // Get count and sum of wagers of referee users
    const statsResult = await query(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_wagered), 0) as wagered FROM users WHERE referred_by = $1',
      [userId]
    );

    const stats = statsResult.rows[0];

    res.json({
      success: true,
      referralCode: user.referral_code,
      pendingBalance: parseFloat(user.pending_affiliate_balance || '0'),
      totalEarned: parseFloat(user.total_affiliate_earned || '0'),
      referralsCount: parseInt(stats.count || '0'),
      referralsWagered: parseFloat(stats.wagered || '0'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/wallet/affiliate/claim
 * Transfer pending affiliate balance to main wallet balance
 */
router.post('/affiliate/claim', authMiddleware, async (req: any, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'অননুমোদিত।' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock user row
    const userResult = await client.query(
      'SELECT balance, pending_affiliate_balance FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (!userResult.rows.length) {
      throw new Error('ইউজার পাওয়া যায়নি।');
    }

    const user = userResult.rows[0];
    const pendingBalance = parseFloat(user.pending_affiliate_balance || '0');
    const currentBalance = parseFloat(user.balance || '0');

    if (pendingBalance <= 0) {
      return res.status(400).json({ success: false, error: 'ক্লেইম করার মতো কোনো রেফারেল ব্যালেন্স নেই।' });
    }

    const newBalance = parseFloat((currentBalance + pendingBalance).toFixed(8));

    // Update balances
    await client.query(
      'UPDATE users SET balance = $1, pending_affiliate_balance = 0.00000000, updated_at = NOW() WHERE id = $2',
      [newBalance, userId]
    );

    // Record transaction
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, reference_id, reference_type, completed_at)
       VALUES ($1, $2, NULL, 'affiliate_reward', $3, 'completed', NULL, 'affiliate', NOW())`,
      [txId, userId, pendingBalance]
    );

    await client.query('COMMIT');

    // Invalidate stats/balance cache in Redis
    await invalidateCache([`cache:stats:${userId}`, `balance:${userId}`]).catch(err => {
      console.warn('Cache invalidation failed for claim:', err);
    });

    res.json({
      success: true,
      amount: pendingBalance,
      newBalance,
      message: `🎉 সফলভাবে $${pendingBalance.toFixed(2)} আপনার ওয়ালেটে ক্লেইম করা হয়েছে।`,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  } finally {
    client.release();
  }
});

export default router;
