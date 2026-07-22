/**
 * ═══════════════════════════════════════════════════════════════
 *  CANONICAL API BASE RESOLVER — single source of truth
 * ═══════════════════════════════════════════════════════════════
 *
 *  Use getApiBase() everywhere instead of inlining the
 *  "if (browser && !NEXT_PUBLIC_API_URL) /api else NEXT_PUBLIC_API_URL || localhost:4000"
 *  pattern. Bump this file if the routing strategy changes.
 *
 *  Resolution order:
 *    1. In the browser, prefer the same-origin proxy (/api) so the
 *       nginx → frontend → backend chain works without exposing :4000.
 *    2. Otherwise (server-side / SSR / build-time, or when env points
 *       somewhere explicit) honour NEXT_PUBLIC_API_URL.
 *    3. As a last resort fall back to the local-backend default.
 *
 *  No localhost fallback ever appears in client bundle calls when the
 *  app is served from a public origin — every path resolves to a
 *  relative /api route so we never embed http://localhost:4000 in
 *  shipping code.
 */
export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    // Browser — always go through the Next.js catch-all proxy unless an
    // explicit env override is present at runtime (rare; usually only
    // true during dev when the user runs `npm run dev` against a host
    // backend). If you actually want to call the backend directly from
    // the browser, set NEXT_PUBLIC_API_URL at build time.
    if (!process.env.NEXT_PUBLIC_API_URL) return '/api';
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // Server-side / SSR: reach the backend directly inside the container
  // network via INTERNAL_API_URL. No localhost fallback is ever baked
  // in, so production SSR cannot accidentally call http://localhost:4000.
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || '';
}