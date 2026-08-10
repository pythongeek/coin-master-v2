/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN 2FA MIDDLEWARE — S1-C5
 * ═══════════════════════════════════════════════════════════════
 *
 *  Enforces admin 2FA on endpoints that move funds or change
 *  irreversible state. The DB-driven `admin_2fa_required` setting
 *  gates the whole thing: if false, the middleware is a no-op.
 *
 *  When required, the admin must include a valid TOTP token in the
 *  `X-Admin-2FA-Token` header. The token is validated against the
 *  admin's `totp_secret_encrypted` column. A bypass window is
 *  honored via `totp_verified_at` (same pattern as user-withdrawal
 *  2FA step-up, see routes/wallet.ts:152).
 *
 *  Audit log: every 2FA event (success or fail) is recorded with
 *  severity 'warn' (fail) or 'info' (success).
 *
 *  Audit ref:  PROD_AUDIT_2026-08-07.md → C5, ACCESS-1
 *  Severity:   CRITICAL — stolen super_admin token otherwise drains
 *              all pending withdrawals.
 * ═══════════════════════════════════════════════════════════════
 */

import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { getAdminSetting, getAdminSettingBool } from '../services/admin-settings.service';
import { decryptSecret, verifyTotp } from '../utils/totp';

const ADMIN_2FA_GRACE_MIN_DEFAULT = 5;

export interface Admin2FARequest extends Request {
  user: { userId: string; username?: string; isAdmin?: boolean; role?: string };
}

/**
 * Express middleware that enforces admin 2FA when admin_2fa_required
 * is on. Attaches "result: 'ok' | 'bypassed' | 'failed'" to res.locals
 * for downstream handlers and audit logging.
 */
export async function requireAdmin2FA(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = (req as Admin2FARequest).user;
    if (!user?.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const adminId = user.userId;

    const required = await getAdminSettingBool('admin_2fa_required', false);
    if (!required) {
      // No 2FA enforced — pass through.
      res.locals.admin2fa = { result: 'bypassed' };
      next();
      return;
    }

    // Read admin's TOTP state.
    const userRes = await query(
      'SELECT totp_enabled, totp_secret_encrypted, totp_verified_at FROM users WHERE id = $1',
      [adminId],
    );
    const u = userRes.rows[0];

    if (!u?.totp_enabled || !u.totp_secret_encrypted) {
      // Admin must enroll TOTP before using 2FA-protected endpoints.
      await safeAuditLog(
        adminId,
        'blocked',
        'admin has no TOTP enrolled; admin_2fa_required=true',
      );
      res.status(403).json({
        success: false,
        error: 'Admin 2FA required but not enrolled. Enroll at /admin/security.',
      });
      return;
    }

    // Bypass grace window: same code path as user-side withdrawal 2FA.
    // admin_2fa_grace_minutes is a string in admin_settings; default to 5.
    const graceStr = await getAdminSetting('admin_2fa_grace_minutes', String(ADMIN_2FA_GRACE_MIN_DEFAULT));
    const graceMin = parseInt(graceStr ?? String(ADMIN_2FA_GRACE_MIN_DEFAULT), 10) || ADMIN_2FA_GRACE_MIN_DEFAULT;

    const lastOk = u.totp_verified_at ? new Date(u.totp_verified_at).getTime() : 0;
    const withinGrace = Date.now() - lastOk < graceMin * 60 * 1000;

    if (withinGrace) {
      res.locals.admin2fa = { result: 'ok', via: 'grace' };
      next();
      return;
    }

    // Require fresh TOTP.
    const code = (req.headers['x-admin-2fa-token'] as string | undefined)?.trim();
    if (!code) {
      await safeAuditLog(
        adminId,
        'blocked',
        'X-Admin-2FA-Token header missing on 2FA-protected admin action',
      );
      res.status(403).json({
        success: false,
        error: 'Admin 2FA required. Provide X-Admin-2FA-Token header.',
        requires_2fa: true,
      });
      return;
    }

    let secret: string;
    try {
      secret = decryptSecret(u.totp_secret_encrypted);
    } catch (err) {
      await safeAuditLog(
        adminId,
        'blocked',
        'failed to decrypt admin TOTP secret',
      );
      res.status(500).json({
        success: false,
        error: 'Admin 2FA state inconsistent. Contact support.',
      });
      return;
    }

    if (!verifyTotp(secret, code)) {
      await safeAuditLog(
        adminId,
        'blocked',
        'X-Admin-2FA-Token failed TOTP verification',
      );
      res.status(403).json({
        success: false,
        error: 'Invalid Admin 2FA token',
      });
      return;
    }

    // Mark the admin's totp_verified_at so the grace window starts.
    await query(
      'UPDATE users SET totp_verified_at = NOW() WHERE id = $1',
      [adminId],
    );
    await safeAuditLog(
      adminId,
      'ok',
      'X-Admin-2FA-Token verified; admin action approved',
    );

    res.locals.admin2fa = { result: 'ok', via: 'totp' };
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('requireAdmin2FA middleware error:', msg);
    next(err);
  }
}

/**
 * Best-effort audit log writer. Never throws — admin 2FA failure
 * should never break the request pipeline.
 */
async function safeAuditLog(
  adminId: string,
  result: 'ok' | 'blocked',
  detail: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('security', 'admin_2fa.${result}', $1, $2, $3)`,
      [
        result === 'ok' ? 'info' : 'warn',
        adminId,
        JSON.stringify({ source: 'requireAdmin2FA', detail }),
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('requireAdmin2FA: audit log write failed:', err);
  }
}
