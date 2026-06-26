import { redis } from '../config/redis';

/**
 * Get value from cache, or fetch it and store it in cache if it doesn't exist.
 * 
 * @param key Cache key
 * @param ttl Time to live in seconds
 * @param fetchFunction Async function to fetch data if cache miss
 */
export async function getOrSet<T>(
  key: string,
  ttl: number,
  fetchFunction: () => Promise<T>
): Promise<T> {
  const cachedValue = await redis.get(key);
  if (cachedValue !== null) {
    try {
      return JSON.parse(cachedValue) as T;
    } catch (e) {
      console.warn(`Failed to parse cache key ${key}:`, e);
    }
  }

  const freshData = await fetchFunction();
  await redis.set(key, JSON.stringify(freshData), 'EX', ttl);
  return freshData;
}

/**
 * Set a key directly in cache.
 */
export async function setCache(key: string, value: any, ttl: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttl);
}

/**
 * Get value from cache directly.
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch (e) {
    return null;
  }
}

/**
 * Invalidate/delete cache keys.
 */
export async function invalidateCache(keyOrKeys: string | string[]): Promise<void> {
  if (Array.isArray(keyOrKeys)) {
    if (keyOrKeys.length > 0) {
      await redis.del(...keyOrKeys);
    }
  } else {
    await redis.del(keyOrKeys);
  }
}
