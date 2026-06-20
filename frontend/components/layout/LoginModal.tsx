'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  LOGIN MODAL — লগইন/রেজিস্ট্রেশন পপআপ
 * ═══════════════════════════════════════════════════════════════
 *
 *  দুটি উপায়ে লগইন:
 *  ① Web3 ওয়ালেট (MetaMask/Phantom) — এক ক্লিকে, পাসওয়ার্ড লাগে না
 *  ② ইউজারনেম/পাসওয়ার্ড — ঐতিহ্যবাহী পদ্ধতি
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import {
  isMetaMaskInstalled, isPhantomInstalled,
  connectMetaMask, connectPhantom, shortenAddress,
} from '@/lib/wallet';
import { useGameStore } from '@/lib/store';
import { storeToken } from '@/lib/socket';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Props {
  onClose: () => void;
}

export default function LoginModal({ onClose }: Props) {
  const { setUser, setToken } = useGameStore();
  const [mode, setMode] = useState<'choose' | 'wallet-connecting' | 'email'>('choose');
  const [isRegister, setIsRegister] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connectingType, setConnectingType] = useState<'metamask' | 'phantom' | null>(null);

  // ── সফল লগইন হ্যান্ডল করো ─────────────────────────────────────
  const handleSuccess = (data: { token: string; user: Record<string, unknown> }) => {
    storeToken(data.token);
    setToken(data.token);
    setUser({
      userId:        data.user.userId as string,
      username:      data.user.username as string,
      balance:       data.user.balance as number,
      isAdmin:       (data.user.isAdmin as boolean) || false,
      walletAddress: data.user.walletAddress as string | undefined,
    });
    localStorage.setItem('cf_user', JSON.stringify(data.user));
    onClose();
  };

  // ── MetaMask দিয়ে কানেক্ট করো ───────────────────────────────────
  const handleMetaMask = async () => {
    if (!isMetaMaskInstalled()) {
      window.open('https://metamask.io/download/', '_blank');
      return;
    }
    setConnectingType('metamask');
    setError('');
    try {
      const conn = await connectMetaMask();
      const res = await fetch(`${API}/api/auth/wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: conn.address, signature: conn.signature }),
      });
      const data = await res.json();
      if (data.success) handleSuccess(data);
      else setError(data.error || 'কানেক্ট করতে সমস্যা হয়েছে।');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'MetaMask কানেক্ট করতে সমস্যা হয়েছে।');
    }
    setConnectingType(null);
  };

  // ── Phantom দিয়ে কানেক্ট করো ──────────────────────────────────
  const handlePhantom = async () => {
    if (!isPhantomInstalled()) {
      window.open('https://phantom.app/download', '_blank');
      return;
    }
    setConnectingType('phantom');
    setError('');
    try {
      const conn = await connectPhantom();
      const res = await fetch(`${API}/api/auth/wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: conn.address, signature: conn.signature }),
      });
      const data = await res.json();
      if (data.success) handleSuccess(data);
      else setError(data.error || 'কানেক্ট করতে সমস্যা হয়েছে।');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Phantom কানেক্ট করতে সমস্যা হয়েছে।');
    }
    setConnectingType(null);
  };

  // ── ইমেইল/পাসওয়ার্ড লগইন বা রেজিস্ট্রেশন ───────────────────────
  const handleEmailAuth = async () => {
    setError('');
    if (!form.username || !form.password) {
      setError('ইউজারনেম ও পাসওয়ার্ড দিন।');
      return;
    }
    setLoading(true);
    try {
      const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) handleSuccess(data);
      else setError(data.error || 'কিছু একটা ভুল হয়েছে।');
    } catch {
      setError('সার্ভারে কানেক্ট করা যায়নি। ব্যাকএন্ড চালু আছে কিনা চেক করুন।');
    }
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="glass-card w-full max-w-sm p-6 relative animate-float-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* বন্ধ বাটন */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-text-muted hover:text-text-primary text-xl"
          aria-label="বন্ধ করুন"
        >
          ✕
        </button>

        {/* হেডার */}
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🪙</div>
          <h2 className="heading-display text-xl text-neon">CRYPTOFLIP-এ যোগ দিন</h2>
          <p className="text-text-muted text-xs font-mono mt-1">নতুন রেজিস্ট্রেশনে $5-$10 ওয়েলকাম বোনাস</p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-neon-red/10 border border-neon-red/30 text-neon-red text-xs font-mono">
            {error}
          </div>
        )}

        {mode === 'choose' && (
          <div className="space-y-3">
            {/* MetaMask বাটন */}
            <button
              onClick={handleMetaMask}
              disabled={connectingType !== null}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border
                         hover:border-neon-gold/50 hover:bg-neon-gold/5 transition-all duration-200
                         disabled:opacity-50"
            >
              <span className="text-2xl">🦊</span>
              <div className="text-left flex-1">
                <div className="font-display font-bold text-sm text-text-primary">MetaMask</div>
                <div className="text-text-muted text-xs font-mono">Ethereum / BSC ওয়ালেট</div>
              </div>
              {connectingType === 'metamask' && (
                <span className="text-neon-gold text-xs">⏳</span>
              )}
              {!isMetaMaskInstalled() && (
                <span className="text-text-muted text-xs">ইন্সটল করুন →</span>
              )}
            </button>

            {/* Phantom বাটন */}
            <button
              onClick={handlePhantom}
              disabled={connectingType !== null}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border
                         hover:border-neon-purple/50 hover:bg-neon-purple/5 transition-all duration-200
                         disabled:opacity-50"
            >
              <span className="text-2xl">👻</span>
              <div className="text-left flex-1">
                <div className="font-display font-bold text-sm text-text-primary">Phantom</div>
                <div className="text-text-muted text-xs font-mono">Solana ওয়ালেট</div>
              </div>
              {connectingType === 'phantom' && (
                <span className="text-neon-purple text-xs">⏳</span>
              )}
              {!isPhantomInstalled() && (
                <span className="text-text-muted text-xs">ইন্সটল করুন →</span>
              )}
            </button>

            {/* বিভাজক */}
            <div className="flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-text-muted text-xs font-mono">অথবা</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* ইমেইল অপশন */}
            <button
              onClick={() => setMode('email')}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border
                         hover:border-neon-blue/50 hover:bg-neon-blue/5 transition-all duration-200"
            >
              <span className="text-2xl">📧</span>
              <div className="text-left flex-1">
                <div className="font-display font-bold text-sm text-text-primary">ইউজারনেম/পাসওয়ার্ড</div>
                <div className="text-text-muted text-xs font-mono">ওয়ালেট ছাড়াই খেলুন</div>
              </div>
            </button>
          </div>
        )}

        {mode === 'email' && (
          <div className="space-y-3">
            <button
              onClick={() => setMode('choose')}
              className="text-text-muted text-xs font-mono hover:text-text-secondary mb-2"
            >
              ← ফিরে যান
            </button>

            <input
              className="input-cyber"
              placeholder="ইউজারনেম"
              value={form.username}
              onChange={(e) => setForm(p => ({ ...p, username: e.target.value }))}
            />

            {isRegister && (
              <input
                className="input-cyber"
                placeholder="ইমেইল (ঐচ্ছিক)"
                value={form.email}
                onChange={(e) => setForm(p => ({ ...p, email: e.target.value }))}
              />
            )}

            <input
              className="input-cyber"
              type="password"
              placeholder="পাসওয়ার্ড"
              value={form.password}
              onChange={(e) => setForm(p => ({ ...p, password: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && handleEmailAuth()}
            />

            <button
              onClick={handleEmailAuth}
              disabled={loading}
              className="btn-neon w-full disabled:opacity-50"
            >
              {loading ? '⏳ অপেক্ষা করুন...' : isRegister ? 'রেজিস্ট্রেশন করুন' : 'লগইন করুন'}
            </button>

            <p className="text-center text-text-muted text-xs font-mono">
              {isRegister ? 'অ্যাকাউন্ট আছে?' : 'নতুন এসেছেন?'}{' '}
              <button
                onClick={() => setIsRegister(!isRegister)}
                className="text-neon-green hover:underline"
              >
                {isRegister ? 'লগইন করুন' : 'রেজিস্ট্রেশন করুন'}
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
