// ══════════════════════════════════════════════════════════════
//  ADMIN AUTH MIDDLEWARE — reads admin_cf_token
//
//  Replacement for authMiddleware on /api/admin/* routes. Looks for
//  the admin_cf_token cookie (path-scoped to /api/admin) instead of
//  the user-facing cf_token cookie. Admin sessions are therefore
//  completely isolated from user sessions — a leaked cf_token cannot
//  be used to access admin endpoints, and an admin_cf_token never
//  travels to /api/auth/* or /api/game/*.
//
//  Cross-reference: routes/admin-auth.ts owns the cookie issuance /
//  verification helpers (setAdminCookie, verifyAdminToken).
// ══════════════════════════════════════════════════════════════

import { Request, Response, NextFunction } from 'express';
import { verifyAdminToken } from '../routes/admin-auth';

export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cookieHeader = req.headers.cookie;
  let token: string | undefined;
  if (cookieHeader) {
    for (const part of cookieHeader.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== 'admin_cf_token') continue;
      token = decodeURIComponent(part.slice(eq + 1).trim());
      break;
    }
  }

  if (!token) {
    res.status(401).json({ success: false, error: 'Admin session required.' });
    return;
  }

  const decoded = verifyAdminToken(token);
  if (!decoded) {
    res.status(401).json({ success: false, error: 'Admin session invalid or expired.' });
    return;
  }

  // Set both shapes so existing admin routes (which read req.user)
  // and any new admin-specific routes (which can read req.adminUser)
  // work without further refactoring. isAdmin=true is the canonical
  // signal that downstream roleMiddleware checks against.
  (req as Request & { user?: unknown }).user = {
    userId: decoded.userId,
    username: decoded.username,
    role: decoded.role,
    isAdmin: true,
    scope: 'admin',
  };
  next();
}