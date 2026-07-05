'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  SEED ROTATION PANEL — নিরাপত্তার জন্য Server seed রোটেশন
 * ═══════════════════════════════════════════════════════════════
 *
 *  Provably Fair সিস্টেমের গোপন সিড নিয়মিত পরিবর্তন করা
 *  নিরাপত্তার জন্য গুরুত্বপূর্ণ। এডমিন এখান থেকে ম্যানুয়ালি
 *  রোটেট করতে পারবে অথবা Auto Rotation দেখতে পারবে।
 *
 *  H4 FIX (frontend): rotating the seed invalidates every existing
 *  Provably Fair verification in flight. That's the highest-impact
 *  admin action — we now require the admin to re-enter their password
 *  in a confirmation modal before the request goes out. The backend
 *  (admin.ts seed/rotate handler) independently verifies the password
 *  via bcrypt; the UI re-prompt is the user-facing half of the
 *  step-up auth pattern.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { KeyRound, RotateCw, CheckCircle2, Lock, X, AlertTriangle } from 'lucide-react';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function SeedRotationPanel() {
  const [rotating, setRotating]       = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword]       = useState('');
  const [pwError, setPwError]         = useState<string | null>(null);
  const [lastResult, setLastResult]   = useState<{ hash: string; time: string } | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  // Reset the password field whenever the modal opens/closes so a stale
  // value doesn't linger between attempts.
  useEffect(() => {
    if (!confirmOpen) {
      setPassword('');
      setPwError(null);
    }
  }, [confirmOpen]);

  const openConfirm = () => {
    setPwError(null);
    setConfirmOpen(true);
  };
  const closeConfirm = () => setConfirmOpen(false);

  const submitRotate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!password) {
      setPwError('পাসওয়ার্ড দিন।');
      return;
    }
    setRotating(true);
    setPwError(null);
    try {
      const res = await fetch(`${API}/admin/seed/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (res.status === 401) {
        setPwError('পাসওয়ার্ড ভুল।');
        // Don't close the modal — let the admin retry.
        return;
      }
      if (res.status === 429) {
        setPwError('অনেক চেষ্টা। ৫ মিনিট পরে আবার চেষ্টা করুন।');
        return;
      }
      if (data.success) {
        setLastResult({
          hash: data.seedHash || '',
          time: new Date().toLocaleString('bn-BD'),
        });
        setConfirmOpen(false);
      } else {
        setPwError(data.error || 'রোটেশন ব্যর্থ।');
      }
    } catch {
      setPwError('সার্ভারে কানেক্ট করা যায়নি।');
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="glass-card p-5 border-brand-red/20">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={17} className="text-brand-red" />
        <h3 className="heading-display text-sm text-brand-red">Security — Seed Rotation</h3>
      </div>

      <p className="text-text-secondary text-xs font-mono leading-relaxed mb-4">
        Server seed নিয়মিত পরিবর্তন করলে সিস্টেম আরো নিরাপদ থাকে।
        ডিফল্টে প্রতি <span className="text-brand-gold">১০০ games</span> auto-rotation occurs.
        জরুরি প্রয়োজনে এখনই ম্যানুয়ালি রোটেট করতে পারেন।
        <br />
        <span className="text-text-muted text-[11px]">
          ⚠️ রোটেশনের পরে সব চলমান Provably Fair ভেরিফিকেশন বাতিল হবে — সিড ঘোষণার আগে চলমান Betগুলো সম্পন্ন হবে।
        </span>
      </p>

      <button
        onClick={openConfirm}
        disabled={rotating}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-brand-red/40 text-brand-red font-display
                   font-semibold text-sm hover:bg-brand-red/10 transition-all duration-150
                   disabled:opacity-50"
      >
        <RotateCw size={15} className={rotating ? 'animate-spin' : ''} />
        {rotating ? 'রোটেট হচ্ছে...' : 'এখনই সিড Rotate'}
      </button>

      {lastResult && (
        <div className="mt-4 p-3 rounded-lg bg-void border border-brand-green/20">
          <p className="flex items-center gap-1.5 text-brand-green text-xs font-mono font-medium mb-1">
            <CheckCircle2 size={13} /> New seed তৈরি হয়েছে
          </p>
          <p className="text-text-muted text-xs font-mono mb-1">Time: {lastResult.time}</p>
          <p className="text-text-muted text-xs font-mono break-all">
            Hash: <span className="text-brand-info">{lastResult.hash.slice(0, 40)}...</span>
          </p>
        </div>
      )}

      {/* অটো রোটেশন সেটিং রিমাইন্ডার */}
      <div className="mt-4 pt-4 border-t border-border flex items-center justify-between text-xs font-mono">
        <span className="text-text-muted">Auto Rotation</span>
        <span className="text-brand-info">Every 100 games</span>
      </div>
      <p className="text-text-muted text-[10px] font-mono mt-1">
        এই মান Control Panelের "নিরাপত্তা" ট্যাব থেকে পরিবর্তন করুন।
      </p>

      {/* ── H4: password confirmation modal (step-up auth) ───────── */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeConfirm}
        >
          <div
            className="glass-card w-full max-w-sm p-6 relative animate-float-up"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeConfirm}
              className="absolute top-4 right-4 text-text-muted hover:text-text-primary"
              aria-label="বন্ধ করুন"
            >
              <X size={18} />
            </button>

            <div className="text-center mb-5">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand-red/10 text-brand-red mb-3">
                <Lock size={22} />
              </div>
              <h2 className="heading-display text-base text-brand">Confirm Seed Rotation</h2>
              <p className="text-text-muted text-xs font-mono mt-1">
                আপনার এডমিন পাসওয়ার্ড দিয়ে নিশ্চিত করুন
              </p>
            </div>

            <form onSubmit={submitRotate}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="এডমিন পাসওয়ার্ড"
                autoFocus
                disabled={rotating}
                className="input-cyber w-full"
                aria-label="এডমিন পাসওয়ার্ড"
              />

              {pwError && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-brand-red/10 border border-brand-red/30 text-brand-red text-xs font-mono flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{pwError}</span>
                </div>
              )}

              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  onClick={closeConfirm}
                  disabled={rotating}
                  className="flex-1 py-2.5 rounded-lg border border-border text-text-muted text-sm font-mono hover:border-text-secondary disabled:opacity-50"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  disabled={rotating || !password}
                  className="flex-1 py-2.5 rounded-lg bg-brand-red text-void font-display font-semibold text-sm hover:bg-brand-red-dim disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  <RotateCw size={14} className={rotating ? 'animate-spin' : ''} />
                  {rotating ? 'রোটেট হচ্ছে...' : 'নিশ্চিত ও রোটেট'}
                </button>
              </div>

              <p className="mt-4 text-text-muted text-[10px] font-mono text-center">
                এই অ্যাকশন সব চলমান Provably Fair ভেরিফিকেশন বাতিল করবে।
                <br />
                ভুল পাসওয়ার্ড fraud_signals-এ লগ হবে।
              </p>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}