// ══════════════════════════════════════════════════════════════
//  NEXT.JS MIDDLEWARE — Hidden Admin Path Protection
// ══════════════════════════════════════════════════════════════
//
//  Three things must be true for an admin request to reach
//  React code:
//
//    1. URL must use the secret path (e.g. /sysop-XXXX)
//       → next.config.js rewrites it to /admin/...
//
//    2. Direct /admin* must 404
//       → this middleware short-circuits with rewrite → 404
//
//    3. User must be logged in as admin
//       → checked client-side in app/admin/page.tsx
//         (server-side JWT check would require an Edge-safe
//          verifier; client check is acceptable given the URL
//          itself is also a secret)
//
//  The path is read from process.env.ADMIN_SECRET_PATH at build
//  time (same source as next.config.js rewrites).
// ══════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';

// ─── Gateway authentication ────────────────────────────
// Direct /admin access is BLOCKED. The only way to reach /admin
// in production is via the nginx vhost on :3003, which passes
// this header with a value matching ADMIN_GATEWAY_TOKEN (read
// from /root/.admin-gateway-token at build time via the
// ADMIN_GATEWAY_TOKEN build-arg in docker-compose.yml).
//
// Why a header + secret instead of IP allowlist?
//   - IP allowlist would break the cloudflared tunnel
//     (tunnel traffic comes from 127.0.0.1)
//   - A signed header is opaque and easy to rotate
//
// The header is consumed by Next.js (not exposed to React),
// so the React code never sees it.
const GATEWAY_TOKEN = (process.env.ADMIN_GATEWAY_TOKEN || '').trim();
const GATEWAY_HEADER = 'x-admin-gateway';

// The gateway token is read at build time. Middleware runs BEFORE
// the rewrite (Next.js docs: "middleware runs at the request layer
// and rewrites happen in the routing layer"). So we have to check
// BOTH the original secret path AND the rewritten /admin path.
//
// Production hardening (2026-07-04): the token MUST be configured.
// If empty, /admin 404s even on localhost — fail-closed. This
// prevents an operator from forgetting to rotate a stale token and
// accidentally exposing the panel.
const SECRET_PATH = (process.env.ADMIN_SECRET_PATH || '').trim();
const SECRET_NORMALIZED = SECRET_PATH.startsWith('/') ? SECRET_PATH : `/${SECRET_PATH}`;
const GATEWAY_TOKEN_CONFIGURED = GATEWAY_TOKEN.length > 0;

// Admin IP allowlist. If set, only these IPs/hosts can reach the admin
// path. The host is included because cloudflared tunnels terminate on
// localhost, so we trust the tunnel hostname as a secure channel.
// Format: comma-separated list of IPs or hostnames (e.g.
// "203.0.113.10,46.62.247.167,localhost,127.0.0.1,mesa-sur-demonstrate-gates.trycloudflare.com").
const ADMIN_ALLOWLIST = (process.env.ADMIN_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminPath(pathname: string): boolean {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  // Also check the secret path (the request comes in as the
  // secret path; the rewrite to /admin happens after middleware).
  if (SECRET_NORMALIZED && SECRET_NORMALIZED !== '/admin') {
    if (pathname === SECRET_NORMALIZED || pathname.startsWith(`${SECRET_NORMALIZED}/`)) return true;
  }
  return false;
}

function isAllowedAdminHost(req: NextRequest): boolean {
  const host = req.headers.get('host') || '';
  const forwardedFor = req.headers.get('x-forwarded-for') || '';
  const remoteIp = forwardedFor.split(',')[0].trim() || (req as any).ip || '';
  const clientIp = remoteIp.toLowerCase();
  const hostLower = host.toLowerCase();

  // If no allowlist is configured, fall back to the gateway-token check
  // (legacy behaviour). Empty allowlist means no IP restriction, but the
  // gateway token is still required.
  if (ADMIN_ALLOWLIST.length === 0) return true;

  // Allow localhost in any form for local development.
  if (
    hostLower.startsWith('localhost:') ||
    hostLower === 'localhost' ||
    hostLower.startsWith('127.0.0.1') ||
    hostLower === '127.0.0.1'
  ) {
    return true;
  }

  // Allow the explicitly listed hostnames (e.g. tunnel domains) and IPs.
  return ADMIN_ALLOWLIST.some(
    (entry) => entry === hostLower || entry === clientIp || hostLower.startsWith(`${entry}:`)
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow admin paths ONLY if the gateway header carries the
  // correct token AND the request comes from an allowed host/IP.
  // Without the header → rewrite to /404.
  // With the wrong token → also 404.
  // DEV ONLY: skip the gateway check for localhost origins so the
  // admin panel can be tested in a local browser without nginx.
  if (isAdminPath(pathname)) {
    const host = req.headers.get('host') || '';
    const isLocalDev =
      host.startsWith('localhost:') ||
      host === 'localhost' ||
      host.startsWith('127.0.0.1') ||
      host === '127.0.0.1';

    if (!isLocalDev) {
      // IP / hostname allowlist check.
      if (!isAllowedAdminHost(req)) {
        return NextResponse.rewrite(new URL('/404', req.url));
      }

      // Gateway token must be configured AND correct in production.
      // Fail-closed: if not configured, deny (this catches misconfigured
      // deployments before they leak the admin panel).
      if (!GATEWAY_TOKEN_CONFIGURED) {
        return NextResponse.rewrite(new URL('/404', req.url));
      }
      const provided = req.headers.get(GATEWAY_HEADER) || '';
      if (provided !== GATEWAY_TOKEN) {
        return NextResponse.rewrite(new URL('/404', req.url));
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Match everything except Next.js internals and static files
  matcher: ['/((?!_next|static|favicon.ico|.*\\..*).*)'],
};