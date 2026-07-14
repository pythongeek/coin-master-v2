/**
 * =============================================================
 *  IDEMPOTENCY CACHE - Redis-backed request deduplication
 * =============================================================
 *  Standard pattern used by Stripe, GitHub, AWS, etc.:
 *
 *    Client sends 'Idempotency-Key: <unique-string>' header on a
 *    POST/PATCH/DELETE. On first call, the response body is cached
 *    in Redis under 'idem:<route>:<userId>:<key>'. Subsequent calls
 *    within the TTL window with the same key return the cached
 *    response WITHOUT re-running the handler (prevents duplicates
 *    from double-clicks, retries, race conditions, network blips).
 *
 *  TTL: 24h (industry default).
 *
 *  Returns null if the key hasn't been seen before (proceed normally),
 *  or the cached response body if it has (return it as-is).
 */
import { redisConfig } from '../config/redis';

const TTL_SECONDS = 24 * 60 * 60;

function key(route: string, userId: string, idempotencyKey: string): string {
  return `idem:${route}:${userId}:${idempotencyKey}`;
}

/**
 * Look up a cached response. Returns null if no cache hit.
 * The cached value is { status: number, body: object }.
 */
export async function getIdempotentResponse<T>(
  route: string,
  userId: string,
  idempotencyKey: string,
): Promise<{ status: number; body: T } | null> {
  try {
    // Lazy-load ioredis to keep this util dependency-free if unused
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisConfig);
    const raw = await client.get(key(route, userId, idempotencyKey));
    await client.quit();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;  // Cache miss / Redis down -> proceed normally
  }
}

/**
 * Store a response so future calls with the same key return it.
 */
export async function setIdempotentResponse<T>(
  route: string,
  userId: string,
  idempotencyKey: string,
  status: number,
  body: T,
): Promise<void> {
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisConfig);
    await client.set(
      key(route, userId, idempotencyKey),
      JSON.stringify({ status, body }),
      'EX',
      TTL_SECONDS,
    );
    await client.quit();
  } catch {
    // best-effort: cache write failure shouldn't fail the request
  }
}
