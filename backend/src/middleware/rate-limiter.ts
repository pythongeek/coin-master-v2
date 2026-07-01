import { Request, Response } from 'express';
import rateLimit, { Store, Options, IncrementResponse } from 'express-rate-limit';
import { redis } from '../config/redis';

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
