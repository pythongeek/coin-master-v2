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
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Shield, ArrowLeft } from 'lucide-react';

const API = '/api/admin';

export default function AdminLoginPage() {
  const router = useRouter();
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
      const res = await fetch(`${API}/login`, {
        method: 'POST',
        credentials: 'include',  // critical: receive the admin_cf_token cookie
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username, password: form.password }),
      });
      const data = await res.json();

      if (!data.success) {
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
            autoFocus
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