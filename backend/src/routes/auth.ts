/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTH ROUTES — রেজিস্ট্রেশন, লগইন, ওয়ালেট কানেক্ট
 * ═══════════════════════════════════════════════════════════════
 *
 *  POST /api/auth/register      → নতুন অ্যাকাউন্ট তৈরি
 *  POST /api/auth/login         → ইমেইল/পাসওয়ার্ড দিয়ে লগইন
 *  POST /api/auth/wallet        → MetaMask/Phantom ওয়ালেট দিয়ে লগইন
 *  GET  /api/auth/me            → বর্তমান ইউজারের তথ্য
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { createToken, authMiddleware, AuthPayload } from '../middleware/auth';
import { validateBody } from '../middleware/validation';
import { registerSchema, loginSchema, walletAuthSchema } from '../schemas';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/register — নতুন অ্যাকাউন্ট তৈরি
// ══════════════════════════════════════════════════════════════
router.post('/register', validateBody(registerSchema), async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    // ইউজারনেম আগে থেকে আছে কিনা চেক
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'এই ইউজারনেম ইতিমধ্যে ব্যবহৃত।' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    await query(
      `INSERT INTO users (id, username, email, password_hash, balance)
       VALUES ($1, $2, $3, $4, 10.00)`,  // নতুন ইউজার পাবে $10 বোনাস
      [userId, username, email || null, passwordHash]
    );

    const token = createToken({ userId, username, isAdmin: false });

    res.status(201).json({
      success: true,
      token,
      user: { userId, username, balance: 10.00 },
      message: `স্বাগতম ${username}! আপনার অ্যাকাউন্টে $10.00 ওয়েলকাম বোনাস যোগ করা হয়েছে।`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/login — লগইন
// ══════════════════════════════════════════════════════════════
router.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    const result = await query(
      'SELECT id, username, password_hash, balance, is_admin FROM users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'ইউজারনেম বা পাসওয়ার্ড ভুল।' });
    }

    const user = result.rows[0];
    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'ইউজারনেম বা পাসওয়ার্ড ভুল।' });
    }

    const token = createToken({
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin,
    });

    res.json({
      success: true,
      token,
      user: {
        userId: user.id,
        username: user.username,
        balance: parseFloat(user.balance),
        isAdmin: user.is_admin,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/wallet — MetaMask ওয়ালেট দিয়ে লগইন
//  ওয়ালেট অ্যাড্রেস ইউনিক — প্রথমবার আসলে অটো রেজিস্ট্রেশন
// ══════════════════════════════════════════════════════════════
router.post('/wallet', validateBody(walletAuthSchema), async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature } = req.body;

    // TODO: Production-এ signature যাচাই করতে হবে (ethers.js দিয়ে)
    // এখন শুধু অ্যাড্রেস দিয়েই লগইন হবে (Development mode)
    void signature;

    let user = await query(
      'SELECT id, username, balance, is_admin FROM users WHERE wallet_address = $1',
      [walletAddress.toLowerCase()]
    );

    // নতুন ওয়ালেট হলে অটো রেজিস্ট্রেশন
    if (!user.rows.length) {
      const userId = uuidv4();
      const username = `player_${walletAddress.slice(2, 8).toLowerCase()}`;

      await query(
        `INSERT INTO users (id, username, wallet_address, balance)
         VALUES ($1, $2, $3, 5.00)`,
        [userId, username, walletAddress.toLowerCase()]
      );

      user = await query('SELECT id, username, balance, is_admin FROM users WHERE id = $1', [userId]);
    }

    const u = user.rows[0];
    const token = createToken({ userId: u.id, username: u.username, isAdmin: u.is_admin });

    res.json({
      success: true,
      token,
      user: {
        userId: u.id,
        username: u.username,
        balance: parseFloat(u.balance),
        walletAddress: walletAddress.toLowerCase(),
        isAdmin: u.is_admin,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/auth/me — বর্তমান ইউজারের তথ্য
// ══════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as Request & { user: AuthPayload }).user;

    const result = await query(
      'SELECT id, username, email, wallet_address, balance, is_admin, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const u = result.rows[0];
    res.json({
      success: true,
      user: {
        userId: u.id,
        username: u.username,
        email: u.email,
        walletAddress: u.wallet_address,
        balance: parseFloat(u.balance),
        isAdmin: u.is_admin,
        joinedAt: u.created_at,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
