/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN SERVER — server-side authentication helper
 * ═══════════════════════════════════════════════════════════════
 *
 *  Reads the admin_cf_token cookie (Path=/api/admin, set by the
 *  dedicated /api/admin/login endpoint). Forwards it to the backend's
 *  /api/admin/me endpoint, which validates it server-side and returns
 *  the admin user. If the backend says the cookie is invalid/expired,
 *  or the user is no longer admin, we return null and the admin page
 *  renders its rejection panel.
 *
 *  This is intentionally separate from user auth (lib/auth-cookies +
 *  /api/auth/me). A user with cf_token cannot access the admin panel,
 *  and an admin with admin_cf_token cannot access the game UI.
 * ═══════════════════════════════════════════════════════════════
 */

export interface AdminUser {
  userId: string;
  username: string;
  email: string | null;
  walletAddress: string | null;
  role: string;
  isAdmin: boolean;
  two_factor_enabled: boolean;
}

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'support', 'finance', 'auditor']);

function internalApiBaseUrl(): string {
  // Edge runtime can only read env vars explicitly exposed via
  // next.config.js. INTERNAL_API_URL is set on the container but not
  // declared in next.config.js, so process.env returns undefined here
  // on the build. The fallback `http://backend:4000` is the Docker
  // Compose service name and resolves on the coin-master network.
  // For local dev (operators running on Windows), set INTERNAL_API_URL
  // to http://localhost:4000 in next.config.js so the build picks it up.
  return process.env.INTERNAL_API_URL || 'http://backend:4000';
}

interface AdminMeResponse {
  success?: boolean;
  user?: Partial<AdminUser> & { isAdmin?: boolean; two_factor_enabled?: boolean };
}

/**
 * Server-side admin gate. Pass the admin_cf_token cookie value
 * (from `cookies()` in Next.js Server Components). Returns the
 * admin user if the backend validates the cookie AND the user has
 * an admin role. Returns null otherwise.
 */
export async function isAdminAuthorized(token: string | undefined): Promise<AdminUser | null> {
  if (!token) return null;

  const base = internalApiBaseUrl();
  const url = `${base}/api/admin/me`;
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: `admin_cf_token=${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const json = (await res.json()) as AdminMeResponse;
    if (!json.success || !json.user) return null;

    const u = json.user;
    // The /api/admin/me endpoint is gated by adminAuthMiddleware on the
    // backend, so reaching it at all proves admin role. The response shape
    // historically included isAdmin=true; some legacy shapes omit it. Accept
    // either — we trust the endpoint's auth check, not the field.
    const role = u.role || 'user';
    if (!ADMIN_ROLES.has(role)) return null;

    return {
      userId: u.userId || '',
      username: u.username || '',
      email: u.email ?? null,
      walletAddress: u.walletAddress ?? null,
      role,
      isAdmin: true,
      two_factor_enabled: u.two_factor_enabled ?? false,
    };
  } catch {
    return null;
  }
}