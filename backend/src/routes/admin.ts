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
import { authMiddleware, adminMiddleware, AuthPayload } from '../middleware/auth';
import { seedRotateLimiter } from '../middleware/rate-limit';
import { generateServerSeed, hashServerSeed } from '../services/provably-fair';

const router = Router();

// ═══════════════════════════════════════════════════════════════
//  SECURITY: All admin routes require a valid JWT AND admin role
// ═══════════════════════════════════════════════════════════════
// Applied at the router level so every route below is protected.
// Upstream bug (SEC-1) had NO auth on these endpoints — anyone on
// the network could PATCH house edge / rain budget / etc.
//
// NOTE: The public subset of config (e.g. houseEdgePercent for the
// frontend win-chance readout) lives in a separate file:
//   routes/admin-public.ts  →  mounted at /api/admin/config
// because Express's router-level `use()` middleware applies to all
// subsequent routes regardless of source-code position. You can't
// escape it by ordering.
router.use(authMiddleware);
router.use(adminMiddleware);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/config
//  সব বর্তমান সেটিং দেখো (লেবেল সহ)
// ══════════════════════════════════════════════════════════════
router.get('/config', async (_req: Request, res: Response) => {
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
router.patch('/config', async (req: Request, res: Response) => {
  try {
    const updates = req.body as Partial<GameConfig>;

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'কোনো আপডেট দেওয়া হয়নি।' });
    }

    // প্রতিটি মান ভ্যালিডেট করো
    for (const [key, value] of Object.entries(updates)) {
      const meta = CONFIG_LABELS[key as keyof GameConfig];
      if (!meta) {
        return res.status(400).json({ success: false, error: `অজানা কনফিগ কী: ${key}` });
      }

      if (meta.type === 'number') {
        const num = parseFloat(String(value));
        if (isNaN(num)) {
          return res.status(400).json({ success: false, error: `${meta.label} একটি সংখ্যা হতে হবে।` });
        }
        if (meta.min !== undefined && num < meta.min) {
          return res.status(400).json({ success: false, error: `${meta.label} সর্বনিম্ন ${meta.min}${meta.unit || ''} হতে হবে।` });
        }
        if (meta.max !== undefined && num > meta.max) {
          return res.status(400).json({ success: false, error: `${meta.label} সর্বোচ্চ ${meta.max}${meta.unit || ''} হতে হবে।` });
        }
      }
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
router.post('/config/reset', async (_req: Request, res: Response) => {
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
router.get('/stats', async (_req: Request, res: Response) => {
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
//  GET /api/admin/users — সব ইউজারের তালিকা
// ══════════════════════════════════════════════════════════════
router.get('/users', async (req: Request, res: Response) => {
  try {
    const page  = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const offset = (page - 1) * limit;

    const searchTerm = search ? `%${search}%` : null;
    const searchFilter = search ? 'AND (username ILIKE $3 OR email ILIKE $3)' : '';
    const countFilter = search ? 'AND (username ILIKE $1 OR email ILIKE $1)' : '';
    const listParams: unknown[] = searchTerm ? [limit, offset, searchTerm] : [limit, offset];
    const countParams: unknown[] = searchTerm ? [searchTerm] : [];

    const result = await query(`
      SELECT u.id, u.username, u.email, u.wallet_address,
             (u.bonus_balance_coins + u.withdrawable_balance_coins) AS balance,
             u.is_active, u.is_admin, u.created_at,
             COUNT(b.id)                         AS total_bets,
             COALESCE(SUM(b.payout)-SUM(b.amount),0) AS net_pnl
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id AND b.status = 'resolved'
      WHERE 1=1 ${searchFilter}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2
    `, listParams);

    const countResult = await query(
      `SELECT COUNT(*) FROM users WHERE 1=1 ${countFilter}`,
      countParams
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
//  PATCH /api/admin/users/:id — ইউজার ফ্রিজ/আনফ্রিজ/ব্যালেন্স এডিট
// ══════════════════════════════════════════════════════════════
router.patch('/users/:id', async (req: Request, res: Response) => {
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
      const amount = parseFloat(balance);
      // Editing legacy balance distributes to withdrawable; bonus stays untouched.
      values.push(amount);
      updates.push(`withdrawable_balance_coins = $${values.length}`);
      values.push(amount);
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
//  POST /api/admin/seed/rotate — সার্ভার সিড রোটেট
//
//  H4 FIX (step-up auth): rotating the server seed lets an admin
//  invalidate ALL in-flight Provably Fair verifications (existing
//  clients' seedHash values would no longer match the active seed).
//  The cost of an unauthorized rotation is total loss of game-trust
//  guarantees until the next rotation. This is the highest-impact
//  admin action — it deserves the same protection as a banking
//  wire: require the admin to re-enter their password (verified
//  via bcrypt against the stored hash, NOT the JWT).
//
//  Why "not the JWT" — a stolen admin JWT would otherwise bypass this
//  entirely. By forcing a fresh password check on every call, we
//  downgrade token theft from "full admin compromise" to "30-min
//  token, no rotation ability". The cost is one bcrypt compare
//  (~50ms) per rotation — acceptable for an action admins perform
//  a handful of times per day.
//
//  Side effects regardless of outcome:
//    - audit_log row (category=admin, action=seed.rotate)
//    - On password failure: also write a fraud_signals row
//      (signal_type=admin_password_failed, severity=high)
// ══════════════════════════════════════════════════════════════
router.post('/seed/rotate', seedRotateLimiter, async (req: Request, res: Response) => {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const { password } = req.body ?? {};

    if (!password || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'সিড রোটেট করতে পাসওয়ার্ড আবার দিতে হবে।',
      });
    }

    // Look up the admin by JWT-resolved userId (not by request body
    // username) so an attacker can't pass another admin's username.
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
      // Log a high-severity fraud signal — multiple of these = brute force
      // attempt on an admin account. signal_type must be one of the values
      // allowed by the fraud_signals_signal_type_check constraint; the
      // actual reason (admin_password_failed vs other) goes in metadata.
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
            req.ip ?? req.socket.remoteAddress ?? 'unknown',
            (req.headers['user-agent'] || '').toString().slice(0, 500),
            JSON.stringify({ route: '/api/admin/seed/rotate' }),
          ]
        );
      } catch (err) {
        // Log to stderr so silent DB-side failures are visible in
        // container logs. Don't return the error to the client —
        // the response shape must be identical for "wrong username"
        // and "wrong password" to avoid username-enumeration leaks.
        console.error('[seed/rotate] fraud/audit log write failed:', err);
      }

      // Same response timing / shape as a real attempt failure so an
      // attacker can't tell from the body whether the username was wrong
      // vs the password was wrong.
      return res.status(401).json({
        success: false,
        error: 'পাসওয়ার্ড ভুল।',
      });
    }

    // ── Password verified — proceed with rotation ──
    const newSeed     = generateServerSeed();
    const newSeedHash = hashServerSeed(newSeed);

    // Schema note: the `server_seeds` table uses columns `server_seed`
    // and `server_seed_hash`, NOT `seed`/`hash` (the in-code var
    // names). The old endpoint referenced the wrong names and 500'd
    // silently — this fix unblocks the seed-rotation path for the
    // first time. The unique index `idx_server_seeds_active`
    // (WHERE is_active = true) means we must deactivate the old row
    // before inserting a new active one, otherwise the INSERT
    // violates the unique constraint.
    await query(
      `UPDATE server_seeds SET is_active = false WHERE is_active = true`,
    );
    await query(
      `INSERT INTO server_seeds
         (server_seed, server_seed_hash, is_active, activated_at, created_at)
       VALUES ($1, $2, true, NOW(), NOW())`,
      [newSeed, newSeedHash]
    );

    // Audit row for the successful rotation
    try {
      await query(
        `INSERT INTO audit_log
          (user_id, category, action, severity, ip_address, user_agent, details)
         VALUES ($1, 'admin', 'seed.rotate', 'warn', $2, $3, $4)`,
        [
          admin.id,
          req.ip ?? req.socket.remoteAddress ?? 'unknown',
          (req.headers['user-agent'] || '').toString().slice(0, 500),
          JSON.stringify({ newSeedHash, route: '/api/admin/seed/rotate' }),
        ]
      );
    } catch { /* audit logging is best-effort */ }

    res.json({
      success: true,
      seedHash: newSeedHash,
      message: 'নতুন সার্ভার সিড তৈরি হয়েছে।',
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
