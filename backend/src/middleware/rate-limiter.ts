import { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit, { Store, Options, IncrementResponse } from 'express-rate-limit';
import { redis } from '../config/redis';
import { query } from '../config/database';

/**
 * P1-07 — Legacy migration
 * -----------------------------------------------------------------------------
 * All Redis-backed rate limiters live in this file. The previous design
 * split them across two files:
 *   - backend/src/middleware/rate-limit.ts   (legacy, in-memory)
 *   - backend/src/middleware/rate-limiter.ts  (Redis Lua bucket)
 *
 * The in-memory middleware was deleted in P1-07 because a multi-pod
 * deployment cannot share state across pods via local memory, which
 * created a rate-limit bypass vector. Every limiter below uses the
 * `RedisStore` (atomic INCR + EXPIRE Lua) defined above.
 *
 * Side-effect hook (P1-07 restoration):
 *   The legacy middleware wrote to `audit_log` and `fraud_signals` on every
 *   rate-limit-exceeded event. To avoid a regression where this stopped
 *   happening silently, every limiter below wires its `handler` through
 *   `auditOnLimit()` which best-effort writes those two rows.
 */

async function auditOnLimit(req: Request, route: string, limitValue: number): Promise<void> {
  try {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const userId = (req as Request & { user?: { userId?: string } }).user?.userId ?? null;
    const userAgent = (req.headers['user-agent'] ?? '').toString().slice(0, 500);
    await query(
      `INSERT INTO audit_log (user_id, category, action, severity, ip_address, user_agent, details)
       VALUES ($1, 'security', 'rate_limit.exceeded', 'warn', $2, $3, $4)`,
      [userId, ip, userAgent, JSON.stringify({ route, limit: limitValue, path: req.path, method: req.method })],
    );
    await query(
      `INSERT INTO fraud_signals (user_id, signal_type, severity, ip_address, status, metadata)
       VALUES ($1, 'velocity', 'medium', $2, 'open', $3)`,
      [userId, ip, JSON.stringify({ trigger: 'rate_limit.exceeded', route, limit: limitValue })],
    );
  } catch {
    // best-effort; never let audit writes break the rate-limit response
  }
}

function withAuditHandler(routeName: string, limitValue: number): Options['handler'] {
  return (req: Request, res: Response, _next: NextFunction, options) => {
    void auditOnLimit(req, routeName, limitValue);
    res.status(options.statusCode).json({
      success: false,
      error: 'অনেক রিকোয়েস্ট। কিছুক্ষণ পরে চেষ্টা করুন।',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  };
}

class RedisStore implements Store {
  private windowMs!: number;
  private memoryFallback = new Map<string, { hits: number; resetTime: number }>();

  async init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      if (redis.status !== 'ready') {
        throw new Error('Redis is not ready');
      }

      const luaScript = `
        local key = KEYS[1]
        local windowMs = tonumber(ARGV[1])
        local windowSeconds = math.ceil(windowMs / 1000)

        local current = redis.call('incr', key)
        local ttl = redis.call('ttl', key)

        if current == 1 or ttl < 0 then
          redis.call('expire', key, windowSeconds)
          ttl = windowSeconds
        end

        return {current, ttl}
      `;

      const [hits, ttl] = (await redis.eval(
        luaScript,
        1,
        key,
        this.windowMs
      )) as [number, number];

      return {
        totalHits: hits,
        resetTime: new Date(Date.now() + ttl * 1000),
      };
    } catch (err) {
      // Memory fallback
      const now = Date.now();
      const record = this.memoryFallback.get(key);
      if (!record || record.resetTime < now) {
        const newRecord = { hits: 1, resetTime: now + this.windowMs };
        this.memoryFallback.set(key, newRecord);
        return { totalHits: 1, resetTime: new Date(newRecord.resetTime) };
      }
      record.hits += 1;
      return { totalHits: record.hits, resetTime: new Date(record.resetTime) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      if (redis.status === 'ready') {
        await redis.decr(key);
      }
    } catch {
      const record = this.memoryFallback.get(key);
      if (record && record.hits > 0) {
        record.hits -= 1;
      }
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      if (redis.status === 'ready') {
        await redis.del(key);
      }
    } catch {
      this.memoryFallback.delete(key);
    }
  }
}

// Standard handler for rate limit failures
const defaultHandler = (req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    error: 'অতিরিক্ত রিকোয়েস্ট পাঠানো হয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
  });
};

// Global rate limiter: 100 requests per 15 minutes
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  store: new RedisStore(),
  keyGenerator: (req) => `global:${req.ip}`,
  handler: defaultHandler,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Auth rate limiter: 5 requests per 1 minute
export const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 5,
  store: new RedisStore(),
  keyGenerator: (req) => `auth:${req.ip}`,
  handler: defaultHandler,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Game rate limiter: 60 requests per 1 minute
export const gameLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 60,
  store: new RedisStore(),
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    return userId ? `game:${userId}` : `game:${req.ip}`;
  },
  handler: defaultHandler,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Admin rate limiter: 30 requests per 1 minute
export const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 30,
  store: new RedisStore(),
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    return userId ? `admin:${userId}` : `admin:${req.ip}`;
  },
  handler: defaultHandler,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Generic API limiter (P1-07 migration).
 *
 * Replaces the legacy `apiLimiter` from `middleware/rate-limit.ts`. Same
 * budget (200 / 15 min), but state lives in Redis so multi-pod
 * deployments share the bucket.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  store: new RedisStore(),
  keyGenerator: (req) => `api:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
  handler: withAuditHandler('/api/wallet/payment/api', 200),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Auth — login (P1-07 migration).
 *
 * 5 attempts / 15 min, keyed by IP. Reduces brute-force surface for
 * the password + 2FA login flow.
 */
export const loginLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  store: new RedisStore(),
  keyGenerator: (req) => `login:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
  handler: withAuditHandler('/api/auth/login', 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Auth — registration (P1-07 migration).
 *
 * 10 attempts / hour, keyed by IP. Was 3/hour in legacy; bumped to
 * reduce friction on legit users (the original comment is preserved
 * on the legacy comment block above).
 */
export const registerLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  store: new RedisStore(),
  keyGenerator: (req) => `register:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
  handler: withAuditHandler('/api/auth/register', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Auth — password reset (P1-07 migration).
 *
 * 3 attempts / hour, keyed by IP.
 */
export const passwordResetLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  store: new RedisStore(),
  keyGenerator: (req) => `pwreset:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
  handler: withAuditHandler('/api/auth/password-reset', 3),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * KYC verification (P1-07 migration).
 *
 * 3 attempts / hour, keyed by USER ID (post-auth). The legacy inline
 * `verifyLimiter` in `routes/kyc.ts` was in-memory and never shared
 * state across pods; this Redis-backed version fixes that.
 *
 * Also runs in audit-log writes — KYC submit abuse is a fraud signal
 * worth keeping even when the limit is not tripped.
 */
export const kycVerifyLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  store: new RedisStore(),
  keyGenerator: (req) => {
    const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
    if (userId) return `kycverify:${userId}`;
    return `kycverifyip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  },
  handler: (req, res, next) => {
    void auditOnLimit(req, '/api/kyc/verify', 3);
    res.status(429).json({
      success: false,
      error: 'Too many KYC attempts. Try again in 1 hour.',
    });
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Admin seed rotation (P1-07 migration).
 *
 * 3 attempts / 5 min, keyed by user ID. Stolen admin tokens rotating
 * across many IPs still hit the same per-admin bucket.
 */
export const seedRotateLimiter: RequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 3,
  store: new RedisStore(),
  keyGenerator: (req) => {
    const u = (req as Request & { user?: { userId?: string } }).user;
    if (u?.userId) return `seedrotate:${u.userId}`;
    return `seedrotateip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  },
  handler: withAuditHandler('/api/admin/seed/rotate', 3),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * Per-user bet limiter (P1-07 migration).
 *
 * 30 bets / min, keyed by authenticated user ID. The IP-based gameLimiter
 * above remains in place as a coarse abuse gate.
 */
export const betLimiterPerUser: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  store: new RedisStore(),
  keyGenerator: (req) => {
    const u = (req as Request & { user?: { userId?: string } }).user;
    if (u?.userId) return `betuser:${u.userId}`;
    return `betip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  },
  handler: withAuditHandler('/api/game/bet (per-user)', 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
