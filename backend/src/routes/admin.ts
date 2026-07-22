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
import { z } from 'zod';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaClient } from '@prisma/client';
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
import { getWheelStatus, spinDailyWheel, getWheelStats } from '../services/daily-wheel';
import { getLeaderboard, getLeaderboardPosition, distributeLeaderboardPrizes, getLeaderboardStats } from '../services/leaderboard';
import { getRakebackStatus, claimRakeback, getRakebackStats } from '../services/rakeback';
import { getUserChallengeProgress, claimChallengeReward, getChallengeStats, getChallengeDefinitions } from '../services/challenges';
import { getWhitelistedIps, addIpToWhitelist, removeIpFromWhitelist } from '../services/ip-whitelist';
import { ipWhitelistAddSchema } from '../schemas';

const prisma = new PrismaClient();

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
    // Add houseProfit to the admin stats response.
    const [totalBets, todayBets, totalUsers, activeRain, houseProfit] = await Promise.all([
      query('SELECT COUNT(*) as count, SUM(amount) as volume FROM bets'),
      query("SELECT COUNT(*) as count, SUM(amount) as volume FROM bets WHERE created_at > NOW() - INTERVAL '24 hours'"),
      query('SELECT COUNT(*) as count FROM users WHERE is_active = true'),
      query("SELECT COUNT(*) as count FROM crypto_rain_events WHERE status = 'active'"),
      query('SELECT COALESCE(SUM(amount - payout), 0) as profit FROM bets'),
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
        houseProfit: parseFloat(houseProfit.rows[0].profit || '0'),
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
//  GET /api/admin/wheel-stats — দৈনিক হুইল প্ল্যাটফর্ম স্ট্যাটস
// ══════════════════════════════════════════════════════════════
router.get('/wheel-stats', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const stats = await getWheelStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/leaderboard — ওয়েজারিং লিডারবোর্ড
// ══════════════════════════════════════════════════════════════
router.get('/leaderboard', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as 'daily' | 'weekly') || 'daily';
    const entries = await getLeaderboard(period);
    const stats = await getLeaderboardStats();
    res.json({ success: true, entries, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/leaderboard/distribute — পুরস্কার বিতরণ
// ══════════════════════════════════════════════════════════════
router.post('/leaderboard/distribute', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance']), async (req: Request, res: Response) => {
  try {
    const { period = 'daily' } = req.body as { period?: 'daily' | 'weekly' };
    const result = await distributeLeaderboardPrizes(period);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/rakeback — প্ল্যাটফর্ম রেকব্যাক স্ট্যাটস
// ══════════════════════════════════════════════════════════════
router.get('/rakeback', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const stats = await getRakebackStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/challenges — চ্যালেঞ্জ ডেফিনিশন ও স্ট্যাটস
// ══════════════════════════════════════════════════════════════
router.get('/challenges', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const definitions = await getChallengeDefinitions();
    const stats = await getChallengeStats();
    res.json({ success: true, definitions, stats });
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

// ══════════════════════════════════════════════════════════════
//  IP WHITELIST ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/admin/ip-whitelist — List all whitelisted IPs
router.get('/ip-whitelist', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const entries = await getWhitelistedIps();
    res.json({ success: true, entries });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/admin/ip-whitelist — Add an IP to whitelist
router.post('/ip-whitelist', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support']), validateBody(ipWhitelistAddSchema), async (req: Request, res: Response) => {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const { ipAddress, reason } = req.body;

    const entry = await addIpToWhitelist(ipAddress, reason, self.userId);
    res.status(201).json({ success: true, entry, message: `IP ${ipAddress} whitelisted successfully.` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique constraint') || msg.includes('duplicate')) {
      return res.status(409).json({ success: false, error: 'This IP is already whitelisted.' });
    }
    res.status(500).json({ success: false, error: msg });
  }
});

// DELETE /api/admin/ip-whitelist/:ip — Remove an IP from whitelist
router.delete('/ip-whitelist/:ip', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const ip = req.params.ip as string;
    const removed = await removeIpFromWhitelist(ip);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'IP not found in whitelist.' });
    }
    res.json({ success: true, message: `IP ${ip} removed from whitelist.` });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
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

// ══════════════════════════════════════════════════════════════
//  DEPOSIT & RATE MANAGEMENT
// ══════════════════════════════════════════════════════════════

import { customRateService } from '../services/custom-rate.service';
import { depositService } from '../services/deposit.service';

// GET /api/admin/rates — list active custom rates
router.get('/rates', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const pair = req.query.pair as string | undefined;
    const rates = await customRateService.listCustomRates(pair);
    res.json({ success: true, data: rates });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/admin/deposits/queue — pending deposit queue
router.get('/deposits/queue', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    const queue = await prisma.depositTransaction.findMany({
      where: { status: { in: ['rate_locked', 'awaiting_payment', 'payment_detected', 'confirming'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, count: queue.length, data: queue });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/admin/deposits/:depositId/force-complete — manually complete a deposit
router.post('/deposits/:depositId/force-complete', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const { depositId } = req.params;
    await depositService.confirmDeposit(depositId as string, 999);
    res.json({ success: true, message: 'Deposit force-completed' });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/admin/deposits/expire-old — manually expire timed-out deposits
router.post('/deposits/expire-old', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance']), async (_req: Request, res: Response) => {
  try {
    const count = await depositService.expireOldDeposits();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/admin/rates/custom — set a custom rate override
router.post('/rates/custom', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance']), async (req: Request, res: Response) => {
  try {
    const { pair, customRate, buySpread, sellSpread, justification, validUntil } = req.body;
    if (!pair || !customRate || !buySpread || !sellSpread || !justification) {
      return res.status(400).json({ success: false, error: 'pair, customRate, buySpread, sellSpread, justification required' });
    }
    const user = (req as Request & { user?: AuthPayload }).user;
    if (!user?.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const result = await customRateService.setCustomRate(
      user.id,
      pair as string,
      new Decimal(customRate),
      new Decimal(buySpread),
      new Decimal(sellSpread),
      justification as string,
      new Date(),
      validUntil ? new Date(validUntil) : undefined,
      true
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/admin/rates/revert — revert a custom rate to market
router.post('/rates/revert', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance']), async (req: Request, res: Response) => {
  try {
    const { pair, justification } = req.body;
    if (!pair || !justification) {
      return res.status(400).json({ success: false, error: 'pair and justification required' });
    }
    const user = (req as Request & { user?: AuthPayload }).user;
    if (!user?.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    await customRateService.revertToMarketRate(user.id, pair, justification);
    res.json({ success: true, message: 'Reverted to market rate' });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ══════════════════════════════════════════════════════════════
//  ADMIN SETTINGS
// ══════════════════════════════════════════════════════════════
import { getAdminSettingBool, setAdminSetting } from '../services/admin-settings.service';
import { creditCoins, ensureTestingWallet, TESTING_TOKEN } from '../services/testing-balance';
import {
  checkIpReputation, getIpReputationReport,
  addToBlocklist, removeFromBlocklist, listBlocklist,
} from '../services/ip-reputation';
import mlRoutes from './ml-routes';

// GET /api/admin/settings — list all admin settings
router.get('/settings', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const result = await query('SELECT key, value, description, updated_at FROM admin_settings ORDER BY key ASC');
    res.json({ success: true, data: result.rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PUT /api/admin/settings/bulk — update many settings in one shot.
// Body: { updates: [{ key, value, description? }, ...] }
// NOTE: Must come BEFORE PUT /settings/:key so Express matches the
// literal "bulk" segment instead of treating it as a :key parameter.
router.put('/settings/bulk', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), validateBody(z.object({
  updates: z.array(z.object({
    key: z.string().min(1).max(120),
    value: z.string().max(4000),
    description: z.string().max(500).optional(),
  })).min(1).max(50),
})), async (req: Request, res: Response) => {
  try {
    const adminId = (req as Request & { user: AuthPayload }).user?.userId;
    const { updates } = req.body as { updates: Array<{ key: string; value: string; description?: string }> };
    for (const u of updates) {
      await setAdminSetting(u.key, u.value, u.description);
    }
    if (adminId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'settings.bulk_update', 'info', $1::uuid, $2::jsonb)`,
        [adminId, JSON.stringify({ count: updates.length, keys: updates.map((u) => u.key) })],
      );
    }
    res.json({ success: true, updated: updates.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PUT /api/admin/settings/:key — update a setting (super_admin only)
router.put('/settings/:key', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), validateBody(z.object({ value: z.string() })), async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    await setAdminSetting(key as string, value as string);
    res.json({ success: true, message: 'Setting updated' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/admin/settings/groups — curated grouping for the UI
// (avoids dumping every row of admin_settings into a single table).
router.get('/settings/groups', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (_req: Request, res: Response) => {
  try {
    // Pull every key and group by prefix.
    const r = await query('SELECT key, value, description, updated_at FROM admin_settings ORDER BY key ASC');
    const groups: Record<string, Array<{ key: string; value: string; description: string | null; updated_at: Date | null }>> = {
      'Bonus & Wagering': [],
      'Fraud Detection': [],
      'IP Reputation': [],
      'Deepfake KYC': [],
      'Safety & Limits': [],
      'Admin & Auth': [],
      'Other': [],
    };
    const bucket = (k: string): string => {
      if (k.startsWith('bonus_') || k.startsWith('wagering_')) return 'Bonus & Wagering';
      if (k.startsWith('fraud_') || k.startsWith('velocity_') || k.startsWith('affiliate_')) return 'Fraud Detection';
      if (k.startsWith('ip_reputation') || k.startsWith('abuseipdb') || k.startsWith('fraud_ip_')) return 'IP Reputation';
      if (k.startsWith('kyc_deepfake_')) return 'Deepfake KYC';
      if (k.startsWith('admin_') || k.startsWith('security_') || k.startsWith('kyc_')) return 'Admin & Auth';
      if (k.startsWith('alert_')) return 'Fraud Detection';
      if (k.includes('self_excl') || k.includes('limit')) return 'Safety & Limits';
      return 'Other';
    };
    for (const row of r.rows as Array<{ key: string; value: string; description: string | null; updated_at: Date | null }>) {
      groups[bucket(row.key)]!.push(row);
    }
    res.json({ success: true, groups });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/admin/settings/admin-2fa-status — check if admin 2FA is required
router.get('/settings/admin-2fa-status', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'support', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const required = await getAdminSettingBool('admin_2fa_required', false);
    res.json({ success: true, required });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  TESTING BALANCE — quick credit for admin / smoke tests
// ══════════════════════════════════════════════════════════════
//
//  POST /api/admin/testing/credit-coins
//    body: { userId, amount, reason }
//  POST /api/admin/testing/ensure-wallet
//    body: { userId }
//  GET  /api/admin/testing/wallet/:userId
//
//  These are explicitly for testing. They use an "INTERNAL" chain
//  wallet (no real on-chain address, no deposit monitor) so admins
//  can give themselves coins to smoke-test the game without needing
//  real Binance Pay deposits. Production deposits still flow through
//  wallet-derivation + deposit-monitor + reconciliation.

router.post('/testing/credit-coins', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const adminId = (req as Request & { user: AuthPayload }).user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { userId?: string; amount?: number; reason?: string };
    if (!body.userId) return res.status(400).json({ success: false, error: 'userId required' });
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be a positive number' });
    }
    if (!body.reason || body.reason.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'reason must be at least 5 characters' });
    }
    const result = await creditCoins(body.userId, body.amount, body.reason.trim(), adminId);
    res.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'USER_NOT_FOUND') return res.status(404).json({ success: false, error: 'User not found' });
    res.status(500).json({ success: false, error: message });
  }
});

router.post('/testing/ensure-wallet', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const body = req.body as { userId?: string };
    if (!body.userId) return res.status(400).json({ success: false, error: 'userId required' });
    const w = await ensureTestingWallet(body.userId);
    res.json({ success: true, walletId: w.walletId, currency: w.currency });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

router.get('/testing/wallet/:userId', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor']), async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);
    const user = await query(
      `SELECT id, username, balance::float8 AS balance,
              withdrawable_balance_coins::float8 AS withdrawable,
              bonus_balance_coins::float8 AS bonus
         FROM users WHERE id = $1::uuid`,
      [userId],
    );
    if (user.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const w = await ensureTestingWallet(userId);
    const wallet = await query(
      `SELECT id, chain, token_symbol, balance::float8 AS balance,
              locked_balance::float8 AS locked
         FROM wallets WHERE id = $1::uuid`,
      [w.walletId],
    );
    res.json({
      success: true,
      user: user.rows[0],
      wallet: wallet.rows[0] ?? null,
      currency: TESTING_TOKEN,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  IP REPUTATION (Phase 2.3) — provider-agnostic IP risk lookup
// ══════════════════════════════════════════════════════════════
//
//  GET  /api/admin/ip/check?ip=X     — live lookup, cached
//  GET  /api/admin/ip/blocklist      — list admin-managed entries
//  POST /api/admin/ip/blocklist      — add an IP to deny/allow
//  DELETE /api/admin/ip/blocklist    — remove an IP entry
//  GET  /api/admin/ip/reports        — aggregate report (cache stats,
//                                      top abusive, recent lookups)

router.get('/ip/check', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor', 'support']), async (req: Request, res: Response) => {
  try {
    const ip = String(req.query.ip || '').trim();
    if (!ip) return res.status(400).json({ success: false, error: 'ip query param required' });
    const result = await checkIpReputation(ip);
    res.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

router.get('/ip/blocklist', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor', 'support']), async (_req: Request, res: Response) => {
  try {
    const rows = await listBlocklist();
    res.json({ success: true, entries: rows, total: rows.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

router.post('/ip/blocklist', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const adminId = (req as Request & { user: AuthPayload }).user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { ip?: string; listType?: 'deny' | 'allow'; reason?: string; expiresAt?: string };
    if (!body.ip) return res.status(400).json({ success: false, error: 'ip required' });
    if (!body.listType || !['deny', 'allow'].includes(body.listType)) {
      return res.status(400).json({ success: false, error: 'listType must be deny|allow' });
    }
    if (!body.reason || body.reason.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'reason must be at least 5 characters' });
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && isNaN(expiresAt.getTime())) {
      return res.status(400).json({ success: false, error: 'expiresAt invalid' });
    }
    const r = await addToBlocklist(body.ip, body.listType, body.reason.trim(), adminId, expiresAt);
    await query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('admin', 'ip.blocklist_add', 'info', $1::uuid, $2::jsonb)`,
      [adminId, JSON.stringify({ ip: body.ip, listType: body.listType, reason: body.reason.trim() })],
    );
    res.json({ success: true, id: r.id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

router.delete('/ip/blocklist', adminLimiter, authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const adminId = (req as Request & { user: AuthPayload }).user?.userId;
    const ip = String(req.query.ip || '').trim();
    const listType = (req.query.listType as 'deny' | 'allow') || 'deny';
    if (!ip) return res.status(400).json({ success: false, error: 'ip query param required' });
    if (!['deny', 'allow'].includes(listType)) {
      return res.status(400).json({ success: false, error: 'listType must be deny|allow' });
    }
    await removeFromBlocklist(ip, listType);
    if (adminId) {
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('admin', 'ip.blocklist_remove', 'info', $1::uuid, $2::jsonb)`,
        [adminId, JSON.stringify({ ip, listType })],
      );
    }
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

router.get('/ip/reports', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'finance', 'auditor', 'support']), async (_req: Request, res: Response) => {
  try {
    const report = await getIpReputationReport();
    res.json({ success: true, report });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});
