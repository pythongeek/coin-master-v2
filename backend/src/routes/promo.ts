import { Router, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { query, db } from '../config/database';
import { invalidateCache } from '../services/cache';
import { v4 as uuidv4 } from 'uuid';
import { fraudGuard } from '../middleware/fraud-guard';

const router = Router();

/**
 * GET /api/wallet/promo/active
 * Get any active pending deposit match promo code for the authenticated user
 */
router.get('/promo/active', authMiddleware, async (req: any, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'অননুমোদিত।' });
    }

    const activePromoResult = await query(
      `SELECT pc.code, pc.value, pc.max_bonus_amount 
       FROM user_promos up 
       JOIN promo_codes pc ON up.promo_code_id = pc.id 
       WHERE up.user_id = $1 AND up.status = 'active'`,
      [userId]
    );

    res.json({
      success: true,
      activePromo: activePromoResult.rows.length ? activePromoResult.rows[0] : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/wallet/promo/claim
 * Claim a promo code (instant bonus or pending deposit match activation)
 */
router.post('/promo/claim', authMiddleware, fraudGuard, async (req: any, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'অননুমোদিত।' });
  }

  const { code } = req.body;
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ success: false, error: 'সঠিক প্রোমো কোড প্রদান করুন।' });
  }

  const cleanCode = code.trim().toUpperCase();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Get promo code details
    const promoResult = await client.query(
      `SELECT id, type, value, max_uses, uses_count, max_bonus_amount, expires_at, is_active 
       FROM promo_codes WHERE code = $1 FOR UPDATE`,
      [cleanCode]
    );

    if (!promoResult.rows.length) {
      return res.status(400).json({ success: false, error: 'প্রোমো কোডটি সঠিক নয়।' });
    }

    const promo = promoResult.rows[0];

    // Check active status
    if (!promo.is_active) {
      return res.status(400).json({ success: false, error: 'এই প্রোমো কোডটি বর্তমানে নিষ্ক্রিয়।' });
    }

    // Check expiration
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'এই প্রোমো কোডটির মেয়াদ শেষ হয়ে গেছে।' });
    }

    // Check max uses limit
    if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) {
      return res.status(400).json({ success: false, error: 'এই প্রোমো কোডটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে।' });
    }

    // Check if user already used this promo code
    const userPromoCheck = await client.query(
      'SELECT status FROM user_promos WHERE user_id = $1 AND promo_code_id = $2',
      [userId, promo.id]
    );

    if (userPromoCheck.rows.length) {
      return res.status(400).json({ success: false, error: 'আপনি ইতিমধ্যে এই প্রোমো কোডটি ব্যবহার করেছেন।' });
    }

    if (promo.type === 'no_deposit') {
      // Instant bonus credit
      const userResult = await client.query(
        'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (!userResult.rows.length) {
        throw new Error('ইউজার পাওয়া যায়নি।');
      }

      const currentBalance = parseFloat(userResult.rows[0].balance || '0');
      const bonusAmount = parseFloat(promo.value);
      const newBalance = parseFloat((currentBalance + bonusAmount).toFixed(8));

      // Credit user
      await client.query(
        'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
        [newBalance, userId]
      );

      // Record user_promos claim
      await client.query(
        `INSERT INTO user_promos (user_id, promo_code_id, status, claimed_amount, used_at)
         VALUES ($1, $2, 'claimed', $3, NOW())`,
        [userId, promo.id, bonusAmount]
      );

      // Increment uses count
      await client.query(
        'UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1',
        [promo.id]
      );

      // Record transaction
      const txId = uuidv4();
      await client.query(
        `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, reference_id, reference_type, completed_at)
         VALUES ($1, $2, NULL, 'bonus', $3, 'completed', NULL, 'promo_code', NOW())`,
        [txId, userId, bonusAmount]
      );

      await client.query('COMMIT');

      // Invalidate caches
      await invalidateCache([`cache:stats:${userId}`, `balance:${userId}`]).catch(err => {
        console.warn('Cache invalidation failed for promo claim:', err);
      });

      return res.json({
        success: true,
        type: 'no_deposit',
        amount: bonusAmount,
        newBalance,
        message: `🎉 সফলভাবে $${bonusAmount.toFixed(2)} আপনার ওয়ালেটে ক্লেইম করা হয়েছে।`,
      });

    } else if (promo.type === 'deposit_match') {
      // Check if user has an active deposit match promo active
      const activeMatchCheck = await client.query(
        "SELECT promo_code_id FROM user_promos WHERE user_id = $1 AND status = 'active'",
        [userId]
      );

      if (activeMatchCheck.rows.length) {
        return res.status(400).json({ success: false, error: 'আপনার ইতিমধ্যে একটি ডিপোজিট ম্যাচ প্রোমো চালু আছে।' });
      }

      // Record user_promos matching entry as active
      await client.query(
        `INSERT INTO user_promos (user_id, promo_code_id, status, claimed_amount, used_at)
         VALUES ($1, $2, 'active', 0.00000000, NOW())`,
        [userId, promo.id]
      );

      // Increment uses count
      await client.query(
        'UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1',
        [promo.id]
      );

      await client.query('COMMIT');

      return res.json({
        success: true,
        type: 'deposit_match',
        message: `🎁 '${cleanCode}' প্রোমো কোডটি সফলভাবে অ্যাক্টিভেট করা হয়েছে! আপনার পরবর্তী ডিপোজিটের উপরে ${(parseFloat(promo.value) * 100).toFixed(0)}% ম্যাচিং বোনাস পাবেন (সর্বোচ্চ $${parseFloat(promo.max_bonus_amount).toFixed(0)})।`,
      });

    } else {
      throw new Error('অজানা প্রোমো টাইপ।');
    }

  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  } finally {
    client.release();
  }
});

export default router;
