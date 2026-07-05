import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

export const redisConfig = {
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

// Redis কানেকশন
export const redis = new Redis({
  ...redisConfig,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => {
  console.log('✅ Redis কানেক্টেড!');
});

redis.on('error', (err) => {
  console.error('❌ Redis Error:', err);
});

// Helper: লাইভ বেট লক করা (Race Condition প্রতিরোধ)
export async function lockBet(userId: string, amount: number): Promise<boolean> {
  const key = `bet_lock:${userId}`;
  const result = await redis.set(key, amount.toString(), 'EX', 30, 'NX');
  return result === 'OK';
}

export async function unlockBet(userId: string): Promise<void> {
  await redis.del(`bet_lock:${userId}`);
}

// Helper: Win Streak ট্র্যাক করা
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
