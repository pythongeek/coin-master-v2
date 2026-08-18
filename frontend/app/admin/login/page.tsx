'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN LOGIN — Dedicated admin gateway login page
 * ═══════════════════════════════════════════════════════════════
 *
 *  Posts to /api/admin/login (NOT /api/auth/login). The backend sets
 *  an `admin_cf_token` httpOnly cookie scoped to Path=/api/admin, which
 *  the admin page (server-side gate) reads for subsequent requests.
 *  This cookie is NEVER sent to user-facing endpoints like /api/auth/*
 *  or /api/game/* — admin and user auth are completely isolated.
 *
 *  TOTP step-up: if the admin account has 2FA enrolled (column
 *  users.totp_enabled = true, set via /api/auth/2fa/setup +
 *  /api/auth/2fa/verify), the first login returns
 *  { requires2FA: true }. The frontend then shows a 6-digit TOTP
 *  input field and re-submits with { totp_code } included. The
 *  backend's `admin-auth.ts` POST /login handler verifies the TOTP
 *  via utils/totp.verifyTotp before setting the admin_cf_token
 *  cookie.
 *
 *  Without this step-up, an admin who enrolled 2FA could log in with
 *  only username + password — a regression vs. the pre-refactor flow.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Shield, ArrowLeft, KeyRound } from 'lucide-react';

const API = '/api/admin';

export default function AdminLoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ username: '', password: '', totp_code: '' });
  const [require2FA, setRequire2FA] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError('');
    if (!form.username || !form.password) {
      setError('Username and password are required.');
      return;
    }
    if (require2FA && !/^\d{6}$/.test(form.totp_code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, string> = {
        username: form.username,
        password: form.password,
      };
      if (require2FA) body.totp_code = form.totp_code;

      const res = await fetch(`${API}/login`, {
        method: 'POST',
        credentials: 'include',  // critical: receive the admin_cf_token cookie
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.success) {
        if (data.requires2FA) {
          setRequire2FA(true);
          setError('');
          return;
        }
        setError(data.error || 'Login failed.');
        return;
      }

      // The browser now has the admin_cf_token cookie. Force a hard
      // navigation so the server-side admin gate reads the cookie
      // fresh (Next.js router.push alone won't re-trigger SSR).
      // Strip the trailing /login from the current path so the
      // operator stays inside the /sysop-.../admin/ secret prefix.
      const target = window.location.pathname.replace(/\/?login$/, '') || '/admin';
      window.location.href = target;
    } catch (err: unknown) {
      setError('Network error. Please try again.');
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
            {require2FA ? 'Enter your authenticator code' : 'Secure gateway login for operators'}
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
            autoFocus
            disabled={require2FA}
          />

          <input
            className="input-cyber w-full"
            type="password"
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm(p => ({ ...p, password: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            disabled={require2FA}
          />

          {require2FA && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-text-muted text-xs font-mono">
                <KeyRound size={12} />
                <span>Authenticator code</span>
              </div>
              <input
                className="input-cyber w-full font-mono text-center tracking-[0.4em] text-lg"
                placeholder="000000"
                value={form.totp_code}
                onChange={(e) => setForm(p => ({ ...p, totp_code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                maxLength={6}
                inputMode="numeric"
                autoFocus
              />
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            className="btn-brand w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {loading
              ? (require2FA ? 'Verifying...' : 'Signing in...')
              : (require2FA ? 'Verify 2FA' : 'Sign in to Admin')}
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
