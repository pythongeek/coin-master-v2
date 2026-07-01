// ═══════════════════════════════════════════════════════════════
//  CATCH-ALL API PROXY — /api/[...path]/route.ts
// ═══════════════════════════════════════════════════════════════
//
//  This is the catch-all Next.js API route that proxies ALL
//  /api/* requests to the backend at NEXT_PUBLIC_API_URL. It's
//  needed because the cloudflared quick-tunnel exposes the
//  frontend on a public URL, but the backend on :4000 is NOT
//  tunneled. Without this proxy:
//    - Tunnel user's browser tries to call
//      http://localhost:4000/api/... (the bundle's hardcoded
//      API base URL)
//    - That fails because the public can't reach port 4000
//    - Result: login/bet/admin all break
//
//  With this proxy:
//    - Tunnel user hits https://<tunnel>/api/auth/login
//    - Frontend (on the same host as the backend) proxies
//      the request to http://localhost:4000/api/auth/login
//    - Response flows back through the tunnel
//
//  This is a server-side proxy (runs in the Next.js Node
//  process), so the response includes the backend's headers
//  (including CSRF cookie if needed).
//
//  Why not use Next.js rewrites? The rewrites() function in
//  next.config.js with an external destination doesn't work
//  reliably in dev mode (returns the React app HTML instead
//  of proxying). This catch-all route is the proven pattern.
// ═══════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';

// BACKEND precedence:
//   1. INTERNAL_API_URL — set in docker-compose.yml to the docker
//      network hostname (e.g. http://backend:4000). Used by the
//      server-side proxy running inside the frontend container.
//   2. NEXT_PUBLIC_API_URL — what's in the bundle, used by the
//      browser (http://localhost:4000 for the dev working off
//      cx23, http://<tunnel>/api/* for tunnel users via the
//      catch-all proxy in this file).
//   3. Fallback to http://localhost:4000 (works for Next.js
//      running directly on the host).
const BACKEND = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Don't proxy /api/health — that's the frontend's own health check.
// Don't proxy /api/admin-secret — that's the frontend's own build
// artifact. (Neither is currently used, but defensive.)
function isLocalPath(path: string): boolean {
  return path === 'health' || path === 'admin-secret';
}

async function proxy(req: NextRequest, params: { path?: string[] }): Promise<NextResponse> {
  // The App Router passes the path components as `params.path` for a
  // [...path] catch-all. In some Next.js 14 dev-mode builds the
  // params come through empty (the dev server's on-demand
  // compilation races with the request). Falling back to parsing
  // `req.nextUrl.pathname` directly is reliable in both dev and
  // production.
  let path = params.path?.join('/') ?? '';
  if (!path) {
    const raw = req.nextUrl.pathname.replace(/^\/api\/?/, '');
    path = raw;
  }
  if (isLocalPath(path)) {
    return NextResponse.json(
      { error: `Not proxied: /api/${path} is a frontend-only route` },
      { status: 404 }
    );
  }

  const url = `${BACKEND}/api/${path}${req.nextUrl.search}`;

  // Forward the request body for non-GET/HEAD
  let body: BodyInit | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await req.text();
    } catch {
      body = undefined;
    }
  }

  // Build upstream headers — forward everything client sent
  // except the host header (which would be the frontend, not
  // the backend) and the content-length (which Node sets
  // automatically when the body is a string).
  const upstreamHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') return;
    upstreamHeaders[key] = value;
  });

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: upstreamHeaders,
      body,
      // Don't follow redirects — pass them through
      redirect: 'manual',
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Upstream fetch failed: ${(err as Error).message}` },
      { status: 502 }
    );
  }

  // Build response headers from upstream
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Skip hop-by-hop / encoding headers that Next.js will set itself
    if (lower === 'transfer-encoding' || lower === 'connection') return;
    responseHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// Match all HTTP methods
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;

// Next.js config: the [...path] catch-all must NOT match /api/health
// (handled by isLocalPath above) or /api/admin-secret.
export const dynamic = 'force-dynamic';
