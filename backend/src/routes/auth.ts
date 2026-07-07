/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTH ROUTES — রেজিস্ট্রেশন, লগইন, ওয়ালেট কানেক্ট, ২এফএ (2FA)
 * ═══════════════════════════════════════════════════════════════
 *
 *  POST /api/auth/register      → নতুন অ্যাকাউন্ট তৈরি
 *  POST /api/auth/login         → ইমেইল/পাসওয়ার্ড দিয়ে লগইন
 *  POST /api/auth/wallet        → MetaMask/Phantom ওয়ালেট দিয়ে লগইন
 *  GET  /api/auth/me            → বর্তমান ইউজারের তথ্য
 *  POST /api/auth/2fa/setup     → ২এফএ সেটআপ কি জেনারেট করা
 *  POST /api/auth/2fa/verify    → ২এফএ সেটআপ ভেরিফাই ও এনেবল করা
 *  POST /api/auth/2fa/disable   → ২এফএ ডিজেবল করা
 *  POST /api/auth/2fa/login     → ২এফএ কোড দিয়ে লগইন সম্পন্ন করা
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../config/database';
import { createToken, authMiddleware, AuthPayload, JWT_SECRET } from '../middleware/auth';
import { validateBody } from '../middleware/validation';
import { authLimiter } from '../middleware/rate-limiter';
import {
  registerSchema,
  loginSchema,
  walletAuthSchema,
  twoFactorVerifySchema,
  twoFactorDisableSchema,
  twoFactorLoginSchema,
} from '../schemas';
import {
  encryptSecret,
  decryptSecret,
  verifyTotp,
  generateTotpSecret,
} from '../utils/totp';
import { grantWelcomeBonus } from '../services/bonus';
import { verifyWalletSignature, buildSignMessage, detectWalletType } from '../utils/wallet-signature';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/register — নতুন অ্যাকাউন্ট তৈরি
// ══════════════════════════════════════════════════════════════
router.post('/register', authLimiter, validateBody(registerSchema), async (req: Request, res: Response) => {
  try {
    const { username, email, password, referralCode, fingerprint } = req.body;
    const ipAddress = (req.headers?.['x-forwarded-for'] as string || req.ip || '').split(',')[0].trim();

    // ইউজারনেম আগে থেকে আছে কিনা চেক
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'এই ইউজারনেম ইতিমধ্যে ব্যবহৃত।' });
    }

    let referredById: string | null = null;
    if (referralCode && referralCode.trim() !== '') {
      const referrer = await query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrer.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'প্রদত্ত রেফারেল কোডটি সঠিক নয়।' });
      }
      referredById = referrer.rows[0].id;
    }

    // Generate unique referral code
    let userReferralCode = '';
    let isUnique = false;
    while (!isUnique) {
      const rand = crypto.randomInt(100000, 1000000);
      userReferralCode = `CF${rand}`;
      const check = await query('SELECT id FROM users WHERE referral_code = $1', [userReferralCode]);
      if (check.rows.length === 0) {
        isUnique = true;
      }
    }

    // Fraud check parameters
    let shouldFlag = false;
    let fraudDetails: string[] = [];

    // 1. Check duplicate fingerprint
    if (fingerprint && fingerprint.trim() !== '') {
      const dupFingerprint = await query(
        'SELECT username FROM users WHERE fingerprint = $1 AND is_flagged = false LIMIT 1',
        [fingerprint]
      );
      if (dupFingerprint.rows.length > 0) {
        shouldFlag = true;
        fraudDetails.push(`আরেকটি অ্যাকাউন্টের সাথে ব্রাউজার ফিঙ্গারপ্রিন্ট মিলেছে: ${dupFingerprint.rows[0].username}`);
      }
    }

    // 2. Check registration IP count in past 24 hours
    if (ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
      const dupIpCount = await query(
        "SELECT count(*) FROM users WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [ipAddress]
      );
      if (parseInt(dupIpCount.rows[0].count || '0') >= 3) {
        shouldFlag = true;
        fraudDetails.push(`একই আইপি (${ipAddress}) থেকে ২৪ ঘণ্টায় ৩টির বেশি অ্যাকাউন্ট তৈরি করার চেষ্টা করা হয়েছে।`);
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    // Grant the welcome bonus through the canonical bonus service.
    // This:
    //   - reads the welcome amount from admin_settings (admin-editable)
    //   - inserts a bonus_claims row with idempotency on (user_id, 'welcome')
    //   - credits the user's bonus_balance + wagering_required
    //   - records a 'bonus' transactions row for the ledger
    //   - writes an audit_log entry
    //   - keeps users.balance in sync via the existing trigger
    //
    // The transaction wrapper keeps the bonus + audit atomic with the
    // users row insert. If the bonus fails the whole signup rolls back.
    const welcomeClaim = await withTransaction(async (tx) => {
      await tx(
        `INSERT INTO users (id, username, email, password_hash, balance, referred_by, referral_code, fingerprint, registration_ip, is_flagged)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9)`,
        [userId, username, email || null, passwordHash, referredById, userReferralCode, fingerprint || null, ipAddress, shouldFlag]
      );
      return grantWelcomeBonus(userId, tx as unknown as (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>);
    });

    // Record fraud flags
    if (shouldFlag) {
      for (const detail of fraudDetails) {
        await query(
          `INSERT INTO fraud_logs (user_id, type, ip_address, fingerprint, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            detail.includes('ফিঙ্গারপ্রিন্ট') ? 'multi_account_fingerprint' : 'multi_account_ip',
            ipAddress,
            fingerprint || null,
            detail
          ]
        );
      }
    }

    const token = createToken({ userId, username, isAdmin: false, role: 'user' });

    const bonusAmount = welcomeClaim?.amountCoins ?? 10;
    res.status(201).json({
      success: true,
      token,
      user: { userId, username, email: email || null, balance: bonusAmount, isFlagged: shouldFlag },
      message: `Welcome ${username}! $${bonusAmount.toFixed(2)} welcome bonus has been added to your account.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/login — লগইন
// ══════════════════════════════════════════════════════════════
router.post('/login', authLimiter, validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    const result = await query(
      'SELECT id, username, email, password_hash, balance, is_admin, role, two_factor_enabled FROM users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'ইউজারনেম বা পাসওয়ার্ড ভুল।' });
    }

    const user = result.rows[0];
    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'ইউজারনেম বা পাসওয়ার্ড ভুল।' });
    }

    // ২এফএ চালু থাকলে টেম্পোরারি টোকেন রিটার্ন করো
    if (user.two_factor_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, username: user.username, isAdmin: user.is_admin, role: user.role, isTemp: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({
        success: true,
        require2FA: true,
        tempToken,
        message: '২এফএ যাচাইকরণ প্রয়োজন।',
      });
    }

    // Admin accounts MUST have 2FA enabled in production.
    // Startup validation in index.ts guarantees ADMIN_2FA_REQUIRED is set.
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED === 'true';
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED === 'true';
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED !== 'false';
    if (enforceAdmin2FA && user.is_admin) {
      return res.status(403).json({
        success: false,
        require2FASetup: true,
        error: 'Admin access requires two-factor authentication. Set up 2FA before logging in.',
      });
    }

    const token = createToken({
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin,
      role: user.role,
    });

    res.json({
      success: true,
      token,
      user: {
        userId: user.id,
        username: user.username,
        email: user.email,
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
//  POST /api/auth/wallet — MetaMask ওয়ালেট দিয়ে লগইন
// ══════════════════════════════════════════════════════════════
router.post('/wallet', authLimiter, validateBody(walletAuthSchema), async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature, fingerprint } = req.body;
    const ipAddress = (req.headers?.['x-forwarded-for'] as string || req.ip || '').split(',')[0].trim();

    const walletType = detectWalletType(walletAddress);
    const expectedMessage = buildSignMessage(walletAddress);

    if (!verifyWalletSignature(walletAddress, signature, expectedMessage)) {
      return res.status(401).json({ success: false, error: 'ওয়ালেট স্বাক্ষর যাচাই ব্যর্থ হয়েছে।' });
    }

    let user = await query(
      'SELECT id, username, balance, is_admin, role, two_factor_enabled, is_flagged FROM users WHERE wallet_address = $1',
      [walletAddress.toLowerCase()]
    );

    // নতুন ওয়ালেট হলে অটো রেজিস্ট্রেশন
    if (!user.rows.length) {
      const userId = uuidv4();
      const username = `player_${walletAddress.slice(2, 8).toLowerCase()}`;

      // Generate unique referral code
      let userReferralCode = '';
      let isUnique = false;
      while (!isUnique) {
        const rand = crypto.randomInt(100000, 1000000);
        userReferralCode = `CF${rand}`;
        const check = await query('SELECT id FROM users WHERE referral_code = $1', [userReferralCode]);
        if (check.rows.length === 0) {
          isUnique = true;
        }
      }

      // Fraud check parameters
      let shouldFlag = false;
      let fraudDetails: string[] = [];

      // 1. Check duplicate fingerprint
      if (fingerprint && fingerprint.trim() !== '') {
        const dupFingerprint = await query(
          'SELECT username FROM users WHERE fingerprint = $1 AND is_flagged = false LIMIT 1',
          [fingerprint]
        );
        if (dupFingerprint.rows.length > 0) {
          shouldFlag = true;
          fraudDetails.push(`আরেকটি অ্যাকাউন্টের সাথে ব্রাউজার ফিঙ্গারপ্রিন্ট মিলেছে: ${dupFingerprint.rows[0].username}`);
        }
      }

      // 2. Check registration IP count in past 24 hours
      if (ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
        const dupIpCount = await query(
          "SELECT count(*) FROM users WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '24 hours'",
          [ipAddress]
        );
        if (parseInt(dupIpCount.rows[0].count || '0') >= 3) {
          shouldFlag = true;
          fraudDetails.push(`একই আইপি (${ipAddress}) থেকে ২৪ ঘণ্টায় ৩টির বেশি অ্যাকাউন্ট তৈরি করার চেষ্টা করা হয়েছে।`);
        }
      }

      // Auto-register new wallet users with the same welcome bonus
      // as the email flow. balance starts at 0; the bonus service
      // will credit bonus_balance and keep users.balance in sync
      // via the trigger (bonus_balance_coins + withdrawable_balance_coins).
      const welcomeClaim = await withTransaction(async (tx) => {
        await tx(
          `INSERT INTO users (id, username, wallet_address, balance, referral_code, fingerprint, registration_ip, is_flagged)
           VALUES ($1, $2, $3, 0, $4, $5, $6, $7)`,
          [userId, username, walletAddress.toLowerCase(), userReferralCode, fingerprint || null, ipAddress, shouldFlag]
        );
        return grantWelcomeBonus(userId, tx as unknown as (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>);
      });

      // Record fraud flags
      if (shouldFlag) {
        for (const detail of fraudDetails) {
          await query(
            `INSERT INTO fraud_logs (user_id, type, ip_address, fingerprint, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              userId,
              detail.includes('ফিঙ্গারপ্রিন্ট') ? 'multi_account_fingerprint' : 'multi_account_ip',
              ipAddress,
              fingerprint || null,
              detail
            ]
          );
        }
      }

      user = await query('SELECT id, username, balance, is_admin, role, two_factor_enabled, is_flagged FROM users WHERE id = $1', [userId]);
      // welcomeClaim is intentionally discarded here — wallet-auth treats
      // the bonus like the email flow (no separate "new wallet" message).
    }

    const u = user.rows[0];

    // ২এফএ চালু থাকলে টেম্পোরারি টোকেন রিটার্ন করো
    if (u.two_factor_enabled) {
      const tempToken = jwt.sign(
        { userId: u.id, username: u.username, isAdmin: u.is_admin, role: u.role, isTemp: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({
        success: true,
        require2FA: true,
        tempToken,
        message: '২এফএ যাচাইকরণ প্রয়োজন।',
      });
    }

    // Admin accounts MUST have 2FA enabled in production.
    // Startup validation in index.ts guarantees ADMIN_2FA_REQUIRED is set.
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED === 'true';
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED === 'true';
    const enforceAdmin2FA = process.env.ADMIN_2FA_REQUIRED !== 'false';
    if (enforceAdmin2FA && u.is_admin) {
      return res.status(403).json({
        success: false,
        require2FASetup: true,
        error: 'Admin access requires two-factor authentication. Set up 2FA before logging in.',
      });
    }

    const token = createToken({ userId: u.id, username: u.username, isAdmin: u.is_admin, role: u.role });

    res.json({
      success: true,
      token,
      user: {
        userId: u.id,
        username: u.username,
        balance: parseFloat(u.balance),
        walletAddress: walletAddress.toLowerCase(),
        isAdmin: u.is_admin,
        isFlagged: u.is_flagged,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/setup — ২এফএ সেটআপ কি জেনারেট করো
// ══════════════════════════════════════════════════════════════
router.post('/2fa/setup', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId, username } = (req as Request & { user: AuthPayload }).user;

    const userResult = await query('SELECT email FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const email = userResult.rows[0].email || `${username}@coinmaster.internal`;
    const { secret, otpauthUrl } = generateTotpSecret(email);
    const encryptedSecret = encryptSecret(secret);

    await query(
      'UPDATE users SET two_factor_temp_secret = $1 WHERE id = $2',
      [encryptedSecret, userId]
    );

    res.json({
      success: true,
      secret,
      otpauthUrl,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/verify — ২এফএ সেটআপ ভেরিফাই ও এনেবল করো
// ══════════════════════════════════════════════════════════════
router.post('/2fa/verify', authMiddleware, validateBody(twoFactorVerifySchema), async (req: Request, res: Response) => {
  try {
    const { userId } = (req as Request & { user: AuthPayload }).user;
    const { token } = req.body;

    const userResult = await query(
      'SELECT two_factor_temp_secret FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const tempSecretEncrypted = userResult.rows[0].two_factor_temp_secret;
    if (!tempSecretEncrypted) {
      return res.status(400).json({ success: false, error: '২এফএ সেটআপ প্রথমে শুরু করুন।' });
    }

    const tempSecret = decryptSecret(tempSecretEncrypted);
    const isValid = verifyTotp(tempSecret, token);

    if (!isValid) {
      return res.status(400).json({ success: false, error: '২এফএ কোডটি সঠিক নয়।' });
    }

    await query(
      'UPDATE users SET two_factor_secret = two_factor_temp_secret, two_factor_enabled = true, two_factor_temp_secret = NULL WHERE id = $1',
      [userId]
    );

    res.json({
      success: true,
      message: '২এফএ সফলভাবে চালু করা হয়েছে।',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/disable — ২এফএ ডিজেবল করো
// ══════════════════════════════════════════════════════════════
router.post('/2fa/disable', authMiddleware, validateBody(twoFactorDisableSchema), async (req: Request, res: Response) => {
  try {
    const { userId } = (req as Request & { user: AuthPayload }).user;
    const { token } = req.body;

    const userResult = await query(
      'SELECT two_factor_secret, two_factor_enabled, is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const { two_factor_secret: secretEncrypted, two_factor_enabled: enabled, is_admin: isAdmin } = userResult.rows[0];
    if (!enabled || !secretEncrypted) {
      return res.status(400).json({ success: false, error: '২এফএ চালু নেই।' });
    }

    const secret = decryptSecret(secretEncrypted);
    const isValid = verifyTotp(secret, token);

    if (!isValid) {
      return res.status(400).json({ success: false, error: '২এফএ কোডটি সঠিক নয়।' });
    }

    // Admin accounts cannot disable 2FA — production requirement.
    if (isAdmin) {
      return res.status(403).json({ success: false, error: 'Admin accounts cannot disable two-factor authentication.' });
    }

    await query(
      'UPDATE users SET two_factor_secret = NULL, two_factor_enabled = false WHERE id = $1',
      [userId]
    );

    res.json({
      success: true,
      message: '২এফএ সফলভাবে বন্ধ করা হয়েছে।',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/login — ২এফএ কোড ভেরিফাই করে লগইন করো
// ══════════════════════════════════════════════════════════════
router.post('/2fa/login', authLimiter, validateBody(twoFactorLoginSchema), async (req: Request, res: Response) => {
  try {
    const { tempToken, token } = req.body;

    let decoded: any;
    try {
      decoded = jwt.verify(tempToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, error: 'টেম্পোরারি টোকেন অবৈধ বা মেয়াদোত্তীর্ণ।' });
    }

    if (!decoded.isTemp || !decoded.userId) {
      return res.status(401).json({ success: false, error: 'টেম্পোরারি টোকেন অবৈধ।' });
    }

    const userResult = await query(
      'SELECT id, username, balance, is_admin, role, two_factor_secret, two_factor_enabled FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি বা নিষ্ক্রিয়।' });
    }

    const user = userResult.rows[0];
    if (!user.two_factor_enabled || !user.two_factor_secret) {
      return res.status(400).json({ success: false, error: 'এই ইউজারের জন্য ২এফএ চালু নেই।' });
    }

    const secret = decryptSecret(user.two_factor_secret);
    const isValid = verifyTotp(secret, token);

    if (!isValid) {
      return res.status(401).json({ success: false, error: '২এফএ কোডটি সঠিক নয়।' });
    }

    const authToken = createToken({
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin,
      role: user.role,
    });

    res.json({
      success: true,
      token: authToken,
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
//  GET /api/auth/me — বর্তমান ইউজারের তথ্য
// ══════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as Request & { user: AuthPayload }).user;

    const result = await query(
      'SELECT id, username, email, wallet_address, balance, is_admin, role, two_factor_enabled, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
    }

    const u = result.rows[0];
    // Map role for the admin shell: prefer explicit role column,
    // fall back to is_admin flag for older DB rows.
    const role = u.role || (u.is_admin ? 'super_admin' : 'user');
    res.json({
      success: true,
      data: {
        userId: u.id,
        username: u.username,
        email: u.email,
        walletAddress: u.wallet_address,
        balance: parseFloat(u.balance),
        isAdmin: u.is_admin,
        role,
        two_factor_enabled: u.two_factor_enabled,
        joinedAt: u.created_at,
      },
      // Legacy shape — keep backward compat with older frontend code
      // (LoginModal etc.) that reads `data.user` instead of `data.data`.
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
