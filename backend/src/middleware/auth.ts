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
}

// JWT টোকেন যাচাই করো
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'লগইন করুন। টোকেন পাওয়া যায়নি।' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret') as AuthPayload;
    (req as Request & { user: AuthPayload }).user = decoded;
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

// টোকেন তৈরি করো
export function createToken(payload: AuthPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
}
