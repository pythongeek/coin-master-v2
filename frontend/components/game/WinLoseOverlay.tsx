'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  WIN / LOSE OVERLAY — রেজাল্ট অ্যানিমেশন
 * ═══════════════════════════════════════════════════════════════
 *
 *  গেম শেষে স্ক্রিনে জয় বা পরাজয়ের অ্যানিমেশন দেখায়।
 *  স্বয়ংক্রিয়ভাবে ৩ সেকেন্ড পর সরে যায়।
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { useGameStore, BetResult } from '@/lib/store';

// ── Notification Toast ─────────────────────────────────────────
export function NotificationStack() {
  const { notifications, removeNotification } = useGameStore();

  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="নোটিফিকেশন"
    >
      {notifications.map((notif) => (
        <div
          key={notif.id}
          className={`
            pointer-events-auto px-4 py-3 rounded-xl border font-mono text-sm
            animate-float-up shadow-lg max-w-xs
            ${notif.type === 'win'
              ? 'bg-neon-green/20 border-neon-green/50 text-neon-green'
              : notif.type === 'lose'
              ? 'bg-neon-red/20 border-neon-red/50 text-neon-red'
              : notif.type === 'rain'
              ? 'bg-neon-gold/20 border-neon-gold/50 text-neon-gold'
              : 'bg-surface border-border text-text-primary'
            }
          `}
          role="alert"
        >
          {notif.message}
        </div>
      ))}
    </div>
  );
}

// ── Result Card — কয়েনের নিচে দেখায় ───────────────────────────
export function ResultCard({ result }: { result: BetResult }) {
  const { resetGame } = useGameStore();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      resetGame();
    }, 5000);
    return () => clearTimeout(timer);
  }, [result.betId]);

  if (!visible) return null;

  return (
    <div
      className={`
        rounded-2xl border-2 p-5 text-center animate-float-up
        ${result.won
          ? 'border-neon-green bg-neon-green/10 shadow-neon-green'
          : 'border-neon-red bg-neon-red/10 shadow-neon-red'
        }
      `}
      role="status"
      aria-label={result.won ? 'জিতেছেন' : 'হেরেছেন'}
    >
      {/* ইমোজি */}
      <div className="text-5xl mb-2">
        {result.won ? '🎉' : '😔'}
      </div>

      {/* রেজাল্ট */}
      <div className={`heading-display text-2xl mb-1 ${result.won ? 'text-neon-green' : 'text-neon-red'}`}>
        {result.won ? 'জিতেছেন!' : 'হেরেছেন!'}
      </div>

      {/* কয়েনের ফলাফল */}
      <div className="text-text-secondary font-mono text-sm mb-3">
        {result.result === 'heads' ? '👑 HEADS' : '🦅 TAILS'}
      </div>

      {/* পরিমাণ */}
      <div className={`font-mono font-bold text-xl mb-1 ${result.won ? 'text-neon-green' : 'text-neon-red'}`}>
        {result.won ? `+$${result.payout.toFixed(2)}` : `-$${result.betAmount.toFixed(2)}`}
      </div>

      {/* Win Streak */}
      {result.won && result.winStreak > 1 && (
        <div className="text-neon-gold font-mono text-sm">
          🔥 {result.winStreak} ধারাবাহিক জয়!
        </div>
      )}

      {/* Provably Fair সিড */}
      <details className="mt-3 text-left">
        <summary className="text-text-muted text-xs font-mono cursor-pointer hover:text-text-secondary">
          🔐 Provably Fair ভেরিফিকেশন ডেটা
        </summary>
        <div className="mt-2 space-y-1 text-xs font-mono text-text-muted bg-void p-2 rounded-lg">
          <div className="break-all">
            <span className="text-neon-blue">Server Seed: </span>
            {result.verification.serverSeed}
          </div>
          <div className="break-all">
            <span className="text-neon-green">Hash: </span>
            {result.verification.serverSeedHash.slice(0, 32)}...
          </div>
          <div>
            <span className="text-neon-purple">Nonce: </span>
            {result.verification.nonce}
          </div>
        </div>
      </details>
    </div>
  );
}
