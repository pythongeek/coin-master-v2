/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN ROUTES — এডমিন API এন্ডপয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 *
 *  এই এন্ডপয়েন্টগুলো শুধু এডমিন ব্যবহার করতে পারবে।
 *  সব রুট JWT টোকেন + এডমিন ভেরিফিকেশন দিয়ে সুরক্ষিত।
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  getConfig, updateConfig, updateAllConfig,
  resetToDefaults, CONFIG_LABELS, DEFAULT_CONFIG, GameConfig
} from '../services/admin-config';
import { query } from '../config/database';
import { validateBody } from '../middleware/validation';
import { adminLimiter } from '../middleware/rate-limiter';
import { authMiddleware, AuthPayload, roleMiddleware } from '../middleware/auth';
import { reconcilePendingPayments } from '../services/reconciliation';
import { adminSettingsSchema } from '../schemas';
import { generateServerSeed, hashServerSeed } from '../services/provably-fair';
import { invalidateCache } from '../services/cache';
import { getAchievementStats } from '../services/achievements';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/config
//  সব বর্তমান সেটিং দেখো (লেবেল সহ)
// ══════════════════════════════════════════════════════════════
router.get('/config', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();

    // UI-র জন্য মেটাডেটা সহ রেসপন্স তৈরি করো
    const configWithMeta = Object.entries(config).map(([key, value]) => {
      const meta = CONFIG_LABELS[key as keyof GameConfig];
      return {
        key,
        value,
        defaultValue: DEFAULT_CONFIG[key as keyof GameConfig],
        isModified: value !== DEFAULT_CONFIG[key as keyof GameConfig],
        ...meta,
      };
    });

    // ক্যাটাগরি অনুযায়ী গ্রুপ করো
    const grouped: Record<string, typeof configWithMeta> = {};
    for (const item of configWithMeta) {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(item);
    }

    res.json({
      success: true,
      config,
      configWithMeta: grouped,
      message: 'কনফিগ সফলভাবে লোড হয়েছে',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  PATCH /api/admin/config
//  একটি বা একাধিক সেটিং আপডেট করো
// ══════════════════════════════════════════════════════════════
router.patch('/config', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), validateBody(adminSettingsSchema), async (req: Request, res: Response) => {
  try {
    const updates = req.body as Partial<GameConfig>;

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'কোনো আপডেট দেওয়া হয়নি।' });
    }

    await updateAllConfig(updates);

    const updatedConfig = await getConfig();
    res.json({
      success: true,
      config: updatedConfig,
      message: `${Object.keys(updates).length}টি সেটিং আপডেট হয়েছে।`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/config/reset
//  সব সেটিং ডিফল্টে ফিরিয়ে দাও
// ══════════════════════════════════════════════════════════════
router.post('/config/reset', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (_req: Request, res: Response) => {
  try {
    await resetToDefaults();
    res.json({
      success: true,
      config: DEFAULT_CONFIG,
      message: 'সব সেটিং ডিফল্টে ফেরত গেছে।',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/stats
//  লাইভ গেম স্ট্যাটিস্টিক্স
// ══════════════════════════════════════════════════════════════
router.get('/stats', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const [totalBets, todayBets, totalUsers, activeRain] = await Promise.all([
      query('SELECT COUNT(*) as count, SUM(amount) as volume FROM bets'),
      query("SELECT COUNT(*) as count, SUM(amount) as volume FROM bets WHERE created_at > NOW() - INTERVAL '24 hours'"),
      query('SELECT COUNT(*) as count FROM users WHERE is_active = true'),
      query("SELECT COUNT(*) as count FROM crypto_rain_events WHERE status = 'active'"),
    ]);

    res.json({
      success: true,
      stats: {
        totalBets: parseInt(totalBets.rows[0].count),
        totalVolume: parseFloat(totalBets.rows[0].volume || '0'),
        todayBets: parseInt(todayBets.rows[0].count),
        todayVolume: parseFloat(todayBets.rows[0].volume || '0'),
        totalUsers: parseInt(totalUsers.rows[0].count),
        activeRainEvents: parseInt(activeRain.rows[0].count),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/streak-stats
//  স্ট্রিক ল্যাডার বোনাসের লাইভ স্ট্যাটিস্টিক্স ও নিয়ন্ত্রণ
// ══════════════════════════════════════════════════════════════
router.get('/streak-stats', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    const today = new Date().toISOString().slice(0, 10);

    const { getStreakBudgetSpent } = await import('../config/redis');
    const budgetSpent = await getStreakBudgetSpent(today);
    const budgetRemaining = Math.max(0, config.streakBudgetDailyUsd - budgetSpent);

    const ladderStats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE streak_after > 0) as active_streaks,
        SUM(streak_ladder_bonus) as total_topups,
        SUM(streak_banked) as total_banked,
        SUM(streak_lost) as total_lost
      FROM bets
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const highestStreaks = await query(`
      SELECT u.username, MAX(streak_after) as max_streak
      FROM bets b
      JOIN users u ON b.user_id = u.id
      WHERE b.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY u.username
      ORDER BY max_streak DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      streak: {
        enabled: config.streakEnabled,
        budgetDaily: config.streakBudgetDailyUsd,
        budgetSpent,
        budgetRemaining,
        activeStreaks: parseInt(ladderStats.rows[0].active_streaks || '0'),
        totalTopups: parseFloat(ladderStats.rows[0].total_topups || '0'),
        totalBanked: parseFloat(ladderStats.rows[0].total_banked || '0'),
        totalLost: parseFloat(ladderStats.rows[0].total_lost || '0'),
        highestStreaks: highestStreaks.rows,
      },
      lightning: {
        enabled: config.lightningEnabled,
        budgetDaily: config.lightningBudgetDailyUsd,
        budgetSpent: await (await import('../config/redis')).getLightningBudgetSpent(today),
        budgetRemaining: Math.max(0, config.lightningBudgetDailyUsd - await (await import('../config/redis')).getLightningBudgetSpent(today)),
        totalRounds: parseInt((await query("SELECT COUNT(*) FROM bets WHERE lightning_triggered = true AND created_at > NOW() - INTERVAL '24 hours'")).rows[0].count || '0'),
        totalExtraPayout: parseFloat((await query("SELECT SUM(lightning_extra_payout) FROM bets WHERE created_at > NOW() - INTERVAL '24 hours'")).rows[0].sum || '0'),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/streak-reset/:userId
//  একটি নির্দিষ্ট ইউজারের স্ট্রিক ল্যাডার বোনাস রিসেট করো
// ══════════════════════════════════════════════════════════════
router.post('/streak-reset/:userId', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const { resetWinStreak, resetStreakBonusAtRisk } = await import('../config/redis');
    await resetWinStreak(userId);
    await resetStreakBonusAtRisk(userId);

    res.json({
      success: true,
      message: 'ইউজারের স্ট্রিক ল্যাডার রিসেট হয়েছে।',
      userId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/achievements — অ্যাচিভমেন্ট প্ল্যাটফর্ম স্ট্যাটস
// ══════════════════════════════════════════════════════════════
router.get('/achievements', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const stats = await getAchievementStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/audit-logs — সাম্প্রতিক অডিট লগগুলো দেখাও
// ══════════════════════════════════════════════════════════════
router.get('/audit-logs', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'auditor']), async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    
    // Recent logs
    const result = await query(
      `SELECT a.id, a.table_name, a.record_id, a.action, a.old_data, a.new_data, 
              a.changed_by, u.username as changed_by_username, a.ip_address, a.user_agent, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON a.changed_by = u.id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await query('SELECT COUNT(*) as total FROM audit_logs');
    const total = parseInt(countResult.rows[0].total || '0');

    res.json({
      success: true,
      logs: result.rows,
      pagination: {
        total,
        limit,
        offset,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/fraud-logs — প্রতারণা সনাক্তকরণ লগগুলো দেখাও
// ══════════════════════════════════════════════════════════════
router.get('/fraud-logs', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'auditor']), async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await query(
      `SELECT fl.id, fl.user_id, fl.type, fl.ip_address, fl.fingerprint, fl.details, fl.created_at, u.username 
       FROM fraud_logs fl 
       JOIN users u ON fl.user_id = u.id 
       ORDER BY fl.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await query('SELECT COUNT(*) as total FROM fraud_logs');
    const total = parseInt(countResult.rows[0].total || '0');

    res.json({
      success: true,
      logs: result.rows,
      pagination: {
        total,
        limit,
        offset,
      }
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/users/:id/unflag — ইউজার আন-ফ্ল্যাগ করো
// ══════════════════════════════════════════════════════════════
router.post('/users/:id/unflag', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await query('UPDATE users SET is_flagged = false WHERE id = $1', [id]);
    await query('DELETE FROM fraud_logs WHERE user_id = $1', [id]);

    const { invalidateCache } = require('../services/cache');
    await invalidateCache([`balance:${id}`, `cache:stats:${id}`]).catch((err: unknown) => {
      console.warn('Cache invalidation failed for unflagging:', err);
    });

    res.json({
      success: true,
      message: 'ইউজার অ্যাকাউন্টটি সফলভাবে আন-ফ্ল্যাগ করা হয়েছে।'
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/seed/rotate — সার্ভার সিড রোটেট
//
//  H4 FIX (step-up auth): rotating the server seed lets an admin
//  invalidate ALL in-flight Provably Fair verifications. Cost of an
//  unauthorized rotation is total loss of game-trust guarantees until
//  the next rotation. Highest-impact admin action — requires the
//  admin to re-enter their password (verified via bcrypt against the
//  stored hash, NOT the JWT). bcrypt-compare against the
//  JWT-resolved userId so an attacker can't pass another admin's
//  username. Side effects: audit_log row regardless; fraud_signal
//  row on password failure.
// ══════════════════════════════════════════════════════════════
router.post('/seed/rotate', authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const { password } = req.body ?? {};

    if (!password || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'সিড রোটেট করতে পাসওয়ার্ড আবার দিতে হবে।',
      });
    }

    const userResult = await query(
      'SELECT id, username, password_hash, is_active FROM users WHERE id = $1',
      [self.userId]
    );
    if (!userResult.rows.length || !userResult.rows[0].is_active) {
      return res.status(403).json({ success: false, error: 'অ্যাকাউন্ট নিষ্ক্রিয়।' });
    }
    const admin = userResult.rows[0];

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
      try {
        const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
        await query(
          `INSERT INTO fraud_signals
            (user_id, signal_type, severity, ip_address, status, metadata)
           VALUES ($1, 'manual', 'high', $2, 'open', $3)`,
          [
            admin.id,
            ip,
            JSON.stringify({
              reason: 'admin_password_failed',
              route: '/api/admin/seed/rotate',
            }),
          ]
        );
        await query(
          `INSERT INTO audit_log
            (user_id, category, action, severity, ip_address, user_agent, details)
           VALUES ($1, 'admin', 'seed.rotate.password_failed', 'critical', $2, $3, $4)`,
          [
            admin.id,
            ip,
            (req.headers['user-agent'] || '').toString().slice(0, 500),
            JSON.stringify({ route: '/api/admin/seed/rotate' }),
          ]
        );
      } catch (err) {
        console.error('[seed/rotate] fraud/audit log write failed:', err);
      }
      return res.status(401).json({ success: false, error: 'পাসওয়ার্ড ভুল।' });
    }

    // Password verified — rotate.
    const newSeed     = generateServerSeed();
    const newSeedHash = hashServerSeed(newSeed);

    await query(`UPDATE server_seeds SET is_active = false WHERE is_active = true`);
    await query(
      `INSERT INTO server_seeds
         (server_seed, server_seed_hash, is_active, activated_at, created_at)
       VALUES ($1, $2, true, NOW(), NOW())`,
      [newSeed, newSeedHash]
    );

    try {
      await query(
        `INSERT INTO audit_log
          (user_id, category, action, severity, ip_address, user_agent, details)
         VALUES ($1, 'admin', 'seed.rotate', 'warn', $2, $3, $4)`,
        [
          admin.id,
          (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, ''),
          (req.headers['user-agent'] || '').toString().slice(0, 500),
          JSON.stringify({ newSeedHash, route: '/api/admin/seed/rotate' }),
        ]
      );
    } catch { /* best-effort */ }

    res.json({
      success: true,
      seedHash: newSeedHash,
      message: 'নতুন সার্ভার সিড তৈরি হয়েছে।',
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Admin banner control
router.get('/config/banner', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support']), async (_req: Request, res: Response) => {
  try {
    const result = await query("SELECT value FROM admin_settings WHERE key = 'global_banner'");
    const banner = result.rows[0]?.value
      ? JSON.parse(result.rows[0].value)
      : { enabled: false, type: 'info', message: '', dismissible: true };
    res.json({ success: true, banner });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.patch('/config/banner', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const banner = req.body;
    await query(
      `INSERT INTO admin_settings (key, value, description, updated_at)
       VALUES ('global_banner', $1, 'Global announcement/maintenance banner', NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(banner)]
    );
    res.json({ success: true, banner });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;

// ── Admin self-service: password change ────────────────────────
router.post('/change-password', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'support', 'auditor']), async (req: Request, res: Response) => {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const { currentPassword, newPassword } = req.body ?? {};

    if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, error: 'বর্তমান ও নতুন পাসওয়ার্ড দিন।' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।' });
    }

    const userResult = await query('SELECT password_hash FROM users WHERE id = $1 AND is_active = true', [self.userId]);
    if (!userResult.rows.length) {
      return res.status(403).json({ success: false, error: 'অ্যাকাউন্ট পাওয়া যায়নি।' });
    }

    const passwordOk = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'বর্তমান পাসওয়ার্ড ভুল।' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, self.userId]);

    await query(
      `INSERT INTO audit_log (user_id, category, action, severity, ip_address, user_agent, details)
       VALUES ($1, 'admin', 'password.change', 'warn', $2, $3, $4)`,
      [
        self.userId,
        (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, ''),
        (req.headers['user-agent'] || '').toString().slice(0, 500),
        JSON.stringify({ route: '/api/admin/change-password' }),
      ]
    );

    await invalidateCache([`auth:${self.userId}`]).catch(() => {});

    res.json({ success: true, message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।' });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Admin self-service: 2FA status ─────────────────────────────
router.get('/2fa/status', authMiddleware, roleMiddleware(['super_admin', 'finance', 'support', 'auditor']), async (req: Request, res: Response) => {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const result = await query('SELECT two_factor_enabled FROM users WHERE id = $1', [self.userId]);
    res.json({ success: true, enabled: result.rows[0]?.two_factor_enabled === true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ── Admin user search (for bonus grants, support) ─────────────
router.get('/users/search', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'support']), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.status(400).json({ success: false, error: 'Query too short.' });
    const result = await query(
      `SELECT id, username, email, balance
       FROM users
       WHERE LOWER(username) LIKE $1 OR LOWER(email) LIKE $1 OR wallet_address ILIKE $1
       ORDER BY username ASC
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ success: true, users: result.rows });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
