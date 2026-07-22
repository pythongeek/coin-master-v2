/**
 * =============================================================
 *  2FA (TOTP) ROUTES - enrollment + verification for withdrawals
 * =============================================================
 *
 *  Flow for withdrawal step-up:
 *    1. User enables 2FA via /api/auth/2fa/setup -> /api/auth/2fa/verify
 *    2. When user requests a withdrawal > threshold (admin-configurable):
 *         a. Server returns 403 with { requires_2fa: true, graceMinutes: 5 }
 *            if user has no recent 2FA within the grace window.
 *         b. User submits TOTP code alongside withdrawal (header: X-2FA-Code).
 *         c. Server verifies + logs + processes withdrawal.
 *         d. Subsequent withdrawals within `graceMinutes` skip the check.
 *
 *  Why step-up (not always-required):
 *    - Friction: requiring 2FA on every withdrawal hurts UX for tiny amounts
 *    - Risk-based: most theft happens at large amounts; small ones are fine
 *    - Industry standard: Coinbase/Gemini use step-up above $X threshold
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { query } from '../config/database';
import {
  encryptSecret,
  decryptSecret,
  generateTotpSecret,
  verifyTotp,
} from '../utils/totp';


const router = Router();

interface AuthRequest extends Request {
  user?: AuthPayload;
}

/**
 * POST /api/auth/2fa/setup
 * Returns an otpauth URL + base64 QR code. Does NOT enable 2FA yet
 * — user must verify a TOTP code first via /verify.
 */
router.post('/setup', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Get user email for the otpauth label
    const userRes = await query(
      'SELECT email, username FROM users WHERE id = $1',
      [userId],
    );
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const label = userRes.rows[0].email || userRes.rows[0].username;
    const issuer = 'CryptoFlip';

    const { secret, otpauthUrl } = generateTotpSecret(label, issuer);

    // Store encrypted secret (NOT enabled yet, until /verify)
    const encrypted = encryptSecret(secret);
    await query(
      `UPDATE users
       SET totp_secret_encrypted = $1, totp_enabled = false
       WHERE id = $2`,
      [encrypted, userId],
    );

    // Generate base64 QR code for the otpauth URL.
    // Using Google Charts API (works offline-friendly), but the otpauth:// URL
    // can be pasted into any TOTP app (Google Authenticator, Authy, etc.).
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(otpauthUrl)}&size=200x200`;

    res.json({
      success: true,
      secret,           // shown once for manual entry if QR fails
      otpauthUrl,
      qrCodeUrl: qrUrl,
      message: 'Scan the QR code in your authenticator app, then call /verify with a 6-digit code.',
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/auth/2fa/verify
 * Verifies a TOTP code AND enables 2FA (only on first verify).
 * Subsequent verifies are recorded in two_factor_log but don't change enabled state.
 *
 * Body: { code: '123456', action?: 'login' | 'withdraw' | 'admin_action' }
 */
router.post('/verify', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const body = req.body as { code?: string; token?: string; action?: string };
    const code = (body.code || body.token || '').trim();
    const action = body.action;
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Code must be 6 digits' });
    }

    const userRes = await query(
      'SELECT totp_secret_encrypted, totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (!userRes.rows.length || !userRes.rows[0].totp_secret_encrypted) {
      return res.status(400).json({ success: false, error: '2FA not set up. Call /setup first.' });
    }
    const secret = decryptSecret(userRes.rows[0].totp_secret_encrypted);
    const ok = verifyTotp(secret, code);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Invalid or expired code' });
    }

    // First successful verify -> enable 2FA + record verified_at.
    if (!userRes.rows[0].totp_enabled) {
      await query(
        `UPDATE users SET totp_enabled = true, totp_verified_at = NOW() WHERE id = $1`,
        [userId],
      );
    } else {
      // Subsequent verifications just refresh the timestamp (used for grace window)
      await query(
        `UPDATE users SET totp_verified_at = NOW() WHERE id = $1`,
        [userId],
      );
    }

    // Audit log
    await query(
      `INSERT INTO two_factor_log (user_id, action, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [userId, action || 'verify', req.ip, ((req.headers['user-agent'] as string) || '').slice(0, 500)],
    );

    res.json({ success: true, enabled: true });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/auth/2fa/disable
 * Disables 2FA. Requires password confirmation in body for safety.
 *
 * Body: { password: '...' }
 */
router.post('/disable', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { password } = req.body as { password?: string };
    if (!password) return res.status(400).json({ success: false, error: 'Password required' });

    // Verify password (defense against stolen session cookie)
    const bcrypt = await import('bcryptjs');
    const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const pwOk = await bcrypt.compare(password, userRes.rows[0].password_hash);
    if (!pwOk) return res.status(401).json({ success: false, error: 'Invalid password' });

    await query(
      `UPDATE users SET totp_enabled = false, totp_secret_encrypted = NULL, totp_verified_at = NULL WHERE id = $1`,
      [userId],
    );
    res.json({ success: true, message: '2FA disabled' });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * GET /api/auth/2fa/status
 * Returns whether 2FA is enabled + last verification timestamp (for grace window).
 */
router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const userRes = await query(
      'SELECT totp_enabled, totp_verified_at FROM users WHERE id = $1',
      [userId],
    );
    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    const u = userRes.rows[0];
    res.json({
      success: true,
      enabled: u.totp_enabled,
      verifiedAt: u.totp_verified_at,
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

export default router;