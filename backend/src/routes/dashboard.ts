/**
 * ═══════════════════════════════════════════════════════════════
 *  DASHBOARD ROUTES — ইউজার ও এডমিন ড্যাশবোর্ড API
 * ═══════════════════════════════════════════════════════════════
 *
 *  GET /api/dashboard/stats/:userId   → ইউজারের সব পরিসংখ্যান
 *  GET /api/dashboard/chart/:userId   → চার্টের জন্য দৈনিক ডেটা
 *  GET /api/dashboard/history/:userId → সম্পূর্ণ বেট ইতিহাস
 *  GET /api/dashboard/admin/live      → লাইভ প্ল্যাটফর্ম স্ট্যাটস
 *  GET /api/dashboard/admin/users     → সব ইউজারের তালিকা
 *  PATCH /api/dashboard/admin/users/:id → ইউজার ফ্রিজ/আনফ্রিজ
 *  POST /api/dashboard/admin/seed/rotate → সার্ভার সিড রোটেট করো
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { authMiddleware, adminMiddleware, roleMiddleware, AuthPayload } from '../middleware/auth';
import { generateServerSeed, hashServerSeed } from '../services/provably-fair';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  GET /api/dashboard/stats/:userId — ইউজারের পরিসংখ্যান
// ══════════════════════════════════════════════════════════════
router.get('/stats/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // মোট বেট, জয়, হার, মোট বাজি, নেট P&L
    const statsResult = await query(`
      SELECT
        COUNT(*)                                          AS total_bets,
        COUNT(*) FILTER (WHERE won = true)               AS total_wins,
        COUNT(*) FILTER (WHERE won = false)              AS total_losses,
        COALESCE(SUM(amount), 0)                         AS total_wagered,
        COALESCE(SUM(payout) - SUM(amount), 0)          AS net_pnl,
        COALESCE(SUM(payout), 0)                         AS total_payout,
        MAX(created_at)                                   AS last_bet_at,
        -- সর্বোচ্চ টানা জয় (win streak) বের করা কঠিন, তাই সর্বোচ্চ জয়ের পরিমাণ দেখাই
        COALESCE(MAX(payout), 0)                         AS biggest_win
      FROM bets
      WHERE user_id = $1 AND status = 'resolved'
    `, [userId]);

    const s = statsResult.rows[0];
    const totalBets  = parseInt(s.total_bets);
    const totalWins  = parseInt(s.total_wins);
    const winRate    = totalBets > 0 ? ((totalWins / totalBets) * 100).toFixed(1) : '0.0';

    // ব্যালেন্স
    const balResult = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    const balance = parseFloat(balResult.rows[0]?.balance || '0');

    res.json({
      success: true,
      data: {
        balance,
        totalBets,
        totalWins,
        totalLosses:   parseInt(s.total_losses),
        winRate:       parseFloat(winRate),
        totalWagered:  parseFloat(s.total_wagered),
        netPnl:        parseFloat(s.net_pnl),
        totalPayout:   parseFloat(s.total_payout),
        biggestWin:    parseFloat(s.biggest_win),
        lastBetAt:     s.last_bet_at,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/dashboard/chart/:userId — দৈনিক P&L চার্ট ডেটা
//  শেষ ৩০ দিনের প্রতিদিনের লাভ/লোকসান
// ══════════════════════════════════════════════════════════════
router.get('/chart/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const result = await query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Dhaka') AS date,
        COUNT(*)                                    AS bets,
        COUNT(*) FILTER (WHERE won = true)          AS wins,
        COALESCE(SUM(payout) - SUM(amount), 0)      AS pnl,
        COALESCE(SUM(amount), 0)                    AS wagered
      FROM bets
      WHERE user_id = $1
        AND status = 'resolved'
        AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Dhaka')
      ORDER BY date ASC
    `, [userId]);

    // কোনো বেট না থাকা দিনগুলো শূন্য দিয়ে পূরণ করো
    const chartData = result.rows.map(row => ({
      date:    row.date,
      bets:    parseInt(row.bets),
      wins:    parseInt(row.wins),
      pnl:     parseFloat(row.pnl),
      wagered: parseFloat(row.wagered),
    }));

    // ক্রমবর্ধমান P&L (cumulative)
    let cumulative = 0;
    const withCumulative = chartData.map(d => {
      cumulative += d.pnl;
      return { ...d, cumulativePnl: parseFloat(cumulative.toFixed(2)) };
    });

    res.json({ success: true, data: withCumulative });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/dashboard/history/:userId — বেট ইতিহাস
// ══════════════════════════════════════════════════════════════
router.get('/history/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const page  = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const [historyResult, countResult] = await Promise.all([
      query(`
        SELECT id, choice, amount, result, won, payout,
               house_edge, flip_hash, created_at
        FROM bets
        WHERE user_id = $1 AND status = 'resolved'
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]),
      query('SELECT COUNT(*) FROM bets WHERE user_id = $1 AND status = $2', [userId, 'resolved']),
    ]);

    res.json({
      success: true,
      data: historyResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page,
        limit,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/dashboard/admin/live — লাইভ প্ল্যাটফর্ম স্ট্যাটস
// ══════════════════════════════════════════════════════════════
router.get('/admin/live', authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const [
      totalUsers, todayUsers,
      totalBets, todayBets,
      houseProfit, activeRains,
    ] = await Promise.all([
      query('SELECT COUNT(*) FROM users WHERE is_active = true'),
      query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'"),
      query("SELECT COUNT(*), COALESCE(SUM(amount),0) AS volume FROM bets WHERE status='resolved'"),
      query(`SELECT COUNT(*), COALESCE(SUM(amount),0) AS volume
             FROM bets WHERE status='resolved' AND created_at > NOW() - INTERVAL '24 hours'`),
      // হাউজের মোট আয় = মোট বাজি - মোট পেআউট
      query("SELECT COALESCE(SUM(amount) - SUM(payout), 0) AS profit FROM bets WHERE status='resolved'"),
      query("SELECT COUNT(*) FROM crypto_rain_events WHERE status='active' AND expires_at > NOW()"),
    ]);

    res.json({
      success: true,
      data: {
        users: {
          total:   parseInt(totalUsers.rows[0].count),
          today:   parseInt(todayUsers.rows[0].count),
        },
        bets: {
          total:       parseInt(totalBets.rows[0].count),
          totalVolume: parseFloat(totalBets.rows[0].volume),
          today:       parseInt(todayBets.rows[0].count),
          todayVolume: parseFloat(todayBets.rows[0].volume),
        },
        houseProfit:   parseFloat(houseProfit.rows[0].profit),
        activeRains:   parseInt(activeRains.rows[0].count),
        timestamp:     new Date().toISOString(),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/dashboard/admin/users — সব ইউজারের তালিকা
// ══════════════════════════════════════════════════════════════
router.get('/admin/users', authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const page  = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const offset = (page - 1) * limit;

    const searchFilter = search ? `AND (username ILIKE $3 OR email ILIKE $3)` : '';
    const params: unknown[] = [limit, offset];
    if (search) params.push(`%${search}%`);

    const result = await query(`
      SELECT u.id, u.username, u.email, u.wallet_address,
             u.balance, u.is_active, u.is_admin, u.created_at,
             COUNT(b.id)                         AS total_bets,
             COALESCE(SUM(b.payout)-SUM(b.amount),0) AS net_pnl
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id AND b.status = 'resolved'
      WHERE 1=1 ${searchFilter}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const countResult = await query(
      `SELECT COUNT(*) FROM users WHERE 1=1 ${searchFilter}`,
      search ? [`%${search}%`] : []
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page,
        limit,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  PATCH /api/dashboard/admin/users/:id — ইউজার ফ্রিজ/আনফ্রিজ
// ══════════════════════════════════════════════════════════════
router.patch('/admin/users/:id', authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isActive, balance } = req.body;
    const self = (req as Request & { user: AuthPayload }).user;

    if (id === self.userId) {
      return res.status(400).json({ success: false, error: 'নিজের অ্যাকাউন্ট পরিবর্তন করা যাবে না।' });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (isActive !== undefined) {
      values.push(isActive);
      updates.push(`is_active = $${values.length}`);
    }
    if (balance !== undefined) {
      values.push(parseFloat(balance));
      updates.push(`balance = $${values.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, error: 'কোনো আপডেট দেওয়া হয়নি।' });
    }

    values.push(id);
    await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    res.json({
      success: true,
      message: isActive === false ? 'ইউজার ফ্রিজ করা হয়েছে।' : 'ইউজার আনফ্রিজ করা হয়েছে।',
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/dashboard/admin/seed/rotate — সার্ভার সিড রোটেট
//  নিরাপত্তার জন্য এডমিন যেকোনো সময় নতুন সিড তৈরি করতে পারবে
// ══════════════════════════════════════════════════════════════
router.post('/admin/seed/rotate', authMiddleware, roleMiddleware(['super_admin']), async (_req: Request, res: Response) => {
  try {
    const newSeed     = generateServerSeed();
    const newSeedHash = hashServerSeed(newSeed);

    // সিড লগে রাখো (ভবিষ্যতে অডিটের জন্য)
    await query(`
      INSERT INTO admin_settings (key, value, description, updated_at)
      VALUES ('last_seed_rotation', NOW()::text, 'সর্বশেষ সিড রোটেশনের সময়', NOW())
      ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()
    `);

    res.json({
      success: true,
      data: {
        newSeedHash,
        rotatedAt: new Date().toISOString(),
        message: 'নতুন সার্ভার সিড তৈরি হয়েছে। পুরানো সিড অপরিবর্তিত থেকেছে।',
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
