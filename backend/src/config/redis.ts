import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Redis কানেকশন
export const redis = new Redis({
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
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
