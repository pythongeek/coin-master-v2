'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN LOGIN — Dedicated admin gateway login page
 * ═══════════════════════════════════════════════════════════════
 *
 *  Unlike the game login modal, this page is reached only through
 *  the secret admin gateway URL. It logs the user in with the same
 *  cf_token so they can use both the admin panel and the game UI.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Coins, Loader2, Shield, ArrowLeft } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { storeToken, reconnectWithToken } from '@/lib/socket';
import { setTokenCookie } from '@/lib/auth-cookies';
import { trackEvent, identifyUser } from '@/utils/analytics';

const API = '/api';

export default function AdminLoginPage() {
  const router = useRouter();
  const { login } = useGameStore();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError('');
    if (!form.username || !form.password) {
      setError('Username and password are required.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Login failed.');
        trackEvent('admin_login_failed', { error: data.error || 'API Error' });
        return;
      }

      if (!data.user?.isAdmin) {
        setError('This account is not authorized for admin access.');
        trackEvent('admin_login_failed', { error: 'not_admin' });
        return;
      }

      // Store token the same way the game login modal does
      storeToken(data.token);
      localStorage.setItem('cf_token', data.token);
      setTokenCookie(data.token);

      login({
        user: {
          userId: data.user.userId,
          username: data.user.username,
          balance: data.user.balance ?? 0,
          isAdmin: data.user.isAdmin,
          walletAddress: data.user.walletAddress,
          isFlagged: data.user.isFlagged ?? false,
          email: data.user.email,
        },
        token: data.token,
      });

      reconnectWithToken(data.token);

      identifyUser(data.user.userId, {
        username: data.user.username,
        email: data.user.email,
        walletAddress: data.user.walletAddress,
      });

      trackEvent('admin_login_success');
      // Use full browser navigation so the secret gateway path stays in
      // the URL. Client-side router.push('/admin') would hit Next.js's
      // internal /admin route, which the middleware blocks with 404.
      const target = typeof window !== 'undefined'
        ? window.location.pathname.replace(/\/?login$/, '')
        : '/admin';
      window.location.href = target;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError('Network error. Please try again.');
      trackEvent('admin_login_failed', { error: errMsg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-void">
      <div className="glass-card w-full max-w-md p-8 relative">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-brand-gold/10 text-brand-gold mb-3">
            <Shield size={28} />
          </div>
          <h1 className="heading-display text-xl text-text-primary">Admin Access</h1>
          <p className="text-text-muted text-xs font-mono mt-1">
            Secure gateway login for operators
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-brand-red/10 border border-brand-red/30 text-brand-red text-xs font-mono">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <input
            className="input-cyber w-full"
            placeholder="Username"
            value={form.username}
            onChange={(e) => setForm(p => ({ ...p, username: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          />

          <input
            className="input-cyber w-full"
            type="password"
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm(p => ({ ...p, password: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          />

          <button
            onClick={handleLogin}
            disabled={loading}
            className="btn-brand w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {loading ? 'Signing in...' : 'Sign in to Admin'}
          </button>

          <Link
            href="/"
            className="flex items-center justify-center gap-1.5 text-text-muted text-xs font-mono hover:text-text-secondary mt-2"
          >
            <ArrowLeft size={12} />
            Back to CryptoFlip
          </Link>
        </div>
      </div>
    </main>
  );
}
