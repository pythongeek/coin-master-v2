// ══════════════════════════════════════════════════════════════
//  ADMIN AUTH ROUTES — /api/admin/*
//
//  DEDICATED admin-only auth surface. Intentionally separate from
//  /api/auth/* (which serves all users). Differences from user auth:
//
//    - Cookie name:    admin_cf_token (not cf_token). Scoped to
//                      Path=/api/admin so it never leaks to the user
//                      login modal or game endpoints.
//
//    - Cookie TTL:     1 hour (not 7 days). Shorter window = smaller
//                      blast radius if a stolen admin cookie is replayed.
//
//    - Rate limit:     3 attempts per 5 minutes per IP (adminAuthLimiter,
//                      stricter than user authLimiter's 5/min).
//
//    - Path:           Served directly by nginx → backend:4000. The
//                      Next.js catch-all proxy at frontend:3002 is NOT in
//                      the path (nginx config routes /api/admin/*
//                      directly). The cookie's Path=/api/admin matches.
//
//    - Audit:          Every successful and failed login is written to
//                      audit_log with actor_user_id, source_ip, and
//                      result so a stolen credential leaves a paper trail.
// ══════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authLimiter as _unused } from '../middleware/rate-limiter'; // re-export reference, not used
import { validateBody } from '../middleware/validation';
import { z } from 'zod';
import { createToken as makeUserToken, JWT_SECRET } from '../middleware/auth';
import { decryptSecret, verifyTotp } from '../utils/totp';

// ─────────────────────────────────────────────────────────────────
//  Rate limiter — admin login is much stricter than user login.
//  3 attempts per 5 minutes per IP. Long window = brute-force resistant.
// ─────────────────────────────────────────────────────────────────
export const adminAuthLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many admin login attempts. Try again in a few minutes.',
      code: 'ADMIN_LOGIN_RATE_LIMITED',
    });
  },
});

const adminLoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const ADMIN_COOKIE_NAME = 'admin_cf_token';
// Path is `/` (not `/api/admin`) so the browser sends the cookie when
// the operator navigates to the admin page URL (e.g. /sysop-.../admin).
// Isolation from user auth is by NAME (`admin_cf_token` vs `cf_token`):
// user routes read `cf_token` (which the admin login flow never sets),
// admin routes read `admin_cf_token`. A leaked admin cookie cannot
// authenticate to user endpoints because the user middleware only
// inspects `cf_token`.
const ADMIN_COOKIE_PATH = '/';
const ADMIN_COOKIE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function setAdminCookie(res: Response, token: string): void {
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ADMIN_COOKIE_TTL_MS,
    path: ADMIN_COOKIE_PATH,
  });
}

function clearAdminCookie(res: Response): void {
  res.cookie(ADMIN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: ADMIN_COOKIE_PATH,
  });
}

// Minimal admin-scoped JWT — keeps payload small and lifetime short.
// We DON'T share the user auth token shape; the admin cookie lives only
// in /api/admin/* thanks to Path scoping.
interface AdminAuthPayload {
  userId: string;
  username: string;
  role: string;
  isAdmin: true;
  scope: 'admin';
}

export function makeAdminToken(user: { id: string; username: string; role: string }): string {
  const payload: AdminAuthPayload = {
    userId: user.id,
    username: user.username,
    role: user.role,
    isAdmin: true,
    scope: 'admin',
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

export function verifyAdminToken(token: string): AdminAuthPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AdminAuthPayload;
    if (decoded.scope !== 'admin' || decoded.isAdmin !== true) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Mount this router at /api/admin in index.ts.
// ─────────────────────────────────────────────────────────────────
export const adminAuthRouter = Router();

// ─── POST /api/admin/login ─────────────────────────────────────
adminAuthRouter.post(
  '/login',
  adminAuthLimiter,
  validateBody(adminLoginSchema),
  async (req: Request, res: Response) => {
    const { username, password } = req.body as { username: string; password: string };
    const sourceIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    try {
      const result = await query(
        `SELECT id, username, email, password_hash, role, is_admin, is_active,
                two_factor_enabled, totp_enabled, totp_secret_encrypted
           FROM users
          WHERE username = $1 AND is_active = true`,
        [username],
      );

      if (!result.rows.length) {
        await safeAuditLog({
          actor_user_id: null,
          action: 'admin.login.failed',
          source_ip: sourceIp,
          result: 'user_not_found',
          meta: { username },
        });
        return res.status(401).json({ success: false, error: 'Invalid credentials.' });
      }

      const user = result.rows[0];
      const passwordOk = await bcrypt.compare(password, user.password_hash);
      if (!passwordOk || !user.is_admin) {
        await safeAuditLog({
          actor_user_id: user.id,
          action: 'admin.login.failed',
          source_ip: sourceIp,
          result: passwordOk ? 'not_admin' : 'bad_password',
          meta: { username },
        });
        return res.status(401).json({ success: false, error: 'Invalid credentials.' });
      }

      // ─── TOTP step-up (matches require-admin-2fa.ts + auth.ts pattern) ───
      // The authoritative TOTP enrollment columns are `totp_enabled` and
      // `totp_secret_encrypted` (migration 025). The legacy `two_factor_enabled`
      // column (migration 001) is never written by the current enrollment flow,
      // so it would always be false even after the user enables 2FA.
      //
      // If the admin has TOTP enrolled, require a 6-digit TOTP code in the
      // request body. On missing/invalid code, return 401 with
      // { requires2FA: true } so the frontend can show a TOTP input.
      if (user.totp_enabled && user.totp_secret_encrypted) {
        const totpCode = typeof req.body.totp_code === 'string'
          ? req.body.totp_code.trim()
          : '';
        if (!totpCode) {
          await safeAuditLog({
            actor_user_id: user.id,
            action: 'admin.login.failed',
            source_ip: sourceIp,
            result: 'totp_missing',
            meta: { username },
          });
          return res.status(401).json({
            success: false,
            error: '2FA code required.',
            requires2FA: true,
          });
        }
        let secret: string;
        try {
          secret = decryptSecret(user.totp_secret_encrypted);
        } catch (decryptErr) {
          await safeAuditLog({
            actor_user_id: user.id,
            action: 'admin.login.failed',
            source_ip: sourceIp,
            result: 'totp_decrypt_error',
            meta: { username },
          });
          return res.status(500).json({
            success: false,
            error: '2FA verification unavailable. Contact an operator.',
          });
        }
        const totpValid = verifyTotp(secret, totpCode, 1);
        if (!totpValid) {
          await safeAuditLog({
            actor_user_id: user.id,
            action: 'admin.login.failed',
            source_ip: sourceIp,
            result: 'totp_invalid',
            meta: { username },
          });
          return res.status(401).json({
            success: false,
            error: 'Invalid 2FA code.',
            requires2FA: true,
          });
        }
      }

      const token = makeAdminToken({ id: user.id, username: user.username, role: user.role });
      setAdminCookie(res, token);

      await safeAuditLog({
        actor_user_id: user.id,
        action: 'admin.login.success',
        source_ip: sourceIp,
        result: 'ok',
        meta: { username, role: user.role, scope: 'admin', totp_used: !!(user.totp_enabled && user.totp_secret_encrypted) },
      });

      return res.json({
        success: true,
        user: {
          userId: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          two_factor_enabled: user.two_factor_enabled,
        },
        // Token included for non-cookie paths (server-to-server); browsers
        // pick up the cookie automatically because we set credentials:'include'.
        token,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, error: message });
    }
  },
);

// ─── GET /api/admin/me ────────────────────────────────────────
//  Returns the admin user from the admin_cf_token cookie. Bypasses
//  /api/auth/me entirely so a user's cf_token cannot leak admin info.
// ─────────────────────────────────────────────────────────────────
adminAuthRouter.get('/me', async (req: Request, res: Response) => {
  const cookieHeader = req.headers.cookie;
  const token = (() => {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== ADMIN_COOKIE_NAME) continue;
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
  })();

  if (!token) {
    return res.status(401).json({ success: false, error: 'Admin session not found.' });
  }
  const decoded = verifyAdminToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Admin session invalid or expired.' });
  }

  try {
    const result = await query(
      `SELECT id, username, email, role, is_admin, two_factor_enabled
         FROM users WHERE id = $1 AND is_active = true`,
      [decoded.userId],
    );
    if (!result.rows.length || !result.rows[0].is_admin) {
      return res.status(403).json({ success: false, error: 'Admin privilege revoked.' });
    }
    const u = result.rows[0];
    return res.json({
      success: true,
      user: {
        userId: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        two_factor_enabled: u.two_factor_enabled,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
});

// ─── POST /api/admin/logout ───────────────────────────────────
//  Always clears the admin cookie. Idempotent.
// ─────────────────────────────────────────────────────────────────
adminAuthRouter.post('/logout', (req: Request, res: Response) => {
  clearAdminCookie(res);
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
//  Helper: best-effort audit log writer. Never throws into the
//  request path — if audit_log is down, the login still works.
// ─────────────────────────────────────────────────────────────────
async function safeAuditLog(entry: {
  actor_user_id: string | null;
  action: string;
  source_ip: string;
  result: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  try {
    // Map result → severity for the audit_log.severity enum column.
    // The audit_log schema (see backend/src/db/schema.sql):
    //   id          uuid PK
    //   user_id     uuid  ← was named actor_user_id in earlier schema
    //   category    varchar(20)  ← 'auth' / 'admin' / 'security' / ...
    //   action      varchar(100) ← e.g. 'admin.login.success'
    //   ip_address  inet
    //   user_agent  text
    //   details     jsonb
    //   severity    varchar(10) ← 'info' | 'warn' | 'error'
    const severity = entry.result === 'ok'
      ? 'info'
      : (entry.result === 'user_not_found' || entry.result === 'bad_password' || entry.result === 'not_admin')
        ? 'warn'
        : 'error';
    await query(
      `INSERT INTO audit_log
         (user_id, action, ip_address, details, severity, category, user_agent)
       VALUES ($1, $2, $3::inet, $4::jsonb, $5, $6, $7)`,
      [
        entry.actor_user_id,
        entry.action,
        entry.source_ip,
        JSON.stringify(entry.meta),
        severity,
        'admin',
        null,
      ],
    );
  } catch (err) {
    console.error('[admin-auth] audit log failed:', (err as Error).message);
  }
}