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
 *  │ বেট        │  থ্রিডি Coin Arena      │  লাইভ চ্যাট       │
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
import {
  Coins, Trophy, XCircle, Loader2,
  LayoutDashboard, LogOut, Settings, AlertTriangle,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { useSocketEvents } from '@/lib/useSocketEvents';
import { getSocket, clearToken } from '@/lib/socket';
import { useSound } from '@/hooks/useSound';
import MobileBetBar from '@/components/game/MobileBetBar';
import LiveChat from '@/components/game/LiveChat';
import GameSidebar from '@/components/game/GameSidebar';
import SettingsModal from '@/components/game/SettingsModal';
import SupportChat from '@/components/game/SupportChat';
import LoginModal from '@/components/layout/LoginModal';
import LanguageSelector from '@/components/layout/LanguageSelector';
import MobileGamePanels from '@/components/game/MobileGamePanels';
import { useTranslation } from '@/hooks/useTranslation';
import { NotificationStack, ResultCard } from '@/components/game/WinLoseOverlay';
import { ScatterBonus } from '@/components/game/ScatterBonus';
import { StreakLadder } from '@/components/game/StreakLadder';
import { shortenAddress } from '@/lib/wallet';

const Coin3D = lazy(() => import('@/components/game/Coin3D'));

export default function GamePage() {
  const { t } = useTranslation();
  const {
    user, gameStatus, lastResult, betHistory, onlineCount,
    logout, loadSettings, showSettings, toggleSettings,
  } = useGameStore();

  const [showLogin, setShowLogin] = useState(false);
  const arenaRef = useRef<HTMLDivElement>(null);
  const { play } = useSound();

  useSocketEvents();

  // ── Initialize socket + load settings ────────────────────────
  useEffect(() => {
    getSocket(undefined);
    loadSettings();
  }, [loadSettings]);

  // Play flip sound when the coin starts spinning
  useEffect(() => {
    if (gameStatus === 'spinning') {
      play('flip');
    }
  }, [gameStatus, play]);

  const handleLogout = () => {
    clearToken();
    logout();
  };

  // ── Win/loss visual feedback, sounds, and accessibility ───
  useEffect(() => {
    if (gameStatus !== 'result' || !lastResult) return;

    // Play result sound
    if (lastResult.won) {
      play('win');
    } else {
      play('lose');
    }

    // Arena glow
    const glowClass = lastResult.won ? 'arena-win-glow' : 'arena-loss-glow';
    arenaRef.current?.classList.add(glowClass);
    const glowTimer = setTimeout(() => {
      arenaRef.current?.classList.remove(glowClass);
    }, 2500);

    if (lastResult.won) {
      // Confetti based on payout size
      const bigWin = lastResult.payout >= 50;
      const burst = () => {
        if (typeof window !== 'undefined' && (window as any).confetti) {
          (window as any).confetti({
            particleCount: bigWin ? 90 : 55,
            spread: bigWin ? 80 : 65,
            origin: { x: 0.5, y: 0.55 },
            colors: bigWin
              ? ['#FFD700', '#00C566', '#FFFFFF', '#E8A93D']
              : ['#FFD700', '#00C566'],
            disableForReducedMotion: true,
          });
        }
      };
      burst();
      if (bigWin) {
        setTimeout(burst, 250);
        setTimeout(burst, 500);
        arenaRef.current?.classList.add('screen-shake');
        setTimeout(() => arenaRef.current?.classList.remove('screen-shake'), 500);
      }
    }

    return () => clearTimeout(glowTimer);
  }, [gameStatus, lastResult, play]);

  // ── Recent history dots (last 25) ──────────────────────
  const historyDots = betHistory.slice(0, 25);

  return (
    <>
      <NotificationStack />
      <SupportChat />
      <ScatterBonus />
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
                <div className="text-text-muted text-xs font-mono">{t('balance')}</div>
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
                  <span className="text-text-secondary text-xs font-mono">{onlineCount} {t('onlineCount')}</span>
                </div>
              </div>
              <div className="w-px h-8 bg-border hidden sm:block" />
              <LanguageSelector />
              <button
                onClick={toggleSettings}
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-gold text-xs font-mono transition-colors"
                aria-label="Settings"
              >
                <Settings size={14} />
              </button>
              <Link href="/dashboard" className="flex items-center gap-1.5 text-text-muted hover:text-brand-info text-xs font-mono">
                <LayoutDashboard size={13} />
                <span className="hidden sm:inline">{t('dashboardTitle')}</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-red text-xs font-mono"
              >
                <LogOut size={13} />
                <span className="hidden sm:inline">{t('logout')}</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-text-muted text-xs font-mono">{onlineCount} {t('onlineCount')}</span>
              <LanguageSelector />
              <button
                onClick={toggleSettings}
                className="text-text-muted hover:text-brand-gold text-xs font-mono transition-colors"
                aria-label="Settings"
              >
                <Settings size={14} />
              </button>
              <button onClick={() => setShowLogin(true)} className="btn-brand text-sm py-2 px-4">
                {t('connectWallet')}
              </button>
            </div>
          )}
        </nav>

        {/* ══════════════════════════════════════════════════════
            Main 3-column game area
           ══════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col lg:flex-row gap-3 p-3 lg:p-4 min-h-0 overflow-y-auto lg:overflow-visible pb-28 lg:pb-4">

          {/* ── Left column: unified tabbed sidebar ── */}
          <aside className="lg:w-[340px] xl:w-[380px] shrink-0 flex flex-col gap-3 order-2 lg:order-1 min-h-0">
            <GameSidebar />
          </aside>

          {/* ── Center column: 3D arena + history + result ── */}
          <div className="flex-1 flex flex-col gap-3 order-1 lg:order-2 min-h-0">

            {/* 3D coin arena */}
            <div
              ref={arenaRef}
              className="glass-card relative flex-1 min-h-[300px] lg:min-h-0 overflow-hidden flex items-center justify-center"
            >
              {/* Ambient background glow */}
              <div
                className="absolute inset-0 ambient-bg pointer-events-none"
                style={{
                  background: 'radial-gradient(ellipse at center, rgba(232,169,61,0.05) 0%, transparent 70%)',
                }}
              />

              {/* Status badge */}
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
                  {gameStatus === 'idle'     && 'Place a bet'}
                  {gameStatus === 'spinning' && 'Flipping...'}
                  {gameStatus === 'result'   && (lastResult?.won ? 'You won!' : 'You lost')}
                </div>
              </div>

              <div className="absolute top-4 right-4 z-10 px-2 py-1 rounded border border-border text-text-muted text-xs font-mono">
                House edge: 2%
              </div>

              {/* History dots — inside arena at the bottom */}
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
                        title={`${bet.result === 'heads' ? 'Heads' : 'Tails'} — ${bet.won ? 'Win' : 'Loss'} — $${bet.payout.toFixed(2)}`}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Coin */}
              <Suspense fallback={
                <div className="absolute inset-0 flex items-center justify-center">
                  <Coins size={56} className="text-brand-gold animate-spin-slow" strokeWidth={1.5} />
                </div>
              }>
                <Coin3D gameStatus={gameStatus} result={lastResult?.result ?? null} won={lastResult?.won ?? null} />
              </Suspense>
            </div>

            {/* Result card (below arena) */}
            {gameStatus === 'result' && lastResult && (
              <ResultCard result={lastResult} />
            )}
          </div>

          {/* ── Right column: live chat + big wins + streak ladder ── */}
          <aside className="lg:w-[320px] xl:w-[360px] shrink-0 order-3 overflow-hidden min-h-0 flex flex-col gap-3">
            <StreakLadder />
            <LiveChat />
          </aside>
        </div>
      </main>
      {/* Mobile sticky FLIP bar */}
      <MobileGamePanels />
      <MobileBetBar />
    </>
  );
}
