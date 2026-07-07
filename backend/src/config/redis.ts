import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// ── Redis connection configuration ───────────────────────────────
// SECURITY: Redis is internal-only (no host port mapping in Docker).
// Access is restricted to the backend container via the Docker bridge
// network. Password auth is required. TLS is supported for external
// Redis connections (e.g. AWS ElastiCache, Redis Cloud) via env flag.
// ─────────────────────────────────────────────────────────────────

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS_ENABLED = process.env.REDIS_TLS_ENABLED === 'true';
const REDIS_DB = parseInt(process.env.REDIS_DB || '0');

export const redisConfig = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  db: REDIS_DB,
  // Only enable TLS when explicitly requested (external managed Redis)
  tls: REDIS_TLS_ENABLED ? {} : undefined,
};

// Production-hardened Redis client
export const redis = new Redis({
  ...redisConfig,
  // Lazy connect: don't block server startup if Redis is briefly unavailable
  lazyConnect: true,
  // Connection timeout: fail fast if Redis is unreachable
  connectTimeout: 10000,
  // Command timeout: don't hang forever on a slow Redis command
  commandTimeout: 5000,
  // Keepalive to detect dead connections
  keepAlive: 30000,
  // Retry strategy with cap
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000);
    // Stop retrying after ~30 seconds of continuous failure
    if (times > 30) {
      console.error('❌ Redis: Max retries exceeded. Giving up.');
      return null; // stop retrying
    }
    return delay;
  },
  // Max retries per command before error
  maxRetriesPerRequest: 3,
  // Enable offline queue so commands buffer during brief disconnects
  enableOfflineQueue: true,
  // Show friendly error stack traces in development
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
});

// Explicit connect with error handling
redis.connect().catch((err) => {
  console.error('❌ Redis initial connection failed:', err.message);
  // Don't exit — the retryStrategy will keep trying.
  // In production, the health check endpoint will report Redis status.
});

redis.on('connect', () => {
  console.log('✅ Redis connected!');
});

redis.on('ready', () => {
  console.log('✅ Redis ready!');
});

redis.on('error', (err) => {
  console.error('❌ Redis Error:', err.message);
});

redis.on('reconnecting', () => {
  console.warn('⚠️ Redis reconnecting...');
});

// ── Health check helper ──────────────────────────────────────────
export async function redisHealthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

// ── Helper: লাইভ বেট লক করা (Race Condition প্রতিরোধ)
export async function lockBet(userId: string, amount: number): Promise<boolean> {
  const key = `bet_lock:${userId}`;
  const result = await redis.set(key, amount.toString(), 'EX', 30, 'NX');
  return result === 'OK';
}

export async function unlockBet(userId: string): Promise<void> {
  await redis.del(`bet_lock:${userId}`);
}

// ── Helper: Win Streak ট্র্যাক করা
export async function incrementWinStreak(userId: string): Promise<number> {
  const key = `win_streak:${userId}`;
  const count = await redis.incr(key);
  await redis.expire(key, 3600); // 1 ঘণ্টা পর রিসেট
  return count;
}

export async function resetWinStreak(userId: string): Promise<void> {
  await redis.del(`win_streak:${userId}`);
}

export async function getWinStreak(userId: string): Promise<number> {
  const count = await redis.get(`win_streak:${userId}`);
  return parseInt(count || '0');
}

// ── Streak Ladder Bonus Helpers ───────────────────────────────────
const STREAK_BONUS_AT_RISK_KEY = (userId: string) => `streak_at_risk:${userId}`;
const STREAK_BUDGET_SPENT_KEY = (date: string) => `streak_budget_spent:${date}`;

export async function getStreakBonusAtRisk(userId: string): Promise<number> {
  const value = await redis.get(STREAK_BONUS_AT_RISK_KEY(userId));
  return parseFloat(value || '0');
}

export async function addStreakBonusAtRisk(userId: string, amount: number): Promise<number> {
  const key = STREAK_BONUS_AT_RISK_KEY(userId);
  const newValue = await redis.incrbyfloat(key, amount);
  await redis.expire(key, 86400); // 24 hours TTL
  return parseFloat(newValue);
}

export async function resetStreakBonusAtRisk(userId: string): Promise<void> {
  await redis.del(STREAK_BONUS_AT_RISK_KEY(userId));
}

export async function getStreakBudgetSpent(date: string): Promise<number> {
  const spent = await redis.get(`streak_budget:${date}`);
  return parseFloat(spent || '0');
}

export async function incrementStreakBudgetSpent(date: string, amount: number): Promise<void> {
  await redis.incrbyfloat(`streak_budget:${date}`, amount);
  // Expire at end of next day
  const ttl = Math.ceil((new Date(`${date}T23:59:59.999Z`).getTime() + 86400000 - Date.now()) / 1000);
  if (ttl > 0) await redis.expire(`streak_budget:${date}`, ttl);
}

// ── Lightning Budget Helpers ──────────────────────────────────
export async function getLightningBudgetSpent(date: string): Promise<number> {
  const spent = await redis.get(`lightning_budget:${date}`);
  return parseFloat(spent || '0');
}

export async function incrementLightningBudgetSpent(date: string, amount: number): Promise<void> {
  await redis.incrbyfloat(`lightning_budget:${date}`, amount);
  const ttl = Math.ceil((new Date(`${date}T23:59:59.999Z`).getTime() + 86400000 - Date.now()) / 1000);
  if (ttl > 0) await redis.expire(`lightning_budget:${date}`, ttl);
}
