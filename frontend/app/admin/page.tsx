/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN PANEL PAGE — Server-side access gate
 *
 *  The admin shell is rendered only after the server validates the
 *  user's JWT against the backend. No localStorage is used for the
 *  gate; any tampered client-side value cannot bypass this check.
 * ═══════════════════════════════════════════════════════════════
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import Link from 'next/link';
import { AlertCircle, LogOut } from 'lucide-react';
import { isAdminAuthorized } from '@/lib/admin-server';
import AdminClientShell from '@/components/dashboard/AdminClientShell';

export const runtime = 'edge';

// Admin gate URL — must match the nginx secret-path prefix exactly.
const ADMIN_SECRET_PATH='sysop-...xvAm';
const ADMIN_LOGIN_URL = `/${ADMIN_SECRET_PATH}/admin/login`;

// Admin cookie name (matches backend admin-auth.ts).
// The cookie has Path=/ so it is sent when the operator navigates to
// the admin page URL. NAME-based isolation: user routes never read this.
const ADMIN_COOKIE_NAME = 'admin_cf_token';

export default async function AdminPage() {
  const cookieStore = await cookies();
  // Read admin_cf_token (NOT cf_token). The admin and user auth
  // surfaces are completely isolated — a regular user's cf_token
  // cannot reach this page.
  const token = cookieStore.get('admin_cf_token')?.value;
  const user = token ? await isAdminAuthorized(token) : null;

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 text-center">
          <AlertCircle size={32} className="mx-auto text-brand-red mb-3" />
          <h2 className="heading-display text-lg text-text-primary mb-2">Admin access required</h2>
          <p className="text-text-muted text-sm font-mono mb-4">
            You must be signed in as an admin to view this panel.
          </p>
          <Link
            href={ADMIN_LOGIN_URL}
            className="inline-block btn-brand py-2 px-5 rounded-lg font-mono text-sm"
          >
            Sign in to admin
          </Link>
        </div>
      </main>
    );
  }

  return (
    <AdminClientShell
      user={{
        username: user.username,
        role: user.role,
        twoFactorEnabled: !!user.two_factor_enabled,
      }}
    />
  );
}
