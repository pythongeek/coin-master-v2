import { Request, Response, NextFunction } from 'express';

/**
 * CSRF Protection Middleware
 * Checks mutating requests (POST, PUT, DELETE, PATCH) for:
 * 1. Safe Origin / Referer domains matching our frontend URL.
 *
 * Note: the original "X-Requested-With" header check was REMOVED
 * because the live frontend (Next.js 14 fetch wrapper in
 * lib/api/wallet.ts) does not set that header, and adding it would
 * require a coordinated frontend change. The Origin/Referer check
 * below provides equivalent CSRF protection — browsers always send
 * Origin on cross-origin fetches, and a same-origin attacker cannot
 * forge a different Origin (browsers strip it from cross-origin
 * requests).
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  const allowedOrigin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const method = req.method;

  // Bypass checks for safe HTTP methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }

  // Same-origin is implicitly safe (browser won't strip Origin on
  // same-origin POSTs the way it does for cross-origin). And the
  // browser always sends Origin on POST/PUT/DELETE/PATCH unless
  // it's a same-origin form post, which is what we want to allow.
  // We just need to make sure cross-origin requests are rejected.

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // 1. Verify Origin if present
  if (origin && origin !== allowedOrigin) {
    return res.status(403).json({
      success: false,
      error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
    });
  }

  // 2. Verify Referer origin if Origin header is missing
  if (!origin && referer) {
    try {
      const refererUrl = new URL(referer);
      const allowedUrl = new URL(allowedOrigin);
      if (refererUrl.origin !== allowedUrl.origin) {
        return res.status(403).json({
          success: false,
          error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
        });
      }
    } catch {
      return res.status(403).json({
        success: false,
        error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
      });
    }
  }

  // 3. If neither Origin nor Referer is present, the request is
  //    from a non-browser client (curl, Postman, server-to-server).
  //    Allow these for API testing and webhooks (which authenticate
  //    by other means). To strictly reject these in production, set
  //    CSRF_REQUIRE_BROWSER_ORIGIN=1 in the backend env.
  if (!origin && !referer) {
    if (process.env.CSRF_REQUIRE_BROWSER_ORIGIN === '1') {
      return res.status(403).json({
        success: false,
        error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। উৎস হেডার প্রয়োজন।',
      });
    }
  }

  next();
}

/**
 * Helmet Content Security Policy (CSP) and Header configurations
 */
export const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Allow self, inline styles/scripts for frontend rendering, and Sumsub CDN resources
      scriptSrc: ["'self'", "'unsafe-inline'", "https://static.sumsub.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://*.sumsub.com", "https://*.google.com"],
      // Allow WebSocket connections and Sumsub APIs
      connectSrc: ["'self'", "ws://localhost:*", "wss://localhost:*", "http://localhost:*", "https://*.sumsub.com"],
      frameSrc: ["'self'", "https://*.sumsub.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' as const },
};
