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
import { getAdminSettingBool } from '../services/admin-settings.service';
import { validateBody } from '../middleware/validation';
import { authLimiter, registerStrictLimiter } from '../middleware/rate-limiter';
import { hcaptchaMiddleware } from '../middleware/hcaptcha';
import {
  registerSchema,
  loginSchema,
  walletAuthSchema,
} from '../schemas';
import { grantWelcomeBonus } from '../services/bonus';
import { verifyWalletSignature, buildSignMessage, detectWalletType } from '../utils/wallet-signature';
import { isIpWhitelisted } from '../services/ip-whitelist';
import { isBlockedEmailDomain } from '../config/blocked-email-domains';
import { getAdminSettingNumber as getAdminSettingInt } from '../services/admin-settings.service';
import { recordDeviceUse } from '../services/device-fingerprint';
import { checkFingerprintRegistrationCap } from '../services/fingerprint-fraud-cap';
import { detectSelfReferral, recordSelfReferralVerdict, SelfReferralCheck } from '../services/affiliate-guard';
import { alertDeviceCluster, alertSelfReferral } from '../services/fraud-alerts';
import { recalculateRisk } from '../services/ai-risk-engine';

const router = Router();

// ══════════════════════════════════════════════════════════════
//  POST /api/auth/register — নতুন অ্যাকাউন্ট তৈরি
// ══════════════════════════════════════════════════════════════
//
//  P1-12 layered defense against automated signup + bonus abuse:
//   1. `registerStrictLimiter` (3/min/IP) — tight burst limit (Redis Lua bucket).
//   2. `hcaptchaMiddleware` — fails closed only when HCAPTCHA_SECRET is
//      set in env; bypasses in dev/test so unit tests can run.
//   3. `checkFingerprintRegistrationCap` — fails with HTTP 429 when
//      the device fingerprint already has `cap` accounts in the
//      last 24h. Caps work per device, complementing the per-IP
//      `fraud_max_accounts_per_ip_24h` cap already in this handler.
//
router.post(
  '/register',
  registerStrictLimiter,
  validateBody(registerSchema),
  hcaptchaMiddleware,
  async (req: Request, res: Response) => {
  try {
    const { username, email, password, referralCode, fingerprint } = req.body;
    const ipAddress = (req.headers?.['x-forwarded-for'] as string || req.ip || '').split(',')[0].trim();

    // ইউজারনেম আগে থেকে আছে কিনা চেক
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'এই ইউজারনেম ইতিমধ্যে ব্যবহৃত।' });
    }

    // ── P0-2: Disposable-email domain blocklist ──
    // Throws away throwaway accounts that exist purely to claim the
    // welcome bonus. Block at signup so the user exists and never
    // gets a chance to claim. The fingerprint check below still applies.
    if (email && isBlockedEmailDomain(email)) {
      await query(
        `INSERT INTO audit_log (category, action, severity, details)
         VALUES ('fraud', 'signup.blocked.disposable_email', 'warn', $1)`,
        [JSON.stringify({ email, ip: ipAddress })],
      );
      return res.status(400).json({
        success: false,
        error: 'Please use a permanent email address. Disposable / temporary mail providers are not allowed.',
      });
    }

    let referredById: string | null = null;
    let selfReferralVerdict: SelfReferralCheck | null = null;
    let shouldFlag = false;
    let fraudDetails: string[] = [];
    if (referralCode && referralCode.trim() !== '') {
      const referrer = await query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrer.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'প্রদত্ত রেফারেল কোডটি সঠিক নয়।' });
      }
      referredById = referrer.rows[0].id;

      // Phase 1.4: Self-referral detection. If the referee and referrer
      // share device or IP, suspect self-referral. 'block' → drop the
      // commission link; 'flag' → keep link but flag the referee.
      try {
        if (referredById) {
          selfReferralVerdict = await detectSelfReferral(referredById, fingerprint, ipAddress);
          if (selfReferralVerdict.action === 'block') {
            // Drop the commission link silently — the referrer still has
            // a valid code; we just don't pay out for this self-link.
            referredById = null;
          }
          if (selfReferralVerdict.action === 'flag' || selfReferralVerdict.action === 'block') {
            shouldFlag = true;
            const detailBn = selfReferralVerdict.action === 'block'
              ? `সেলফ-রেফারেল সন্দেহ (${selfReferralVerdict.reason}) — কমিশন লিংক বাতিল।`
              : `সেলফ-রেফারেল সন্দেহ (${selfReferralVerdict.reason}) — নজরে রাখা হচ্ছে।`;
            fraudDetails.push(detailBn);
          }
        }
      } catch (e) {
        // Non-fatal — best-effort detection.
        // eslint-disable-next-line no-console
        console.error('[signup] self-referral detect failed:', e);
      }
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

    // Fraud check parameters (already declared above for self-referral)
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
    //    P0-3 hardening: at `fraud_max_accounts_per_ip_24h` accounts from
    //    this IP in the last 24h, the signup is BLOCKED outright (not just
    //    flagged) so the bonus never lands. The admin can relax the cap
    //    by editing admin_settings.fraud_max_accounts_per_ip_24h.
    const ipWhitelisted = await isIpWhitelisted(ipAddress);
    if (!ipWhitelisted && ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
      const ipCap = await getAdminSettingInt('fraud_max_accounts_per_ip_24h', 3, true);
      const dupIpCount = await query(
        "SELECT count(*) FROM users WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [ipAddress]
      );
      const ipCount = parseInt(dupIpCount.rows[0].count || '0');
      if (ipCount >= ipCap) {
        // BLOCK outright (vs. existing flag-only behavior).
        await query(
          `INSERT INTO audit_log (category, action, severity, details)
           VALUES ('fraud', 'signup.blocked.ip_rate_limit', 'error', $1)`,
          [JSON.stringify({ ip: ipAddress, count: ipCount, cap: ipCap })],
        );
        return res.status(429).json({
          success: false,
          error: `Too many accounts created from this network recently (${ipCount} in last 24h). Please try again later or contact support.`,
        });
      }
      if (ipCount >= ipCap - 1) {
        // One away from cap — flag so withdrawal is gated.
        shouldFlag = true;
        fraudDetails.push(`একই আইপি (${ipAddress}) থেকে ২৪ ঘণ্টায় ${ipCount}টি অ্যাকাউন্ট তৈরি করা হয়েছে (ক্যাপ ${ipCap}) — নজরে রাখা হচ্ছে।`);
      }
    }

    // 3. P1-12 — Per-device fingerprint cap (24h).
    //    Independent of the IP cap: a botnet rotating IPs still has
    //    the same browser/device fingerprint, so this caps signup
    //    regardless of network identity. Admin-tunable via
    //    admin_settings.fraud_max_accounts_per_fingerprint_24h (default 3).
    const fpCap = await checkFingerprintRegistrationCap(fingerprint, ipAddress);
    if (!fpCap.allowed) {
      await query(
        `INSERT INTO audit_log (category, action, severity, details)
         VALUES ('fraud', 'signup.blocked.fingerprint_rate_limit', 'error', $1)`,
        [JSON.stringify({
          ip: ipAddress,
          fingerprint_hash: fpCap.fingerprintHash,
          count_24h: fpCap.countInLast24h,
          cap: fpCap.cap,
        })],
      );
      return res.status(429).json({
        success: false,
        error: `Too many accounts created from this device recently (${fpCap.countInLast24h} in last 24h, cap ${fpCap.cap}). Please try again later.`,
      });
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

    // ── Phase 1.1: Device fingerprint registry ──
    // Record this user on the device. If the device is already linked
    // to other accounts, flag + audit. Runs after user insert because
    // the registry needs a userId.
    if (fingerprint && fingerprint.trim() !== '') {
      try {
        const decision = await recordDeviceUse(userId, fingerprint, {
          ua: req.headers['user-agent'] ?? null,
          ip: ipAddress,
        });
        if (decision && decision.shouldFlag) {
          shouldFlag = true;
          fraudDetails.push(
            `ডিভাইস ফিঙ্গারপ্রিন্ট অন্য ${decision.accountCount - 1}টি অ্যাকাউন্টের সাথে শেয়ার করা হয়েছে (trust=${decision.trustLevel})`,
          );
          await query(
            `INSERT INTO audit_log (category, action, severity, user_id, details)
             VALUES ('fraud', 'signup.flagged.device_shared', 'warn', $1, $2)`,
            [userId, JSON.stringify({
              device_account_count: decision.accountCount,
              existing_user_ids: decision.existingUserIds,
              trust_level: decision.trustLevel,
              reason: decision.reason,
            })],
          );
          // Phase 1.5: emit fraud alert (severity scales with cluster size).
          try {
            await alertDeviceCluster(userId, decision.fingerprintHash, decision.accountCount);
          } catch { /* alert fan-out is best-effort */ }
        }
      } catch (e) {
        // Non-fatal — the legacy users.fingerprint column still flags.
        // eslint-disable-next-line no-console
        console.error('[signup] device-fingerprint record failed:', e);
      }
    }

    // Phase 2.3: IP reputation + initial risk score. The IP
    // reputation service writes fraud_signals rows (tor / datacenter
    // / known_fraud / proxy) that the risk engine then aggregates.
    // Best-effort — risk computation failure must never break signup.
    try {
      await recalculateRisk(userId, { ip: ipAddress });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[signup] recalculateRisk failed:', e);
    }

    // Phase 1.4: drop a fraud_signals row if self-referral was detected
    // (so Phase 1.2 risk engine can score this user up). Best-effort.
    if (selfReferralVerdict && selfReferralVerdict.action !== 'allow') {
      try {
        await recordSelfReferralVerdict(userId, selfReferralVerdict);
        // Phase 1.5: emit alert (only on block; flag is informational only).
        if (selfReferralVerdict.action === 'block') {
          const matchedSignals = [
            selfReferralVerdict.signals.sameDevice && 'same_device',
            selfReferralVerdict.signals.sameIp && 'same_ip',
            selfReferralVerdict.signals.sameKyc && 'same_kyc',
          ].filter(Boolean) as string[];
          try {
            await alertSelfReferral(userId, selfReferralVerdict.referrerId, matchedSignals);
          } catch { /* alert fan-out is best-effort */ }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[signup] recordSelfReferralVerdict failed:', e);
      }
    }

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

    // Determine whether 2FA is required for this user.
    const admin2faRequired = await getAdminSettingBool('admin_2fa_required', false);
    const isAdmin = (user as any).is_admin;
    const require2FAForThisUser = user.two_factor_enabled || (isAdmin && admin2faRequired);

    if (require2FAForThisUser) {
      // If the admin 2FA toggle is off, an admin with 2FA already configured can still
      // log in in one shot. The toggle only forces 2FA when on.
      if (isAdmin && !admin2faRequired) {
        // proceed to token below
      } else {
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
    }

    // Admin accounts MUST have 2FA enabled when admin_2fa_required is true.
    if (admin2faRequired && isAdmin) {
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
      //    (skip if IP is in admin whitelist)
      const ipWhitelistedWallet = await isIpWhitelisted(ipAddress);
      if (!ipWhitelistedWallet && ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
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

    // Determine whether 2FA is required for this user.
    const admin2faRequired = await getAdminSettingBool('admin_2fa_required', false);
    const isAdmin = (u as any).is_admin;
    const require2FAForThisUser = u.two_factor_enabled || (isAdmin && admin2faRequired);

    if (require2FAForThisUser) {
      if (isAdmin && !admin2faRequired) {
        // proceed to token below
      } else {
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
    }

    // Admin accounts MUST have 2FA enabled when admin_2fa_required is true.
    if (admin2faRequired && isAdmin) {
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
