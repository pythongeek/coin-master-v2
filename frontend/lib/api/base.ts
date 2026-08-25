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
 *       somewhere explicit) honour NEXT_PUBLIC_API_URL or
 *       INTERNAL_API_URL, in that order.
 *    3. As a last resort fall back to http://localhost:4000. Production
 *       builds must set at least one of those env vars (so the
 *       fallback is unreachable), but the fallback ensures callers
 *       always get a usable URL instead of an empty string.
 *
 *  The same-origin /api path means we never embed http://localhost:4000
 *  in client bundle calls when the app is served from a public origin.
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
  // network via INTERNAL_API_URL. Final fallback is localhost:4000 so
  // callers always get a usable URL (matching the fallback chain in
  // app/api/[...path]/route.ts and lib/admin-server.ts — getApiBase()
  // is the canonical resolver per the file header, so all three must
  // agree on what "no env set" means).
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}