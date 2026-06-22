'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  BET CONTROLS — বেটিং কন্ট্রোল প্যানেল
 * ═══════════════════════════════════════════════════════════════
 *
 *  ইউজার এখান থেকে:
 *  ① Heads বা Tails বেছে নেবে
 *  ② বেটের পরিমাণ লিখবে বা প্রিসেট বাটন ব্যবহার করবে
 *  ③ FLIP বাটন চাপবে
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { Lock, RotateCw, Coins } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { getSocket } from '@/lib/socket';

// দ্রুত বেট পরিমাণ বেছে নেওয়ার প্রিসেট
const BET_PRESETS = [0.10, 0.50, 1.00, 5.00, 10.00, 50.00];

export default function BetControls() {
  const {
    user, gameStatus, currentChoice, betAmount,
    setCurrentChoice, setBetAmount, setGameStatus,
  } = useGameStore();

  const [clientSeed, setClientSeed] = useState(() =>
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
  const [showSeed, setShowSeed] = useState(false);

  const isSpinning = gameStatus === 'spinning';
  const isResult   = gameStatus === 'result';
  const canBet     = user && !isSpinning;

  // ── বেট পাঠাও ──────────────────────────────────────────────
  const handleFlip = () => {
    if (!canBet || betAmount <= 0) return;

    const socket = getSocket(undefined);
    socket.emit('game:bet', {
      choice: currentChoice,
      amount: betAmount,
      clientSeed,
    });

    setGameStatus('spinning');

    // নতুন ক্লায়েন্ট সিড তৈরি করো পরের গেমের জন্য
    setClientSeed(Math.random().toString(36).slice(2) + Date.now().toString(36));
  };

  // ── বেট পরিমাণ হেল্পার ─────────────────────────────────────
  const doubleBet = () => setBetAmount(Math.min(betAmount * 2, user?.balance ?? 0));
  const halfBet   = () => setBetAmount(Math.max(betAmount / 2, 0.01));
  const maxBet    = () => setBetAmount(user?.balance ?? 0);

  return (
    <div className="space-y-5">

      {/* ── ① হেডস / টেইলস বাছাই ─────────────────────────── */}
      <div>
        <p className="text-text-muted text-xs font-mono mb-3 uppercase tracking-widest">
          আপনার পছন্দ
        </p>
        <div className="grid grid-cols-2 gap-3">
          {/* HEADS বাটন */}
          <button
            onClick={() => setCurrentChoice('heads')}
            disabled={isSpinning}
            className={`
              relative py-5 rounded-xl border transition-all duration-150
              flex flex-col items-center gap-2 font-display font-semibold text-sm
              disabled:cursor-not-allowed
              ${currentChoice === 'heads'
                ? 'border-brand-green bg-brand-green/[0.08] text-brand-green shadow-brand-green'
                : 'border-border text-text-secondary hover:border-brand-green/40 hover:-translate-y-0.5'
              }
            `}
            aria-pressed={currentChoice === 'heads'}
          >
            <span className="text-3xl">🪷</span>
            <span>HEADS</span>
            {currentChoice === 'heads' && (
              <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-brand-green" />
            )}
          </button>

          {/* TAILS বাটন */}
          <button
            onClick={() => setCurrentChoice('tails')}
            disabled={isSpinning}
            className={`
              relative py-5 rounded-xl border transition-all duration-150
              flex flex-col items-center gap-2 font-display font-semibold text-sm
              disabled:cursor-not-allowed
              ${currentChoice === 'tails'
                ? 'border-brand-maroon bg-brand-maroon/[0.08] text-brand-maroon shadow-brand-maroon'
                : 'border-border text-text-secondary hover:border-brand-maroon/40 hover:-translate-y-0.5'
              }
            `}
            aria-pressed={currentChoice === 'tails'}
          >
            <span className="text-3xl">🐯</span>
            <span>TAILS</span>
            {currentChoice === 'tails' && (
              <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-brand-maroon" />
            )}
          </button>
        </div>
      </div>

      {/* ── ② বেট পরিমাণ ───────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-text-muted text-xs font-mono uppercase tracking-widest">বেট পরিমাণ</p>
          {user && (
            <p className="text-text-muted text-xs font-mono">
              ব্যালেন্স: <span className="text-brand-green">${user.balance.toFixed(2)}</span>
            </p>
          )}
        </div>

        {/* পরিমাণ ইনপুট */}
        <div className="relative mb-2">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted font-mono">$</span>
          <input
            type="number"
            min={0.01}
            max={user?.balance ?? 1000}
            step={0.01}
            value={betAmount}
            onChange={(e) => setBetAmount(Math.max(0.01, parseFloat(e.target.value) || 0))}
            disabled={isSpinning}
            className="input-cyber pl-8 text-right text-lg font-mono disabled:opacity-50"
            aria-label="বেট পরিমাণ"
          />
        </div>

        {/* +/- হেল্পার বাটন */}
        <div className="flex gap-2 mb-3">
          {[
            { label: '½',   action: halfBet },
            { label: '2×',  action: doubleBet },
            { label: 'MAX', action: maxBet },
          ].map(({ label, action }) => (
            <button
              key={label}
              onClick={action}
              disabled={isSpinning}
              className="flex-1 py-1.5 rounded-lg border border-border text-text-muted
                         text-xs font-mono hover:border-brand-green/50 hover:text-brand-green
                         transition-all duration-150 disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>

        {/* প্রিসেট বাটন */}
        <div className="grid grid-cols-3 gap-2">
          {BET_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => setBetAmount(preset)}
              disabled={isSpinning || (user ? preset > user.balance : false)}
              className={`
                py-1.5 rounded-lg text-xs font-mono border transition-all duration-150
                disabled:opacity-30 disabled:cursor-not-allowed
                ${betAmount === preset
                  ? 'border-brand-green text-brand-green bg-brand-green/10'
                  : 'border-border text-text-muted hover:border-brand-green/40'
                }
              `}
            >
              ${preset.toFixed(2)}
            </button>
          ))}
        </div>
      </div>

      {/* ── ③ FLIP বাটন ─────────────────────────────────────── */}
      <button
        onClick={handleFlip}
        disabled={!canBet || betAmount <= 0 || (user ? betAmount > user.balance : false)}
        className={`
          w-full py-4 rounded-xl font-display font-semibold text-lg tracking-wide
          transition-all duration-150 relative overflow-hidden flex items-center justify-center gap-2
          disabled:cursor-not-allowed disabled:opacity-40
          ${isSpinning
            ? 'bg-surface2 text-text-muted cursor-wait border border-border'
            : 'bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5 active:translate-y-0'
          }
        `}
        style={!isSpinning ? { backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 55%)' } : undefined}
        aria-live="polite"
      >
        {isSpinning ? (
          <>
            <span className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
            ঘুরছে...
          </>
        ) : isResult ? (
          <>
            <RotateCw size={20} strokeWidth={2.25} />
            আবার খেলুন
          </>
        ) : (
          <>
            <Coins size={20} strokeWidth={2.25} />
            FLIP
          </>
        )}
      </button>

      {/* ── ক্লায়েন্ট সিড সেটিং ────────────────────────────── */}
      <div>
        <button
          onClick={() => setShowSeed(!showSeed)}
          className="flex items-center gap-1.5 text-text-muted text-xs font-mono hover:text-text-secondary transition-colors"
        >
          <Lock size={12} />
          {showSeed ? 'সিড লুকান' : 'ক্লায়েন্ট সিড পরিবর্তন করুন'}
        </button>

        {showSeed && (
          <div className="mt-2 space-y-1">
            <input
              className="input-cyber text-xs"
              value={clientSeed}
              onChange={(e) => setClientSeed(e.target.value)}
              placeholder="আপনার কাস্টম সিড"
              aria-label="ক্লায়েন্ট সিড"
            />
            <p className="text-text-muted text-xs font-mono">
              এই সিড Provably Fair হিসাবের অংশ। পরিবর্তন করলে পরের গেম থেকে কার্যকর হবে।
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
