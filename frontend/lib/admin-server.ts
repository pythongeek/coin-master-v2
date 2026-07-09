/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN SERVER — server-side authentication helper
 * ═══════════════════════════════════════════════════════════════
 *
 *  fetchAdminUser() is intended to be called from a Next.js Server
 *  Component. It reads the cf_token cookie, forwards it to the backend
 *  /api/auth/me endpoint, and returns the user only if the backend says
 *  the account has an allowed admin role.
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
  // Inside the Docker network the server component reaches the backend
  // directly. Outside Docker (local dev) it falls back to localhost.
  return process.env.INTERNAL_API_URL || 'http://localhost:4000';
}

interface AuthMeResponse {
  success?: boolean;
  data?: AdminUser;
  user?: Partial<AdminUser> & { isAdmin?: boolean; two_factor_enabled?: boolean };
}

export async function fetchAdminUser(token: string): Promise<AdminUser | null> {
  const base = internalApiBaseUrl();
  try {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      return null;
    }

    const json = (await res.json()) as AuthMeResponse;

    if (!json.success) {
      return null;
    }

    const payload = json.data ?? (json.user as AdminUser | undefined);
    if (!payload) {
      return null;
    }

    const role = payload.role || (payload.isAdmin ? 'super_admin' : 'user');
    if (!ADMIN_ROLES.has(role)) {
      return null;
    }

    return {
      ...payload,
      role,
      two_factor_enabled: payload.two_factor_enabled ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Gate used by the admin page. If the backend says the user is an admin
 * and has 2FA enabled, the server renders the admin shell. Any client-side
 * tampering of localStorage cannot bypass this check.
 */
export async function isAdminAuthorized(token: string): Promise<AdminUser | null> {
  const user = await fetchAdminUser(token);
  if (!user) return null;
  // 2FA is mandatory for admin accounts when ADMIN_2FA_REQUIRED is enabled.
  // The backend also enforces this on login, but we double-check at the edge
  // so a stolen JWT from a non-2FA session cannot reach the admin panel.
  if (!user.two_factor_enabled) return null;
  return user;
}
