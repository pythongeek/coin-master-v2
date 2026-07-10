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
  const [form, setForm] = useState({ username: '', password: '', token: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [require2FA, setRequire2FA] = useState(false);
  const [tempToken, setTempToken] = useState('');

  const handleLogin = async () => {
    setError('');
    if (!form.username || !form.password) {
      setError('Username and password are required.');
      return;
    }

    setLoading(true);
    try {
      // If 2FA step already triggered, verify the TOTP code.
      if (require2FA && tempToken) {
        const res = await fetch(`${API}/auth/2fa/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tempToken, token: form.token }),
        });
        const data = await res.json();

        if (!data.success) {
          setError(data.error || 'Invalid 2FA code.');
          trackEvent('admin_login_failed', { error: data.error || '2FA invalid' });
          return;
        }

        finalizeLogin(data.token, data.user);
        return;
      }

      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username, password: form.password }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Login failed.');
        trackEvent('admin_login_failed', { error: data.error || 'API Error' });
        return;
      }

      if (data.require2FA) {
        setTempToken(data.tempToken);
        setRequire2FA(true);
        return;
      }

      if (!data.user?.isAdmin) {
        setError('This account is not authorized for admin access.');
        trackEvent('admin_login_failed', { error: 'not_admin' });
        return;
      }

      finalizeLogin(data.token, data.user);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError('Network error. Please try again.');
      trackEvent('admin_login_failed', { error: errMsg });
    } finally {
      setLoading(false);
    }
  };

  const finalizeLogin = (token: string, user: any) => {
    storeToken(token);
    localStorage.setItem('cf_token', token);
    setTokenCookie(token);

    login({
      user: {
        userId: user.userId,
        username: user.username,
        balance: user.balance ?? 0,
        isAdmin: user.isAdmin,
        walletAddress: user.walletAddress,
        isFlagged: user.isFlagged ?? false,
        email: user.email,
      },
      token,
    });

    reconnectWithToken(token);

    identifyUser(user.userId, {
      username: user.username,
      email: user.email,
      walletAddress: user.walletAddress,
    });

    trackEvent('admin_login_success');
    const target = typeof window !== 'undefined'
      ? window.location.pathname.replace(/\/?login$/, '')
      : '/admin';
    window.location.href = target;
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

          {require2FA && (
            <input
              className="input-cyber w-full"
              placeholder="2FA code (6 digits)"
              value={form.token}
              onChange={(e) => setForm(p => ({ ...p, token: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              maxLength={6}
              inputMode="numeric"
              autoFocus
            />
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            className="btn-brand w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {loading ? 'Signing in...' : require2FA ? 'Verify 2FA' : 'Sign in to Admin'}
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
