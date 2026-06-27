'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME PAGE — সম্পূর্ণ গেম স্ক্রিন (Phase 4 — 3-Column Layout)
 * ═══════════════════════════════════════════════════════════════
 *
 *  লেআউট (Desktop):
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  NAVBAR — ব্যালেন্স | অনলাইন | সেটিংস | লগইন/ওয়ালেট      │
 *  ├────────────┬───────────────────────────┬────────────────────┤
 *  │ বেট        │  থ্রিডি কয়েন Arena      │  লাইভ চ্যাট       │
 *  │ কন্ট্রোলস │  + হিস্ট্রি ডটস         │  + Big Wins        │
 *  │ + স্কোয়াড │  + Win/Loss ওভারলে      │  + Crypto Rain     │
 *  │ + ফেয়ার   │  + সেটিংস বার           │                    │
 *  └────────────┴───────────────────────────┴────────────────────┘
 *
 *  মোবাইল: স্ট্যাকড সিঙ্গেল কলাম (Center → Left → Right)
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState, useRef, Suspense, lazy } from 'react';
import Link from 'next/link';
import confetti from 'canvas-confetti';
import {
  Coins, Dices, Users, Trophy, XCircle, Loader2,
  LayoutDashboard, LogOut, Settings,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { useSocketEvents } from '@/lib/useSocketEvents';
import { getSocket, clearToken } from '@/lib/socket';
import { useSound } from '@/hooks/useSound';
import BetControls from '@/components/game/BetControls';
import LiveChat from '@/components/game/LiveChat';
import SquadFlip from '@/components/game/SquadFlip';
import ProvablyFairWidget from '@/components/game/ProvablyFair';
import AffiliatePanel from '@/components/game/AffiliatePanel';
import PromoWidget from '@/components/game/PromoWidget';
import SettingsModal from '@/components/game/SettingsModal';
import LoginModal from '@/components/layout/LoginModal';
import { NotificationStack, ResultCard } from '@/components/game/WinLoseOverlay';
import { shortenAddress } from '@/lib/wallet';

const Coin3D = lazy(() => import('@/components/game/Coin3D'));

export default function GamePage() {
  const {
    user, gameStatus, lastResult, betHistory, onlineCount,
    logout, loadSettings, showSettings, toggleSettings,
  } = useGameStore();

  const [showLogin, setShowLogin] = useState(false);
  const [showSquad, setShowSquad] = useState(false);
  const arenaRef = useRef<HTMLDivElement>(null);
  const { play } = useSound();

  useSocketEvents();

  // ── সকেট ইনিশিয়ালাইজ + সেটিংস লোড ────────────────────────
  useEffect(() => {
    getSocket(undefined);
    loadSettings();
  }, [loadSettings]);

  const handleLogout = () => {
    clearToken();
    logout();
  };

  // ── Win/Loss ভিজ্যুয়াল ফিডব্যাক (confetti, shake, flash) ───
  useEffect(() => {
    if (gameStatus !== 'result' || !lastResult) return;

    if (lastResult.won) {
      // Big win: large confetti + screen shake
      if (lastResult.payout >= 50) {
        const fire = () => {
          confetti({
            particleCount: 90,
            spread: 80,
            origin: { x: 0.5, y: 0.55 },
            colors: ['#FFD700', '#00C566', '#FFFFFF', '#E8A93D'],
            disableForReducedMotion: true,
          });
        };
        fire();
        setTimeout(fire, 250);
        setTimeout(fire, 500);
        arenaRef.current?.classList.add('screen-shake');
        setTimeout(() => arenaRef.current?.classList.remove('screen-shake'), 500);
      } else {
        // Regular win: small confetti
        confetti({
          particleCount: 55,
          spread: 65,
          origin: { x: 0.5, y: 0.55 },
          colors: ['#FFD700', '#00C566'],
          disableForReducedMotion: true,
        });
      }
    } else {
      // Loss: flash maroon overlay
      arenaRef.current?.classList.add('loss-flash');
      setTimeout(() => arenaRef.current?.classList.remove('loss-flash'), 500);
    }
  }, [gameStatus, lastResult]);

  // ── রিসেন্ট হিস্ট্রি ডটস (শেষ ২৫টি) ──────────────────────
  const historyDots = betHistory.slice(0, 25);

  return (
    <>
      <NotificationStack />
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      {showSettings && <SettingsModal />}

      <main className="h-screen flex flex-col overflow-hidden bg-void">

        {/* ══════════════════════════════════════════════════════
            NAVBAR
           ══════════════════════════════════════════════════════ */}
        <nav className="glass-card mx-3 mt-3 px-5 py-2.5 flex items-center justify-between flex-wrap gap-3 shrink-0">
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
              <button
                onClick={toggleSettings}
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-gold text-xs font-mono transition-colors"
                aria-label="সেটিংস"
              >
                <Settings size={14} />
              </button>
              <Link href="/dashboard" className="flex items-center gap-1.5 text-text-muted hover:text-brand-info text-xs font-mono">
                <LayoutDashboard size={13} />
                <span className="hidden sm:inline">ড্যাশবোর্ড</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-red text-xs font-mono"
              >
                <LogOut size={13} />
                <span className="hidden sm:inline">লগআউট</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-text-muted text-xs font-mono">{onlineCount} দর্শক</span>
              <button
                onClick={toggleSettings}
                className="text-text-muted hover:text-brand-gold text-xs font-mono transition-colors"
                aria-label="সেটিংস"
              >
                <Settings size={14} />
              </button>
              <button onClick={() => setShowLogin(true)} className="btn-brand text-sm py-2 px-4">
                লগইন / ওয়ালেট কানেক্ট
              </button>
            </div>
          )}
        </nav>

        {/* ══════════════════════════════════════════════════════
            মেইন 3-কলাম গেম এরিয়া
           ══════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col lg:flex-row gap-3 p-3 min-h-0 overflow-hidden">

          {/* ── বাম কলাম: বেট কন্ট্রোলস + স্কোয়াড + ফেয়ার ── */}
          <aside className="lg:w-[340px] xl:w-[380px] shrink-0 flex flex-col gap-3 order-2 lg:order-1 overflow-y-auto min-h-0">

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

            {/* Provably Fair (collapsible) */}
            <ProvablyFairWidget />

            {/* Affiliate & Referrals Panel */}
            <AffiliatePanel />

            {/* Promo Codes & Welcome Bonuses Widget */}
            <PromoWidget />
          </aside>

          {/* ── কেন্দ্র কলাম: 3D Arena + হিস্ট্রি + রেজাল্ট ── */}
          <div className="flex-1 flex flex-col gap-3 order-1 lg:order-2 min-h-0">

            {/* 3D কয়েন Arena */}
            <div
              ref={arenaRef}
              className="glass-card relative flex-1 min-h-[300px] lg:min-h-0 overflow-hidden"
            >
              {/* Ambient background glow */}
              <div
                className="absolute inset-0 ambient-bg pointer-events-none"
                style={{
                  background: 'radial-gradient(ellipse at center, rgba(232,169,61,0.05) 0%, transparent 70%)',
                }}
              />

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

              {/* হিস্ট্রি ডটস — Arena এর ভিতরে নিচে */}
              {historyDots.length > 0 && (
                <div className="absolute bottom-4 left-4 right-4 z-10">
                  <div className="flex items-center gap-1.5 flex-wrap justify-center">
                    {historyDots.map((bet, i) => (
                      <div
                        key={bet.betId}
                        className={`w-2.5 h-2.5 rounded-full transition-all duration-200 ${
                          i === 0 ? 'ring-2 ring-white/20 scale-110' : ''
                        }`}
                        style={{
                          backgroundColor: bet.won ? '#00C566' : '#E8384F',
                          opacity: 1 - i * 0.025,
                        }}
                        title={`${bet.result === 'heads' ? 'হেডস' : 'টেইলস'} — ${bet.won ? 'জয়' : 'হার'} — $${bet.payout.toFixed(2)}`}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* কয়েন */}
              <Suspense fallback={
                <div className="absolute inset-0 flex items-center justify-center">
                  <Coins size={56} className="text-brand-gold animate-spin-slow" strokeWidth={1.5} />
                </div>
              }>
                <Coin3D gameStatus={gameStatus} result={lastResult?.result ?? null} />
              </Suspense>
            </div>

            {/* রেজাল্ট কার্ড (Arena এর নিচে) */}
            {gameStatus === 'result' && lastResult && (
              <ResultCard result={lastResult} />
            )}
          </div>

          {/* ── ডান কলাম: লাইভ চ্যাট + Big Wins ── */}
          <aside className="lg:w-[320px] xl:w-[360px] shrink-0 order-3 overflow-hidden min-h-0 flex flex-col">
            <LiveChat />
          </aside>
        </div>
      </main>
    </>
  );
}
