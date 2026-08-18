/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTH MIDDLEWARE — রুট সুরক্ষা
 * ═══════════════════════════════════════════════════════════════
 *
 *  প্রতিটি API কলে JWT টোকেন যাচাই করে।
 *  টোকেন না থাকলে বা ভুল হলে অ্যাক্সেস বন্ধ।
 *
 *  PR-1A (cm2 step 1): read JWT from `Authorization: Bearer` first,
 *  then fall back to the `cf_token` cookie so the auth flow can move
 *  to httpOnly cookies without breaking existing Bearer-header clients.
 *  Inlined cookie parsing keeps us off cookie-parser (no new dep).
 * ═══════════════════════════════════════════════════════════════
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/**
 * Parse a single key out of the raw Cookie header.
 *
 * Express does not populate `req.cookies` unless cookie-parser is
 * mounted. We deliberately avoid that dependency here and parse only
 * the key we care about (`cf_token`). If more cookies are ever needed,
 * install cookie-parser properly.
 *
 * Why percent-decode: cookies are sent URL-encoded by the browser
 * when written via `res.cookie(value, { ... })` with non-ASCII or
 * special chars in the value. JWTs are base64url (alnum + - + _) so
 * the decode is a no-op for them in practice, but we call it for
 * correctness.
 */
function readCookieValue(cookieHeader: string | undefined, key: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== key) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface AuthPayload {
  userId: string;
  username: string;
  isAdmin: boolean;
  role?: string;
  /** Alias for userId, provided for v2-pro module compatibility. */
  id?: string;
}

export interface AuthRequest extends Request {
  user: AuthPayload;
}

/**
 * JWT secret used across auth services. Failing to set it is a hard production
 * blocker: every token would be signed with a public default value.
 */
const JWT_SECRET = ((): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET environment variable is required and must be at least 32 characters. Refusing to start.');
  }
  return secret;
})();

export { JWT_SECRET };

// JWT টোকেন যাচাই করো
export function authMiddleware(req: Request, res: Response, next: NextFunction): Response | void {
  // Bearer header first — keeps existing clients working unchanged.
  // Cookie fallback for PR-1A: if no Authorization header, look for
  // the httpOnly cf_token cookie set by the login route. The browser
  // sends the cookie automatically on same-origin requests (and via
  // the Next.js catch-all proxy for /api/*), so no client code change
  // is needed to use the cookie path.
  let token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    token = readCookieValue(req.headers.cookie, 'cf_token');
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'লগইন করুন। টোকেন পাওয়া যায়নি।' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AuthPayload & { isTemp?: boolean };
    if (decoded.isTemp) {
      return res.status(401).json({ success: false, error: '২এফএ যাচাইকরণ সম্পন্ন করুন।' });
    }
    (req as Request & { user: AuthPayload }).user = { ...decoded, id: decoded.userId };
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'টোকেন মেয়াদ শেষ বা ভুল। আবার লগইন করুন।' });
  }
}

// শুধু এডমিনের জন্য
export function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  const user = (req as Request & { user: AuthPayload }).user;
  if (!user?.isAdmin) {
    return res.status(403).json({ success: false, error: 'এডমিন অ্যাক্সেস প্রয়োজন।' });
  }
  next();
}

// নির্দিষ্ট রোলের জন্য এক্সেস কন্ট্রোল
export function roleMiddleware(allowedRoles: ('super_admin' | 'support' | 'finance' | 'auditor')[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & { user?: AuthPayload }).user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'লগইন করুন। টোকেন পাওয়া যায়নি।' });
    }
    const userRole = user.role || (user.isAdmin ? 'super_admin' : 'user');
    if (userRole === 'super_admin' || allowedRoles.includes(userRole as any)) {
      return next();
    }
    return res.status(403).json({ success: false, error: 'অনুমতি নেই। প্রয়োজনীয় পারমিশন নেই।' });
  };
}

// টোকেন তৈরি করো
export function createToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
}
