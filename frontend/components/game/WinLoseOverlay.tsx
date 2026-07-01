'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  WIN / LOSE OVERLAY — v2 with Framer Motion
 * ═══════════════════════════════════════════════════════════════
 *
 *  Upgraded from 1.7 basic (5s display, no animation library):
 *    - NotificationStack: now uses framer-motion <AnimatePresence>
 *      for spring entrance + slide-out on dismiss
 *    - ResultCard: spring entrance (scale + opacity), auto-dismiss
 *      reduced from 5s → 3s per guide §1.7, drop-shadow glow on
 *      the win amount, separate lose/lose-bet amount styling
 *    - Big win amount uses brand-gold with text-shadow drop-glow
 *      for that "slot machine celebration" feel
 *    - Provably Fair section kept (zero changes)
 *
 *  Animation tokens (durations + easing) come from
 *  `@/design-system/tokens/animations` for consistency with the
 *  rest of the system.
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trophy, XCircle, Flame, Lock, CloudRain, Info } from 'lucide-react';
import { useGameStore, BetResult } from '@/lib/store';
import { duration, easing } from '@/design-system/tokens/animations';

// Inline notification type (mirrors lib/store.ts; not exported from there)
type NotificationType = 'win' | 'lose' | 'rain' | 'info';

// ════════════════════════════════════════════════════════════════
//  NotificationStack — toast notifications (framer-motion)
// ════════════════════════════════════════════════════════════════

const ICON_MAP = { win: Trophy, lose: XCircle, rain: CloudRain, info: Info } as const;

const NOTIF_VARIANT_CLASSES: Record<NotificationType, string> = {
  win:   'bg-surface2 border-brand-green/40 text-brand-green shadow-brand-green',
  lose:  'bg-surface2 border-brand-red/40 text-brand-red shadow-brand-red',
  rain:  'bg-surface2 border-brand-gold/40 text-brand-gold shadow-brand-gold',
  info:  'bg-surface2 border-border text-text-primary',
};

export function NotificationStack() {
  const { notifications } = useGameStore();

  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="নোটিফিকেশন"
    >
      <AnimatePresence initial={false}>
        {notifications.map((notif) => {
          const Icon = ICON_MAP[notif.type];
          return (
            <motion.div
              key={notif.id}
              role="alert"
              initial={{ opacity: 0, x: 40, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.95 }}
              transition={{
                type: 'spring',
                stiffness: 320,
                damping: 24,
                mass: 0.8,
              }}
              className={[
                'pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl border font-mono text-sm',
                'max-w-xs',
                NOTIF_VARIANT_CLASSES[notif.type],
              ].join(' ')}
            >
              <Icon size={16} className="shrink-0" />
              {notif.message}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  ResultCard — appears below the coin, 3s auto-dismiss per guide §1.7
// ════════════════════════════════════════════════════════════════

const RESULT_VISIBLE_MS = 3000; // per guide §1.7

export function ResultCard({ result }: { result: BetResult }) {
  const { resetGame } = useGameStore();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      resetGame();
    }, RESULT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [result.betId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={result.betId}
          role="status"
          aria-label={result.won ? 'জিতেছেন' : 'হেরেছেন'}
          initial={{ opacity: 0, scale: 0.85, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{
            type: 'spring',
            stiffness: 280,
            damping: 22,
            mass: 0.9,
          }}
          className={[
            'glass-card-raised rounded-2xl border p-6 text-center',
            result.won
              ? 'border-brand-green/50 shadow-brand-green'
              : 'border-brand-red/50 shadow-brand-red',
          ].join(' ')}
        >
          {/* Icon — bounces in slightly after the card */}
          <motion.div
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{
              delay: 0.1,
              type: 'spring',
              stiffness: 400,
              damping: 12,
            }}
            className={[
              'inline-flex items-center justify-center w-14 h-14 rounded-full mb-3',
              result.won ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red',
            ].join(' ')}
          >
            {result.won ? <Trophy size={28} strokeWidth={2} /> : <XCircle size={28} strokeWidth={2} />}
          </motion.div>

          {/* Result label */}
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: duration.base, ease: easing.outExpo }}
            className={[
              'heading-display text-xl mb-1',
              result.won ? 'text-brand-green' : 'text-brand-red',
            ].join(' ')}
          >
            {result.won ? 'জিতেছেন!' : 'হেরেছেন!'}
          </motion.div>

          {/* Coin result */}
          <div className="text-text-secondary font-mono text-sm mb-3">
            {result.result === 'heads' ? '🪷 HEADS' : '🐯 TAILS'}
          </div>

          {/* Big amount — with drop-shadow glow on win per guide §1.7 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: 0.2,
              type: 'spring',
              stiffness: 320,
              damping: 16,
            }}
            className={[
              'font-mono font-bold text-3xl mb-1 tabular-nums',
              result.won ? 'text-brand-gold' : 'text-brand-red',
            ].join(' ')}
            style={
              result.won
                ? {
                    textShadow:
                      '0 0 20px rgba(232, 169, 61, 0.5), 0 0 40px rgba(232, 169, 61, 0.25)',
                  }
                : undefined
            }
          >
            {result.won ? `+$${result.payout.toFixed(2)}` : `-$${result.betAmount.toFixed(2)}`}
          </motion.div>

          {/* Win streak indicator */}
          {result.won && result.winStreak > 1 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.3, duration: duration.base, ease: easing.outExpo }}
              className="flex items-center justify-center gap-1.5 text-brand-gold font-mono text-sm mt-1"
            >
              <Flame size={14} />
              {result.winStreak} ধারাবাহিক জয়
            </motion.div>
          )}

          {/* Provably Fair section — unchanged */}
          <details className="mt-4 text-left">
            <summary className="flex items-center gap-1.5 text-text-muted text-xs font-mono cursor-pointer hover:text-text-secondary">
              <Lock size={12} />
              Provably Fair ভেরিফিকেশন ডেটা
            </summary>
            <div className="mt-2 space-y-1 text-xs font-mono text-text-muted bg-void p-2.5 rounded-lg border border-border">
              <div className="break-all">
                <span className="text-brand-info">Server Seed: </span>
                {result.verification.serverSeed}
              </div>
              <div className="break-all">
                <span className="text-brand-green">Hash: </span>
                {result.verification.serverSeedHash.slice(0, 32)}...
              </div>
              <div>
                <span className="text-brand-maroon">Nonce: </span>
                {result.verification.nonce}
              </div>
            </div>
          </details>
        </motion.div>
      )}
    </AnimatePresence>
  );
}