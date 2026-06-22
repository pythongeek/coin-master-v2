'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  WIN / LOSE OVERLAY — রেজাল্ট অ্যানিমেশন
 * ═══════════════════════════════════════════════════════════════
 *
 *  গেম শেষে স্ক্রিনে জয় বা পরাজয়ের অ্যানিমেশন দেখায়।
 *  স্বয়ংক্রিয়ভাবে ৫ সেকেন্ড পর সরে যায়।
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { Trophy, XCircle, Flame, Lock, CloudRain, Info } from 'lucide-react';
import { useGameStore, BetResult } from '@/lib/store';

// ── Notification Toast ─────────────────────────────────────────
export function NotificationStack() {
  const { notifications } = useGameStore();

  const ICON_MAP = { win: Trophy, lose: XCircle, rain: CloudRain, info: Info } as const;

  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="নোটিফিকেশন"
    >
      {notifications.map((notif) => {
        const Icon = ICON_MAP[notif.type];
        return (
          <div
            key={notif.id}
            className={`
              pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl border font-mono text-sm
              animate-float-up shadow-elevate-lg max-w-xs
              ${notif.type === 'win'
                ? 'bg-surface2 border-brand-green/40 text-brand-green'
                : notif.type === 'lose'
                ? 'bg-surface2 border-brand-red/40 text-brand-red'
                : notif.type === 'rain'
                ? 'bg-surface2 border-brand-gold/40 text-brand-gold'
                : 'bg-surface2 border-border text-text-primary'
              }
            `}
            role="alert"
          >
            <Icon size={16} className="shrink-0" />
            {notif.message}
          </div>
        );
      })}
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
        glass-card-raised rounded-2xl border p-6 text-center animate-float-up
        ${result.won
          ? 'border-brand-green/50 shadow-brand-green'
          : 'border-brand-red/50 shadow-brand-red'
        }
      `}
      role="status"
      aria-label={result.won ? 'জিতেছেন' : 'হেরেছেন'}
    >
      {/* আইকন */}
      <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-3 ${
        result.won ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red'
      }`}>
        {result.won ? <Trophy size={28} strokeWidth={2} /> : <XCircle size={28} strokeWidth={2} />}
      </div>

      {/* রেজাল্ট */}
      <div className={`heading-display text-xl mb-1 ${result.won ? 'text-brand-green' : 'text-brand-red'}`}>
        {result.won ? 'জিতেছেন!' : 'হেরেছেন!'}
      </div>

      {/* কয়েনের ফলাফল */}
      <div className="text-text-secondary font-mono text-sm mb-3">
        {result.result === 'heads' ? '🪷 HEADS' : '🐯 TAILS'}
      </div>

      {/* পরিমাণ */}
      <div className={`font-mono font-semibold text-xl mb-1 ${result.won ? 'text-brand-green' : 'text-brand-red'}`}>
        {result.won ? `+$${result.payout.toFixed(2)}` : `-$${result.betAmount.toFixed(2)}`}
      </div>

      {/* Win Streak */}
      {result.won && result.winStreak > 1 && (
        <div className="flex items-center justify-center gap-1.5 text-brand-gold font-mono text-sm mt-1">
          <Flame size={14} />
          {result.winStreak} ধারাবাহিক জয়
        </div>
      )}

      {/* Provably Fair সিড */}
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
    </div>
  );
}
