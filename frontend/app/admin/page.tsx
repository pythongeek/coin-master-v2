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
import Link from 'next/link';
import { AlertCircle, LogOut } from 'lucide-react';
import { fetchAdminUser } from '@/lib/admin-server';
import AdminClientShell from '@/components/dashboard/AdminClientShell';

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get('cf_token')?.value;
  const user = token ? await fetchAdminUser(token) : null;

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 text-center">
          <AlertCircle size={32} className="mx-auto text-brand-red mb-3" />
          <h2 className="heading-display text-lg text-text-primary mb-2">Access denied</h2>
          <p className="text-text-muted text-sm font-mono mb-4">
            You must be signed in as an admin to view this panel.
          </p>
          <Link
            href="/game?login=admin"
            className="inline-block btn-brand py-2 px-5 rounded-lg font-mono text-sm"
          >
            Go to login
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
