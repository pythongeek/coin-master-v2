'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME PAGE — Stake-style 3-column layout
 * ═══════════════════════════════════════════════════════════════
 *
 *  Layout (desktop ≥ lg):
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │  NAVBAR (sticky top, full width)                                │
 *  ├──────────────┬──────────────────────────────┬───────────────────┤
 *  │  LEFT 380px  │  CENTER (flex, fills)         │  RIGHT 320px      │
 *  │  (sticky)    │                              │  (sticky)         │
 *  │              │  ┌────────────────────────┐  │  ┌─────────────┐  │
 *  │  BetControls │  │  GameHeader            │  │  │ LiveStats   │  │
 *  │              │  │  ┌──────────────────┐  │  │  │ (h-1/2)     │  │
 *  │              │  │  │  Coin3D scene    │  │  │  ├─────────────┤  │
 *  │              │  │  │  (flex-1)        │  │  │  │ LiveChat    │  │
 *  │              │  │  └──────────────────┘  │  │  │ (h-1/2)     │  │
 *  │              │  │  WinOverlay (abs)       │  │  └─────────────┘  │
 *  │              │  │  GameFooter            │  │                   │
 *  │              │  └────────────────────────┘  │                   │
 *  │              │  ┌────────────────────────┐  │                   │
 *  │              │  │  Mode toggle +         │  │                   │
 *  │              │  │  SquadFlip OR          │  │                   │
 *  │              │  │  ResultCard            │  │                   │
 *  │              │  └────────────────────────┘  │                   │
 *  │              │  ┌────────────────────────┐  │                   │
 *  │              │  │  ProvablyFair widget   │  │                   │
 *  │              │  └────────────────────────┘  │                   │
 *  └──────────────┴──────────────────────────────┴───────────────────┘
 *
 *  Mobile (< lg): single column, order = game → controls → chat.
 *
 *  Why fixed sidebar widths (per guide §1.3):
 *    - Stake-style sidebars are FIXED width (380 + 320) so the center
 *      area can adapt responsively.
 *    - This replaces the old `grid-cols-3` which used fluid 1/3-2/3 split.
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState, Suspense, lazy } from 'react';
import Link from 'next/link';
import {
  Coins,
  Dices,
  Users,
  Trophy,
  XCircle,
  Loader2,
  LayoutDashboard,
  LogOut,
  Shield,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { useSocketEvents } from '@/lib/useSocketEvents';
import { getSocket, clearToken } from '@/lib/socket';
import BetControls from '@/components/game/BetControls';
import LiveChat from '@/components/game/LiveChat';
import LiveStats from '@/components/game/LiveStats';
import SquadFlip from '@/components/game/SquadFlip';
import ProvablyFairWidget from '@/components/game/ProvablyFair';
import MobileBetBar from '@/components/game/MobileBetBar';
import LoginModal from '@/components/layout/LoginModal';
import { NotificationStack, ResultCard } from '@/components/game/WinLoseOverlay';
import { shortenAddress } from '@/lib/wallet';
import { WalletModal } from '@/components/wallet';
import { WalletButton } from '@/components/wallet/WalletButton';

// Lazy-load the heavy 3D scene so initial render doesn't block
const Coin3D = lazy(() => import('@/components/game/Coin3D'));

// Sidebar widths per guide §1.3
const SIDEBAR_LEFT_WIDTH = '380px';
const SIDEBAR_RIGHT_WIDTH = '320px';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function GamePage() {
  const { user, gameStatus, lastResult, onlineCount, logout, token, updateBalance } = useGameStore();
  const [showLogin, setShowLogin] = useState(false);
  const [showSquad, setShowSquad] = useState(false);
  const [showWallet, setShowWallet] = useState(false);

  useSocketEvents();

  // ── Refresh balance on mount ──────────────────────────────────
  // The Zustand `persist` middleware rehydrates `user` from localStorage
  // after a reload, but the balance inside is stale. The server's
  // `trg_sync_user_balance` trigger updates users.balance on every UPDATE,
  // so a fresh GET /api/auth/me gives the canonical number. We do this
  // once on mount, only if we're already authenticated. Fails silently
  // if the token is invalid (next bet attempt will surface the 401).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data?.success && data?.user?.balance !== undefined) {
          updateBalance(Number(data.user.balance));
        }
      } catch {
        // network error — keep the cached balance, don't block UI
      }
    })();
    return () => { cancelled = true; };
  // Run only on mount (or when the token changes via login/logout).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    getSocket(undefined);
  }, []);

  const handleLogout = () => {
    clearToken();
    logout();
  };

  // ── Status pill (used inside center column, top-left of coin) ──
  const statusBadge = (
    <div className="absolute top-4 left-4 z-10">
      <div
        className={[
          'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-mono',
          gameStatus === 'spinning'
            ? 'border-brand-gold/50 bg-brand-gold/10 text-brand-gold'
            : gameStatus === 'result'
            ? lastResult?.won
              ? 'border-brand-green/50 bg-brand-green/10 text-brand-green'
              : 'border-brand-red/50 bg-brand-red/10 text-brand-red'
            : 'border-border bg-surface text-text-muted',
        ].join(' ')}
      >
        {gameStatus === 'spinning' && <Loader2 size={12} className="animate-spin" />}
        {gameStatus === 'result' && (lastResult?.won ? <Trophy size={12} /> : <XCircle size={12} />)}
        {gameStatus === 'idle' && <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />}
        {gameStatus === 'idle' && 'বেট ধরুন'}
        {gameStatus === 'spinning' && 'ঘুরছে...'}
        {gameStatus === 'result' && (lastResult?.won ? 'জিতেছেন!' : 'হেরেছেন')}
      </div>
    </div>
  );

  // ── House-edge badge (used inside center column, top-right of coin) ──
  const houseEdgeBadge = (
    <div className="absolute top-4 right-4 z-10 px-2 py-1 rounded border border-border text-text-muted text-xs font-mono">
      হাউজ এজ: 2%
    </div>
  );

  return (
    <>
      <NotificationStack />
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      {showWallet && token && (
        <WalletModal
          open={showWallet}
          onClose={() => setShowWallet(false)}
          token={token}
          onBalanceChange={(newCoins) => updateBalance(newCoins)}
        />
      )}

      <div className="min-h-screen flex flex-col">
        {/* ── NAVBAR ───────────────────────────────────────────── */}
        <nav className="sticky top-0 z-40 glass-card mx-4 mt-4 px-5 py-3 flex items-center justify-between flex-wrap gap-3">
          <Link href="/" className="flex items-center gap-2 heading-display text-lg">
            <div className="w-7 h-7 rounded-lg bg-brand-green/10 text-brand-green flex items-center justify-center">
              <Coins size={15} />
            </div>
            <span className="text-text-primary">
              CRYPTO<span className="text-brand-green">FLIP</span>
            </span>
          </Link>

          {user ? (
            <div className="flex items-center gap-4">
              <WalletButton
                balance={user.balance}
                onClick={() => setShowWallet(true)}
              />
              <div className="w-px h-8 bg-border" />
              <div className="text-right">
                <div className="text-text-muted text-xs font-mono flex items-center gap-1 justify-end">
                  {user.walletAddress && <span>🦊</span>}
                  {user.walletAddress ? shortenAddress(user.walletAddress) : user.username}
                </div>
                <div className="flex items-center gap-1 justify-end">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse-soft" />
                  <span className="text-text-secondary text-xs font-mono">
                    {onlineCount} অনলাইন
                  </span>
                </div>
              </div>
              <Link
                href="/dashboard"
                className="flex items-center gap-1.5 text-text-muted hover:text-brand-info text-xs font-mono"
              >
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

        {/* ── MAIN GRID — 3 columns at lg+ ──────────────────────── */}
        <div
          className="flex-1 grid gap-4 p-4"
          style={{
            gridTemplateColumns: '1fr',
          }}
        >
          {/* ── DESKTOP (lg+): explicit fixed sidebars + center fills ── */}
          <div
            className="hidden lg:grid gap-4"
            style={{
              gridTemplateColumns: `${SIDEBAR_LEFT_WIDTH} minmax(0, 1fr) ${SIDEBAR_RIGHT_WIDTH}`,
              minHeight: 'calc(100vh - 120px)',
            }}
          >
            {/* LEFT SIDEBAR — Bet controls (sticky scroll) */}
            <aside className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
              <div className="glass-card p-5">
                <BetControls />
              </div>
            </aside>

            {/* CENTER — Game area */}
            <main className="flex flex-col gap-4 min-w-0">
              {/* Coin scene — takes all remaining vertical space */}
              <div className="glass-card relative flex-1" style={{ minHeight: '420px' }}>
                {statusBadge}
                {houseEdgeBadge}

                <Suspense
                  fallback={
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Coins size={56} className="text-brand-gold animate-spin-slow" strokeWidth={1.5} />
                    </div>
                  }
                >
                  <Coin3D gameStatus={gameStatus} result={lastResult?.result ?? null} />
                </Suspense>
              </div>

              {/* Result card (only after a result) */}
              {gameStatus === 'result' && lastResult && (
                <ResultCard result={lastResult} />
              )}

              {/* Mode toggle + panel */}
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSquad(false)}
                  className={[
                    'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all',
                    !showSquad
                      ? 'bg-brand-green/15 text-brand-green border border-brand-green/35'
                      : 'border border-border text-text-muted hover:border-brand-green/30',
                  ].join(' ')}
                >
                  <Dices size={14} />
                  একক বেট
                </button>
                <button
                  onClick={() => setShowSquad(true)}
                  className={[
                    'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all',
                    showSquad
                      ? 'bg-brand-maroon/15 text-brand-maroon border border-brand-maroon/35'
                      : 'border border-border text-text-muted hover:border-brand-maroon/30',
                  ].join(' ')}
                >
                  <Users size={14} />
                  স্কোয়াড ফ্লিপ
                </button>
              </div>

              {showSquad ? <SquadFlip /> : null}

              {/* Provably Fair */}
              <ProvablyFairWidget />
            </main>

            {/* RIGHT SIDEBAR — Live stats + live chat (stacked, sticky) */}
            <aside
              className="flex flex-col gap-4 overflow-hidden"
              style={{ maxHeight: 'calc(100vh - 120px)' }}
            >
              <div className="flex-1 min-h-0 overflow-y-auto">
                <LiveStats />
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <LiveChat />
              </div>
            </aside>
          </div>

          {/* ── MOBILE (sm/md): single column, optimized for one-screen play ──
              Order: coin → result → mode toggle → compact bet panel → live stats/chat
              The FLIP button is duplicated as a sticky bar at the viewport bottom
              (MobileBetBar component) so the user never has to scroll past the coin
              to tap it. The desktop FLIP button inside BetControls is hidden on
              mobile to avoid two competing controls. */}
          <div className="lg:hidden flex flex-col gap-3 pb-24">
            <div className="glass-card relative px-2 py-3">
              {statusBadge}
              {houseEdgeBadge}
              <Suspense
                fallback={
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Coins size={40} className="text-brand-gold animate-spin-slow" strokeWidth={1.5} />
                  </div>
                }
              >
                <Coin3D gameStatus={gameStatus} result={lastResult?.result ?? null} />
              </Suspense>
            </div>

            {gameStatus === 'result' && lastResult && <ResultCard result={lastResult} />}

            {/* Mode toggle — compact pills, single row */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowSquad(false)}
                className={[
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-mono',
                  !showSquad
                    ? 'bg-brand-green/15 text-brand-green border border-brand-green/35'
                    : 'border border-border text-text-muted',
                ].join(' ')}
              >
                <Dices size={14} />
                একক বেট
              </button>
              <button
                onClick={() => setShowSquad(true)}
                className={[
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-mono',
                  showSquad
                    ? 'bg-brand-maroon/15 text-brand-maroon border border-brand-maroon/35'
                    : 'border border-border text-text-muted',
                ].join(' ')}
              >
                <Users size={14} />
                স্কোয়াড ফ্লিপ
              </button>
            </div>

            <div className="glass-card p-4">
              <BetControls />
            </div>

            {showSquad ? <SquadFlip /> : null}

            <ProvablyFairWidget />

            <div className="h-[300px]">
              <LiveStats />
            </div>

            <div className="h-[300px]">
              <LiveChat />
            </div>
          </div>
        </div>

        {/* Footer credit (subtle) */}
        <footer className="hidden lg:flex px-4 pb-4 pt-2 items-center justify-center gap-2 text-text-muted text-xs">
          <Shield size={11} />
          <span>Provably Fair · 2% House Edge · Crypto Rain Enabled</span>
        </footer>
      </div>

      {/* ── MOBILE ONLY: sticky bottom FLIP bar ─────────────────────
          Lives outside the main grid so it overlays the viewport
          bottom regardless of scroll position. `lg:hidden` makes it
          disappear on desktop where the BetControls inline FLIP button
          is the primary control. */}
      <MobileBetBar />
    </>
  );
}