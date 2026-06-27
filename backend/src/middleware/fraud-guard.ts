import { Response, NextFunction } from 'express';
import { query } from '../config/database';

/**
 * Middleware that blocks flagged accounts from performing critical actions:
 * - Betting
 * - Withdrawals
 * - Promo claiming
 */
export async function fraudGuard(req: any, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId || req.body.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'অননুমোদিত।' });
    }

    const userResult = await query(
      'SELECT is_flagged FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    if (userResult.rows[0].is_flagged) {
      return res.status(403).json({
        success: false,
        error: 'আপনার অ্যাকাউন্টটি অস্বাভাবিক কার্যকলাপে জড়িত থাকায় সাময়িকভাবে স্থগিত করা হয়েছে। দয়া করে সাপোর্টে যোগাযোগ করুন।',
      });
    }

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
}
