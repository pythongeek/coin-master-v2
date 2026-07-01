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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow /admin ONLY if the gateway header carries the correct token.
  // Without the header → rewrite to /404. With the wrong token → also 404.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const provided = req.headers.get(GATEWAY_HEADER) || '';
    if (!GATEWAY_TOKEN || provided !== GATEWAY_TOKEN) {
      return NextResponse.rewrite(new URL('/404', req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Match everything except Next.js internals and static files
  matcher: ['/((?!_next|static|favicon.ico|.*\\..*).*)'],
};