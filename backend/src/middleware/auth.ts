/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTH MIDDLEWARE — রুট সুরক্ষা
 * ═══════════════════════════════════════════════════════════════
 *
 *  প্রতিটি API কলে JWT টোকেন যাচাই করে।
 *  টোকেন না থাকলে বা ভুল হলে অ্যাক্সেস বন্ধ।
 * ═══════════════════════════════════════════════════════════════
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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
  const token = req.headers.authorization?.replace('Bearer ', '');

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
