'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  MOBILE BET BAR — sticky bottom FLIP button for mobile only
 * ═══════════════════════════════════════════════════════════════
 *
 *  On mobile, the bet controls panel sits between the coin and the
 *  bottom of the viewport. The FLIP button inside that panel is below
 *  the fold on small phones, so tapping it scrolls the coin out of
 *  view and the user can't watch the spin.
 *
 *  This bar pins to the bottom of the viewport (mobile only, hidden on
 *  `lg:` and up) and shows a duplicate FLIP button that reads the
 *  current bet amount / choice / multiplier from the Zustand store.
 *  It reuses the same `socket.emit('game:bet', ...)` path as the
 *  desktop button, so behaviour is identical.
 *
 *  Trade-off: the bet amount shown here is the in-memory store value,
 *  which mirrors whatever the user last typed into the input. If the
 *  store hasn't hydrated yet (SSR / first paint), the button renders
 *  disabled — same gating as the desktop button.
 */

import { Coins, Square, Loader2 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { getSocket } from '@/lib/socket';

export default function MobileBetBar() {
  const user = useGameStore((s) => s.user);
  const gameStatus = useGameStore((s) => s.gameStatus);
  const betAmount = useGameStore((s) => s.betAmount);
  const currentChoice = useGameStore((s) => s.currentChoice);
  const multiplier = useGameStore((s) => s.multiplier);
  const setGameStatus = useGameStore((s) => s.setGameStatus);

  const isSpinning = gameStatus === 'spinning';
  const isResult = gameStatus === 'result';
  const canBet = !!user && !isSpinning;
  const overBalance = !!user && betAmount > user.balance;
  const disabled = !canBet || betAmount <= 0 || overBalance;

  const onFlip = () => {
    if (disabled) return;
    getSocket(undefined).emit('game:bet', {
      choice: currentChoice,
      amount: betAmount,
      multiplier,
      clientSeed: Math.random().toString(36).slice(2) + Date.now().toString(36),
    });
    setGameStatus('spinning');
  };

  return (
    <div
      className="lg:hidden fixed bottom-0 left-0 right-0 z-30 px-3 pb-3 pt-2
                 bg-gradient-to-t from-void via-void/95 to-transparent
                 backdrop-blur-sm border-t border-border/40"
      // Reserve bottom space so content above isn't hidden behind the bar.
      style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <div className="flex items-center gap-2 max-w-2xl mx-auto">
        {/* Bet amount recap — small, always-visible summary */}
        <div className="flex-1 min-w-0 glass-card px-3 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-text-muted text-[10px] font-mono uppercase tracking-wider">
              {currentChoice === 'heads' ? 'হেডস' : 'টেইলস'} · {multiplier.toFixed(2)}x
            </div>
            <div className="text-text-primary font-mono text-sm truncate">
              ${betAmount.toFixed(2)}
              {overBalance && (
                <span className="text-brand-red text-xs ml-1">ব্যালেন্স ছাড়া বেশি</span>
              )}
            </div>
          </div>
        </div>

        {/* FLIP button */}
        <button
          onClick={onFlip}
          disabled={disabled}
          aria-label="ফ্লিপ করুন"
          className={`
            shrink-0 px-6 py-3 rounded-xl font-display font-semibold text-base tracking-wide
            transition-all duration-150 flex items-center justify-center gap-2 min-w-[120px]
            disabled:cursor-not-allowed disabled:opacity-40
            ${isSpinning
              ? 'bg-surface2 text-text-muted border border-border'
              : 'bg-brand-green text-void shadow-brand-green active:translate-y-0.5'
            }
          `}
          style={!isSpinning ? { backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 55%)' } : undefined}
        >
          {isSpinning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              ঘুরছে
            </>
          ) : isResult ? (
            <>
              <Coins size={16} strokeWidth={2.25} />
              আবার
            </>
          ) : (
            <>
              <Coins size={16} strokeWidth={2.25} />
              FLIP
            </>
          )}
        </button>
      </div>
    </div>
  );
}