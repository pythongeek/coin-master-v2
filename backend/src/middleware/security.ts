import { Request, Response, NextFunction } from 'express';

/**
 * CSRF Protection Middleware
 * Checks mutating requests (POST, PUT, DELETE, PATCH) for:
 * 1. Safe Origin / Referer domains matching our frontend URL.
 * 2. Presence of custom browser-enforced security headers (e.g., X-Requested-With or X-CSRF-Token).
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  const allowedOrigin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const method = req.method;

  // Bypass checks for safe HTTP methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const requestedWith = req.headers['x-requested-with'];
  const csrfHeader = req.headers['x-csrf-token'];

  // 1. Verify custom browser-enforced header is present (protects against simple form/iframe posts)
  if (!requestedWith && !csrfHeader) {
    return res.status(403).json({
      success: false,
      error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
    });
  }

  // 2. Verify Origin if present
  if (origin && origin !== allowedOrigin) {
    return res.status(403).json({
      success: false,
      error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
    });
  }

  // 3. Verify Referer origin if Origin header is missing
  if (!origin && referer) {
    try {
      const refererUrl = new URL(referer);
      const allowedUrl = new URL(allowedOrigin);
      if (refererUrl.origin !== allowedUrl.origin) {
        return res.status(403).json({
          success: false,
          error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
        });
      }
    } catch {
      return res.status(403).json({
        success: false,
        error: 'CSRF ভ্যালিডেশন ব্যর্থ হয়েছে। অবৈধ উৎস থেকে অনুরোধ।',
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
