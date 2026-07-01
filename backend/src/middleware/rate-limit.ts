/**
 * ═══════════════════════════════════════════════════════════════
 *  RATE LIMIT MIDDLEWARE — Per-route IP throttling
 * ═══════════════════════════════════════════════════════════════
 *
 *  Phase 2.5 upgrade:
 *    - Per-route limiters (auth stricter than API)
 *    - Hooks into Phase 2.2 `audit_log` and `fraud_signals` tables
 *    - Standardized 429 response shape
 *
 *  Limits (per IP):
 *    - /api/auth/login:     5 requests / 15 min   (brute-force protection)
 *    - /api/auth/register:  3 requests / hour    (anti-spam account creation)
 *    - /api/* (general):   200 requests / 15 min   (abuse protection)
 *
 *  Storage:
 *    Uses in-memory store (default for express-rate-limit). For multi-pod
 *    deployments, switch to a Redis store via `rate-limit-redis`.
 *    Single-pod: in-memory is fine.
 *
 *  Side effects on rate-limit trigger:
 *    - Writes `audit_log` row (category=security, action=rate_limit.exceeded)
 *    - Writes `fraud_signals` row (signal_type=velocity, severity=medium)
 *    - Returns 429 with Retry-After header
 * ═══════════════════════════════════════════════════════════════
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import { query } from '../config/database';

// ── Helpers for side-effect logging ─────────────────────────────

/** Best-effort audit_log write; never throws */
async function logRateLimitEvent(req: Request, route: string, limit: number) {
  try {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const userId = (req as Request & { user?: { userId: string } }).user?.userId ?? null;
    await query(
      `INSERT INTO audit_log
        (user_id, category, action, severity, ip_address, user_agent, details)
       VALUES ($1, 'security', 'rate_limit.exceeded', 'warn', $2, $3, $4)`,
      [
        userId,
        ip,
        (req.headers['user-agent'] || '').toString().slice(0, 500),
        JSON.stringify({ route, limit, path: req.path, method: req.method }),
      ]
    );
    // Also flag as a velocity fraud signal (medium severity)
    await query(
      `INSERT INTO fraud_signals
        (user_id, signal_type, severity, ip_address, status, metadata)
       VALUES ($1, 'velocity', 'medium', $2, 'open', $3)`,
      [
        userId,
        ip,
        JSON.stringify({ trigger: 'rate_limit.exceeded', route, limit }),
      ]
    );
  } catch {
    // swallow — don't let logging break the rate-limit response
  }
}

// ── Standardized handler (shared across all limiters) ───────────

function buildHandler(routeName: string, limitValue: number): Options['handler'] {
  return async (req: Request, res: Response, _next: NextFunction, options) => {
    // Log to DB (fire-and-forget — don't block the response)
    void logRateLimitEvent(req, routeName, limitValue);
    res.status(options.statusCode).json({
      success: false,
      error: 'অনেক রিকোয়েস্ট। কিছুক্ষণ পরে চেষ্টা করুন।',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  };
}

// ── Auth-specific limiters (much stricter) ──────────────────────

export const loginLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 5,                      // 5 attempts per IP per 15min
  standardHeaders: true,       // RateLimit-* headers in response
  legacyHeaders: false,
  handler: buildHandler('/api/auth/login', 5),
  keyGenerator: (req) => `login:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
});

export const registerLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,                     // 10 registrations per IP per hour
  // Was 3; bumped 2026-06-29 because 3/hour was too tight — a single
  // user who mistypes their password twice gets locked out for 1 hour.
  // Bots are a separate problem; mitigate with CAPTCHA on the frontend
  // when signup volume warrants it.
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildHandler('/api/auth/register', 10),
  keyGenerator: (req) => `register:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
});

export const passwordResetLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildHandler('/api/auth/password-reset', 3),
  keyGenerator: (req) => `pwreset:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
});

// ── General API limiter (replaces the v1 global 200/15min) ────────
export const apiLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildHandler('/api', 200),
  keyGenerator: (req) => `api:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
});

// ── Admin seed-rotation limiter (H4 companion) ──────────────────
//
// 3 attempts per admin per 5 min. Generous for normal use (admins
// rotate manually a few times per day), but tight enough to slow
// brute force against the bcrypt step-up auth above. Keyed by
// `req.user.userId` (set by the router-level authMiddleware), NOT
// IP — a stolen admin token coming from many IPs would still hit
// the same per-admin bucket.
export const seedRotateLimiter: RequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildHandler('/api/admin/seed/rotate', 3),
  keyGenerator: (req) => {
    const u = (req as Request & { user?: { userId?: string } }).user;
    if (u?.userId) return `seedrotate:${u.userId}`;
    return `seedrotateip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  },
});

// ── Per-USER bet limiter (H3 FIX) ────────────────────────────────
//
// The IP-based betLimiter above has two weaknesses:
//   1. A logged-in attacker rotating IPs (mobile network, VPN) bypasses it
//      because the bucket is keyed by source address, not identity.
//   2. Legitimate users behind a shared NAT (office, dorm, mobile carrier)
//      punish each other for hitting the same 30/min bucket.
//
// betLimiterPerUser is applied AFTER `authMiddleware` on /api/game/bet,
// so `req.user.userId` is populated and used as the bucket key. The IP
// limiter above remains in place as a coarse abuse gate (mostly to slow
// down unauthenticated bursts against the route). Together: ~30 bets/min
// per legitimate user, no cross-user interference.
//
// Configurable window/budget for tuning. The slot time is ~1.6s on the
// backend (coin spin animation), so 30/min ≈ 2s per bet — comfortable
// for a real human, impossible for a script spamming the socket.
export const betLimiterPerUser: RequestHandler = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 30,                     // 30 bets/min per authenticated user
  standardHeaders: true,
  legacyHeaders: false,
  handler: buildHandler('/api/game/bet (per-user)', 30),
  // Run AFTER authMiddleware so req.user is populated. If somehow a
  // request slips through without a user (impossible given the route
  // ordering), fall back to IP so we don't share buckets across users.
  keyGenerator: (req) => {
    const u = (req as Request & { user?: { userId?: string } }).user;
    if (u?.userId) return `betuser:${u.userId}`;
    return `betip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  },
});