'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  MOBILE BET BAR — sticky bottom FLIP button for mobile only
 * ═══════════════════════════════════════════════════════════════
 */

import { Coins, Loader2 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { emitSocket } from '@/lib/socket';

export default function MobileBetBar() {
  const user = useGameStore((s) => s.user);
  const gameStatus = useGameStore((s) => s.gameStatus);
  const betAmount = useGameStore((s) => s.betAmount);
  const currentChoice = useGameStore((s) => s.currentChoice);
  const targetMultiplier = useGameStore((s) => s.targetMultiplier);
  const setGameStatus = useGameStore((s) => s.setGameStatus);

  const isSpinning = gameStatus === 'spinning';
  const isResult = gameStatus === 'result';
  const canBet = !!user && !isSpinning;
  const overBalance = !!user && betAmount > user.balance;
  const disabled = !canBet || betAmount <= 0 || overBalance;

  const onFlip = () => {
    if (disabled) return;
    emitSocket('game:bet', {
      choice: currentChoice,
      amount: betAmount,
      multiplier: targetMultiplier,
      clientSeed: Math.random().toString(36).slice(2) + Date.now().toString(36),
    });
    setGameStatus('spinning');
  };

  return (
    <div
      className="lg:hidden fixed bottom-0 left-0 right-0 z-30 px-3 pb-3 pt-2
                 bg-gradient-to-t from-void via-void/95 to-transparent
                 backdrop-blur-sm border-t border-border/40"
      style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <div className="flex items-center gap-2 max-w-2xl mx-auto">
        <div className="flex-1 min-w-0 glass-card px-3 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-text-muted text-[10px] font-mono uppercase tracking-wider">
              {currentChoice === 'heads' ? 'Heads' : 'Tails'} · {targetMultiplier.toFixed(2)}x
            </div>
            <div className="text-text-primary font-mono text-sm truncate">
              ${betAmount.toFixed(2)}
              {overBalance && (
                <span className="text-brand-red text-xs ml-1">Exceeds balance</span>
              )}
            </div>
          </div>
        </div>

        <button
          onClick={onFlip}
          disabled={disabled}
          aria-label="Flip"
          className={`
            shrink-0 px-6 py-3 rounded-xl font-display font-semibold text-base tracking-wide
            transition-all duration-150 flex items-center justify-center gap-2 min-w-[120px]
            disabled:cursor-not-allowed disabled:opacity-40
            ${isSpinning
              ? 'bg-surface2 text-text-muted border border-border'
              : 'bg-brand-green text-void shadow-brand-green active:translate-y-0.5'
            }
          `}
        >
          {isSpinning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Spinning
            </>
          ) : isResult ? (
            <>
              <Coins size={16} strokeWidth={2.25} />
              Again
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
