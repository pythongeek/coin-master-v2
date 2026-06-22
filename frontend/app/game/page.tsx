'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME PAGE — সম্পূর্ণ গেম স্ক্রিন
 * ═══════════════════════════════════════════════════════════════
 *
 *  লেআউট (Desktop):
 *  ┌─────────────────────────────────────────────────┐
 *  │  NAVBAR — ব্যালেন্স | অনলাইন | লগইন/ওয়ালেট     │
 *  ├──────────────────────┬──────────────────────────┤
 *  │  থ্রিডি কয়েন       │  লাইভ চ্যাট             │
 *  │  + বেট কন্ট্রোলস   │  + Crypto Rain           │
 *  │  + স্কোয়াড ফ্লিপ   │                          │
 *  ├──────────────────────┴──────────────────────────┤
 *  │  PROVABLY FAIR VERIFICATION WIDGET              │
 *  └─────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState, Suspense, lazy } from 'react';
import Link from 'next/link';
import { Coins, Dices, Users, Trophy, XCircle, Loader2, LayoutDashboard, LogOut } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { useSocketEvents } from '@/lib/useSocketEvents';
import { getSocket, clearToken } from '@/lib/socket';
import BetControls from '@/components/game/BetControls';
import LiveChat from '@/components/game/LiveChat';
import SquadFlip from '@/components/game/SquadFlip';
import ProvablyFairWidget from '@/components/game/ProvablyFair';
import LoginModal from '@/components/layout/LoginModal';
import { NotificationStack, ResultCard } from '@/components/game/WinLoseOverlay';
import { shortenAddress } from '@/lib/wallet';

const Coin3D = lazy(() => import('@/components/game/Coin3D'));

export default function GamePage() {
  const { user, gameStatus, lastResult, onlineCount, logout } = useGameStore();
  const [showLogin, setShowLogin] = useState(false);
  const [showSquad, setShowSquad] = useState(false);

  useSocketEvents();

  useEffect(() => {
    getSocket(undefined);
  }, []);

  const handleLogout = () => {
    clearToken();
    logout();
  };

  return (
    <>
      <NotificationStack />
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}

      <main className="min-h-screen flex flex-col">

        {/* ── NAVBAR ─────────────────────────────────────── */}
        <nav className="glass-card mx-4 mt-4 px-5 py-3 flex items-center justify-between flex-wrap gap-3">
          <Link href="/" className="flex items-center gap-2 heading-display text-lg">
            <div className="w-7 h-7 rounded-lg bg-brand-green/10 text-brand-green flex items-center justify-center">
              <Coins size={15} />
            </div>
            <span className="text-text-primary">CRYPTO<span className="text-brand-green">FLIP</span></span>
          </Link>

          {user ? (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-text-muted text-xs font-mono">ব্যালেন্স</div>
                <div className="balance-number text-lg">${user.balance.toFixed(2)}</div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div className="text-right">
                <div className="text-text-muted text-xs font-mono flex items-center gap-1 justify-end">
                  {user.walletAddress && <span>🦊</span>}
                  {user.walletAddress ? shortenAddress(user.walletAddress) : user.username}
                </div>
                <div className="flex items-center gap-1 justify-end">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse-soft" />
                  <span className="text-text-secondary text-xs font-mono">{onlineCount} অনলাইন</span>
                </div>
              </div>
              <Link href="/dashboard" className="flex items-center gap-1.5 text-text-muted hover:text-brand-info text-xs font-mono">
                <LayoutDashboard size={13} />
                ড্যাশবোর্ড
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-red text-xs font-mono"
              >
                <LogOut size={13} />
                লগআউট
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-text-muted text-xs font-mono">{onlineCount} দর্শক</span>
              <button onClick={() => setShowLogin(true)} className="btn-brand text-sm py-2 px-4">
                লগইন / ওয়ালেট কানেক্ট
              </button>
            </div>
          )}
        </nav>

        {/* ── মেইন গেম এরিয়া ──────────────────────────────── */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">

          {/* বাম: কয়েন + বেট কন্ট্রোলস */}
          <div className="lg:col-span-2 flex flex-col gap-4">

            {/* থ্রিডি কয়েন */}
            <div className="glass-card relative" style={{ minHeight: '320px' }}>

              {/* স্ট্যাটাস ব্যাজ */}
              <div className="absolute top-4 left-4 z-10">
                <div className={`
                  flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-mono
                  ${gameStatus === 'spinning'
                    ? 'border-brand-gold/50 bg-brand-gold/10 text-brand-gold'
                    : gameStatus === 'result'
                    ? lastResult?.won
                      ? 'border-brand-green/50 bg-brand-green/10 text-brand-green'
                      : 'border-brand-red/50 bg-brand-red/10 text-brand-red'
                    : 'border-border bg-surface text-text-muted'
                  }
                `}>
                  {gameStatus === 'spinning' && <Loader2 size={12} className="animate-spin" />}
                  {gameStatus === 'result' && (lastResult?.won ? <Trophy size={12} /> : <XCircle size={12} />)}
                  {gameStatus === 'idle' && <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />}
                  {gameStatus === 'idle'     && 'বেট ধরুন'}
                  {gameStatus === 'spinning' && 'ঘুরছে...'}
                  {gameStatus === 'result'   && (lastResult?.won ? 'জিতেছেন!' : 'হেরেছেন')}
                </div>
              </div>

              <div className="absolute top-4 right-4 z-10 px-2 py-1 rounded border border-border text-text-muted text-xs font-mono">
                হাউজ এজ: 2%
              </div>

              {/* কয়েন */}
              <Suspense fallback={
                <div className="absolute inset-0 flex items-center justify-center">
                  <Coins size={56} className="text-brand-gold animate-spin-slow" strokeWidth={1.5} />
                </div>
              }>
                <Coin3D gameStatus={gameStatus} result={lastResult?.result ?? null} />
              </Suspense>
            </div>

            {/* রেজাল্ট কার্ড */}
            {gameStatus === 'result' && lastResult && (
              <ResultCard result={lastResult} />
            )}

            {/* মোড টগল: একক বেট vs স্কোয়াড ফ্লিপ */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowSquad(false)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all ${
                  !showSquad
                    ? 'bg-brand-green/15 text-brand-green border border-brand-green/35'
                    : 'border border-border text-text-muted hover:border-brand-green/30'
                }`}
              >
                <Dices size={14} />
                একক বেট
              </button>
              <button
                onClick={() => setShowSquad(true)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all ${
                  showSquad
                    ? 'bg-brand-maroon/15 text-brand-maroon border border-brand-maroon/35'
                    : 'border border-border text-text-muted hover:border-brand-maroon/30'
                }`}
              >
                <Users size={14} />
                স্কোয়াড ফ্লিপ
              </button>
            </div>

            {/* বেট কন্ট্রোলস অথবা স্কোয়াড */}
            {showSquad ? (
              <SquadFlip />
            ) : (
              <div className="glass-card p-5">
                <BetControls />
              </div>
            )}

            {/* Provably Fair */}
            <ProvablyFairWidget />
          </div>

          {/* ডান: লাইভ চ্যাট */}
          <div className="lg:col-span-1">
            <LiveChat />
          </div>
        </div>
      </main>
    </>
  );
}
