/**
 * ═══════════════════════════════════════════════════════════════
 *  LEADERBOARD ROUTES — লিডারবোর্ড API এন্ডপয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 *
 *  GET /api/game/leaderboards → ডেইলি ও উইকলি লিডারবোর্ড ডেটা
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { getOrSet } from '../services/cache';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  GET /api/game/leaderboards — ডেইলি ও উইকলি লিডারবোর্ড
// ══════════════════════════════════════════════════════════════
router.get('/', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'cache:leaderboards';
    const cachedData = await getOrSet(cacheKey, 30, async () => {
      // ১. ডেইলি লিডারবোর্ড (গত ২৪ ঘণ্টা)
      const dailyResult = await query(`
        SELECT 
          u.id AS user_id,
          u.username,
          COALESCE(SUM(b.amount), 0) AS volume,
          COUNT(b.id) AS bet_count
        FROM bets b
        JOIN users u ON b.user_id = u.id
        WHERE b.status = 'resolved'
          AND b.created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY u.id, u.username
        ORDER BY volume DESC
        LIMIT 10
      `);

      // ২. উইকলি লিডারবোর্ড (গত ৭ দিন)
      const weeklyResult = await query(`
        SELECT 
          u.id AS user_id,
          u.username,
          COALESCE(SUM(b.amount), 0) AS volume,
          COUNT(b.id) AS bet_count
        FROM bets b
        JOIN users u ON b.user_id = u.id
        WHERE b.status = 'resolved'
          AND b.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY u.id, u.username
        ORDER BY volume DESC
        LIMIT 10
      `);

      const daily = dailyResult.rows.map(row => ({
        userId: row.user_id,
        username: row.username,
        volume: parseFloat(row.volume),
        betCount: parseInt(row.bet_count),
      }));

      const weekly = weeklyResult.rows.map(row => ({
        userId: row.user_id,
        username: row.username,
        volume: parseFloat(row.volume),
        betCount: parseInt(row.bet_count),
      }));

      return { daily, weekly };
    });

    res.json({
      success: true,
      data: cachedData,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

