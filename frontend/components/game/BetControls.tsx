'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  BET CONTROLS — Stake-style বেটিং কন্ট্রোল প্যানেল
 * ═══════════════════════════════════════════════════════════════
 *
 *  ইউজার এখান থেকে:
 *  ① Heads বা Tails বেছে নেবে
 *  ② বেটের পরিমাণ লিখবে বা প্রিসেট বাটন ব্যবহার করবে
 *  ③ মাল্টিপ্লায়ার সেট করবে (1.01×–1000×)
 *  ④ Manual বা Auto মোড বেছে নিয়ে FLIP / Start Auto বাটন চাপবে
 *
 *  Modes (Phase 1.4 P0):
 *    - Manual → একটি বেট, ব্যবহারকারী নিজে পরের বেট দেয়
 *    - Auto   → N সংখ্যক বেট স্বয়ংক্রিয়ভাবে, প্রতিটি রেজাল্টের পর
 *               পরেরটি প্লেস হয় (3s স্পিন + 0.5s পজ)।
 *               Stop conditions:
 *                 - Take profit: single win ≥ threshold → stop
 *                 - Stop loss:   balance dropped ≥ threshold → stop
 *                 - Manual stop button: anytime
 *               Optional per-round bet adjustment:
 *                 - On win:  reset to base | increase by X%
 *                 - On loss: reset to base | increase by X%
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Lock, RotateCw, Coins, Play, Square } from 'lucide-react';
import { useGameStore, BetResult } from '@/lib/store';
import { getSocket } from '@/lib/socket';
import { Slider } from '@/design-system/components/Slider';
import { Progress } from '@/design-system/components/Progress';
import { Tabs, type TabItem } from '@/design-system/components/Tabs';

// দ্রুত বেট পরিমাণ বেছে নেওয়ার প্রিসেট
const BET_PRESETS = [0.10, 0.50, 1.00, 5.00, 10.00, 50.00];

// মাল্টিপ্লায়ারের সীমা (backend routes/game.ts-এ enforce হয়)
const MULTIPLIER_MIN = 1.01;
const MULTIPLIER_MAX = 1000;

// Auto-mode স্পিন সিকোয়েন্স: 3s স্পিন (server) + 0.5s পজ (UI)
// কম হলে ইউজার রেজাল্ট দেখার আগেই পরের বেট চলে যায়।
const POST_RESULT_DELAY_MS = 500;

// Backend base URL for the public config fetch (no JWT needed)
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// ── Auto-mode option types ─────────────────────────────────────
type Mode = 'manual' | 'auto';
type ResetStrategy = 'reset' | 'increase';
type StopError = string | null;

interface AutoConfig {
  numberOfBets: number;          // 0 = infinite (until stopped)
  stopOnProfitUsd: number;       // 0 = disabled
  stopOnLossUsd: number;         // 0 = disabled
  onWin: ResetStrategy;
  onWinIncreasePct: number;      // used when onWin === 'increase'
  onLoss: ResetStrategy;
  onLossIncreasePct: number;     // used when onLoss === 'increase'
}

const DEFAULT_AUTO_CONFIG: AutoConfig = {
  numberOfBets: 10,
  stopOnProfitUsd: 0,
  stopOnLossUsd: 0,
  onWin: 'reset',
  onWinIncreasePct: 0,
  onLoss: 'reset',
  onLossIncreasePct: 100,        // martingale default
};

// ── Helper: compute next bet amount based on last result + config ──
function computeNextBet(
  baseBet: number,
  lastResult: BetResult | null,
  cfg: AutoConfig,
): number {
  if (!lastResult) return baseBet;
  const strategy = lastResult.won ? cfg.onWin : cfg.onLoss;
  const pct = lastResult.won ? cfg.onWinIncreasePct : cfg.onLossIncreasePct;
  if (strategy === 'reset') return baseBet;
  // increase: nextBet = baseBet * (1 + pct/100)
  return Math.max(0.01, baseBet * (1 + pct / 100));
}

export default function BetControls() {
  const {
    user, gameStatus, currentChoice, betAmount, multiplier, houseEdgePercent,
    setCurrentChoice, setBetAmount, setMultiplier, setHouseEdgePercent, setGameStatus,
    lastResult,
  } = useGameStore();

  const [clientSeed, setClientSeed] = useState(() =>
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
  const [showSeed, setShowSeed] = useState(false);

  // ── Mode + Auto state ───────────────────────────────────────
  const [mode, setMode] = useState<Mode>('manual');
  const [autoCfg, setAutoCfg] = useState<AutoConfig>(DEFAULT_AUTO_CONFIG);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoBetsPlaced, setAutoBetsPlaced] = useState(0);
  const [autoStartBalance, setAutoStartBalance] = useState<number | null>(null);
  const [autoError, setAutoError] = useState<StopError>(null);

  // Live bet amount used by Auto mode (may differ from base after increase-on-win/loss).
  // In Manual mode, this equals base `betAmount` from the store.
  const [autoCurrentBet, setAutoCurrentBet] = useState<number>(betAmount);

  // Refs to avoid stale closures inside the auto-loop effect.
  const autoCfgRef = useRef(autoCfg);
  const autoRunningRef = useRef(autoRunning);
  const autoBetsPlacedRef = useRef(autoBetsPlaced);
  const autoCurrentBetRef = useRef(autoCurrentBet);
  const baseBetRef = useRef(betAmount);
  const multiplierRef = useRef(multiplier);
  const choiceRef = useRef(currentChoice);
  const autoStartBalanceRef = useRef<number | null>(autoStartBalance);

  useEffect(() => { autoCfgRef.current = autoCfg; }, [autoCfg]);
  useEffect(() => { autoRunningRef.current = autoRunning; }, [autoRunning]);
  useEffect(() => { autoBetsPlacedRef.current = autoBetsPlaced; }, [autoBetsPlaced]);
  useEffect(() => { autoCurrentBetRef.current = autoCurrentBet; }, [autoCurrentBet]);
  useEffect(() => { baseBetRef.current = betAmount; }, [betAmount]);
  useEffect(() => { multiplierRef.current = multiplier; }, [multiplier]);
  useEffect(() => { choiceRef.current = currentChoice; }, [currentChoice]);
  useEffect(() => { autoStartBalanceRef.current = autoStartBalance; }, [autoStartBalance]);

  // ── Live house edge (Phase 1.4 follow-up) ──────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/admin/config/public`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && typeof body.houseEdgePercent === 'number') {
          setHouseEdgePercent(body.houseEdgePercent);
        }
      } catch {
        // network error — keep store default, don't block UI
      }
    })();
    return () => { cancelled = true; };
  }, [setHouseEdgePercent]);

  const isSpinning = gameStatus === 'spinning';
  const isResult   = gameStatus === 'result';
  const canBet     = user && !isSpinning;

  // ── Win Chance + Payout derivation (mirrors backend services/game-engine.ts) ──
  // winChance = (1/multiplier) × (1 - houseEdge/100), payout = betAmount × multiplier
  const winChancePct = Math.max(0, Math.min(100, (1 / multiplier) * (1 - houseEdgePercent / 100) * 100));
  const payout = betAmount * multiplier;
  // In Auto mode, show derived next-bet for clarity
  const autoNextBet = computeNextBet(betAmount, lastResult, autoCfg);
  const autoNetDelta = autoStartBalance !== null && user
    ? user.balance - autoStartBalance
    : 0;

  // ── Stop Auto if user logs out or loses balance ─────────────
  useEffect(() => {
    if (autoRunning && (!user || user.balance < 0.01)) {
      setAutoRunning(false);
      setAutoError(user ? 'ব্যালেন্স শেষ — Auto বন্ধ।' : 'লগআউট — Auto বন্ধ।');
    }
  }, [user, autoRunning]);

  // ── বেট পাঠাও (Manual mode + Auto mode emit) ─────────────────
  const placeBet = useCallback((amount: number) => {
    const socket = getSocket(undefined);
    socket.emit('game:bet', {
      choice: choiceRef.current,
      amount,
      multiplier: multiplierRef.current,
      clientSeed,
    });
    setGameStatus('spinning');
    // নতুন ক্লায়েন্ট সিড তৈরি করো পরের গেমের জন্য
    setClientSeed(Math.random().toString(36).slice(2) + Date.now().toString(36));
  }, [clientSeed, setGameStatus]);

  const handleFlip = () => {
    if (!canBet || betAmount <= 0) return;
    placeBet(betAmount);
  };

  // ── বেট পরিমাণ হেল্পার ─────────────────────────────────────
  const doubleBet = () => setBetAmount(Math.min(betAmount * 2, user?.balance ?? 0));
  const halfBet   = () => setBetAmount(Math.max(betAmount / 2, 0.01));
  const maxBet    = () => setBetAmount(user?.balance ?? 0);

  // ── Auto mode: start ────────────────────────────────────────
  const startAuto = useCallback(() => {
    if (!user || betAmount <= 0 || betAmount > user.balance) return;
    setAutoError(null);
    setAutoBetsPlaced(0);
    setAutoStartBalance(user.balance);
    setAutoCurrentBet(betAmount);
    autoStartBalanceRef.current = user.balance;
    setAutoRunning(true);
    // Place the first bet immediately
    placeBet(betAmount);
    setAutoBetsPlaced(1);
    autoBetsPlacedRef.current = 1;
  }, [user, betAmount, placeBet]);

  // ── Auto mode: stop ─────────────────────────────────────────
  const stopAuto = useCallback(() => {
    setAutoRunning(false);
  }, []);

  // ── Auto mode: schedule next bet after each result ──────────
  useEffect(() => {
    // Only react when: auto running, last result just arrived (we have a result), and not currently spinning
    if (!autoRunning) return;
    if (!lastResult) return;
    if (gameStatus !== 'result') return;

    // Compute next bet
    const cfg = autoCfgRef.current;
    const next = computeNextBet(baseBetRef.current, lastResult, cfg);

    // Check stop conditions BEFORE scheduling
    const placed = autoBetsPlacedRef.current;
    const total   = cfg.numberOfBets;
    if (total > 0 && placed >= total) {
      setAutoRunning(false);
      return;
    }
    const startBal = autoStartBalanceRef.current;
    const curBal   = user?.balance ?? 0;
    if (cfg.stopOnProfitUsd > 0 && lastResult.won && lastResult.payout >= cfg.stopOnProfitUsd) {
      setAutoRunning(false);
      setAutoError(`Take-profit hit: +$${lastResult.payout.toFixed(2)} ≥ $${cfg.stopOnProfitUsd.toFixed(2)}`);
      return;
    }
    if (cfg.stopOnLossUsd > 0 && startBal !== null && (startBal - curBal) >= cfg.stopOnLossUsd) {
      setAutoRunning(false);
      setAutoError(`Stop-loss hit: -$${(startBal - curBal).toFixed(2)} ≥ $${cfg.stopOnLossUsd.toFixed(2)}`);
      return;
    }
    if (!user || curBal < next) {
      setAutoRunning(false);
      setAutoError('পরবর্তী বেটের জন্য ব্যালেন্স যথেষ্ট নয়।');
      return;
    }

    // Schedule next bet
    setAutoCurrentBet(next);
    const timer = setTimeout(() => {
      // Re-check guard inside the timeout in case user stopped meanwhile
      if (!autoRunningRef.current) return;
      placeBet(next);
      setAutoBetsPlaced((p) => p + 1);
    }, POST_RESULT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [lastResult, gameStatus, autoRunning, placeBet, user]);

  // ── Tab definitions ─────────────────────────────────────────
  const modeTabs: TabItem<Mode>[] = [
    { id: 'manual', label: 'Manual' },
    { id: 'auto',   label: 'Auto' },
  ];

  return (
    <div className="space-y-3 lg:space-y-5">

      {/* ── ① হেডস / টেইলস বাছাই ─────────────────────────── */}
      <div>
        <p className="text-text-muted text-xs font-mono mb-3 uppercase tracking-widest">
          আপনার পছন্দ
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setCurrentChoice('heads')}
            disabled={isSpinning || autoRunning}
            className={`
              relative py-3 lg:py-5 rounded-xl border transition-all duration-150
              flex flex-col items-center gap-1.5 lg:gap-2 font-display font-semibold text-sm
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

          <button
            onClick={() => setCurrentChoice('tails')}
            disabled={isSpinning || autoRunning}
            className={`
              relative py-3 lg:py-5 rounded-xl border transition-all duration-150
              flex flex-col items-center gap-1.5 lg:gap-2 font-display font-semibold text-sm
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
          <p className="text-text-muted text-xs font-mono uppercase tracking-widest">
            {mode === 'auto' ? 'বেস বেট' : 'বেট পরিমাণ'}
          </p>
          {user && (
            <p className="text-text-muted text-xs font-mono">
              ব্যালেন্স: <span className="text-brand-green">${user.balance.toFixed(2)}</span>
            </p>
          )}
        </div>

        <div className="relative mb-2">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted font-mono">$</span>
          <input
            type="number"
            min={0.01}
            max={user?.balance ?? 1000}
            step={0.01}
            value={betAmount}
            onChange={(e) => setBetAmount(Math.max(0.01, parseFloat(e.target.value) || 0))}
            disabled={isSpinning || autoRunning}
            className="input-cyber pl-8 text-right text-lg font-mono disabled:opacity-50"
            aria-label="বেট পরিমাণ"
          />
        </div>

        <div className="flex gap-2 mb-3">
          {[
            { label: '½',   action: halfBet },
            { label: '2×',  action: doubleBet },
            { label: 'MAX', action: maxBet },
          ].map(({ label, action }) => (
            <button
              key={label}
              onClick={action}
              disabled={isSpinning || autoRunning}
              className="flex-1 py-1.5 rounded-lg border border-border text-text-muted
                         text-xs font-mono hover:border-brand-green/50 hover:text-brand-green
                         transition-all duration-150 disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-1.5 lg:gap-2">
          {BET_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => setBetAmount(preset)}
              disabled={isSpinning || autoRunning || (user ? preset > user.balance : false)}
              className={`
                py-1 lg:py-1.5 rounded-lg text-xs font-mono border transition-all duration-150
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

        {/* Auto-mode next bet preview */}
        {mode === 'auto' && lastResult && (
          <div className="mt-2 px-2.5 py-1.5 rounded-md bg-void border border-border text-xs font-mono flex justify-between">
            <span className="text-text-muted">পরবর্তী বেট:</span>
            <span className="text-brand-gold">${autoNextBet.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* ── ③ মাল্টিপ্লায়ার স্লাইডার (Phase 1.4 — Stake-style) ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-text-muted text-xs font-mono uppercase tracking-widest">
            মাল্টিপ্লায়ার
          </p>
          <p className="text-text-muted text-xs font-mono">
            পেআউট: <span className="text-brand-gold">${payout.toFixed(2)}</span>
          </p>
        </div>

        <Slider
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.01}
          value={multiplier}
          onChange={(v) => setMultiplier(Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, v)))}
          disabled={isSpinning || autoRunning}
          color="brand"
          showValue
          formatValue={(v) => `${v.toFixed(2)}×`}
        />

        <div className="grid grid-cols-2 gap-2 mt-3 text-xs font-mono">
          <div className="px-2.5 py-1.5 rounded-md bg-void border border-border flex flex-col">
            <span className="text-text-muted text-[10px] uppercase tracking-wider">
              জেতার সম্ভাবনা
            </span>
            <span className="text-brand-green tabular-nums">
              {winChancePct.toFixed(2)}%
            </span>
          </div>
          <div className="px-2.5 py-1.5 rounded-md bg-void border border-border flex flex-col">
            <span className="text-text-muted text-[10px] uppercase tracking-wider">
              হাউজ এজ
            </span>
            <span className="text-brand-maroon tabular-nums">
              {houseEdgePercent.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="mt-2">
          <Progress
            value={multiplier}
            max={MULTIPLIER_MAX}
            variant="linear"
            color="auto"
            className="opacity-60"
          />
        </div>
      </div>

      {/* ── ④ Mode tabs (Manual / Auto) — Phase 1.4 P0 ─────── */}
      <div>
        <Tabs<Mode>
          items={modeTabs}
          value={mode}
          onChange={(id) => {
            if (autoRunning) return; // don't allow mode switch mid-auto
            setMode(id);
          }}
          variant="button"
          size="md"
          fullWidth
          ariaLabel="বেটিং মোড"
        />
      </div>

      {/* ── ④b Auto config panel (visible only in Auto mode) ── */}
      {mode === 'auto' && (
        <AutoPanel
          cfg={autoCfg}
          onChange={setAutoCfg}
          disabled={autoRunning}
          defaultCfg={DEFAULT_AUTO_CONFIG}
        />
      )}

      {/* ── ⑤ FLIP / Start Auto / Stop Auto বাটন ─────────────── */}
      {/*
        On mobile, the manual FLIP button is duplicated as a sticky bar
        (MobileBetBar component on the page) so users never have to
        scroll past the coin to tap it. Hide the inline button on
        mobile to avoid two competing controls. Auto mode still shows
        its Start/Stop here because it's opt-in via the mode toggle
        and not a primary action — once running, the user watches the
        coin and doesn't need to re-tap until they want to stop.
      */}
      {mode === 'manual' ? (
        <button
          onClick={handleFlip}
          disabled={!canBet || betAmount <= 0 || (user ? betAmount > user.balance : false)}
          className={`
            hidden lg:flex w-full py-4 rounded-xl font-display font-semibold text-lg tracking-wide
            transition-all duration-150 relative overflow-hidden items-center justify-center gap-2
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
      ) : (
        <button
          onClick={autoRunning ? stopAuto : startAuto}
          disabled={!user || (!autoRunning && (betAmount <= 0 || betAmount > (user.balance ?? 0)))}
          className={`
            w-full py-4 rounded-xl font-display font-semibold text-lg tracking-wide
            transition-all duration-150 relative overflow-hidden flex items-center justify-center gap-2
            disabled:cursor-not-allowed disabled:opacity-40
            ${autoRunning
              ? 'bg-brand-red text-void shadow-brand-red hover:bg-brand-red-dim'
              : isSpinning
                ? 'bg-surface2 text-text-muted cursor-wait border border-border'
                : 'bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5 active:translate-y-0'
            }
          `}
          aria-live="polite"
        >
          {autoRunning ? (
            <>
              <Square size={18} strokeWidth={2.25} fill="currentColor" />
              Stop Auto ({autoBetsPlaced}{autoCfg.numberOfBets > 0 ? `/${autoCfg.numberOfBets}` : ''})
            </>
          ) : isSpinning ? (
            <>
              <span className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
              ঘুরছে...
            </>
          ) : (
            <>
              <Play size={20} strokeWidth={2.25} fill="currentColor" />
              Start Auto Bet
            </>
          )}
        </button>
      )}

      {/* Auto-mode status panel (visible only while running or after stop) */}
      {mode === 'auto' && (autoRunning || autoError || autoBetsPlaced > 0) && (
        <div className="px-3 py-2 rounded-lg bg-void border border-border text-xs font-mono space-y-1">
          <div className="flex justify-between">
            <span className="text-text-muted">বেট:</span>
            <span>{autoBetsPlaced}{autoCfg.numberOfBets > 0 ? ` / ${autoCfg.numberOfBets}` : ' (∞)'}</span>
          </div>
          {autoStartBalance !== null && (
            <div className="flex justify-between">
              <span className="text-text-muted">Net P&L:</span>
              <span className={autoNetDelta >= 0 ? 'text-brand-green' : 'text-brand-red'}>
                {autoNetDelta >= 0 ? '+' : ''}${autoNetDelta.toFixed(2)}
              </span>
            </div>
          )}
          {autoError && (
            <div className="text-brand-red">⚠️ {autoError}</div>
          )}
        </div>
      )}

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

// ═══════════════════════════════════════════════════════════════
//  AutoPanel — sub-component for Auto mode configuration
// ═══════════════════════════════════════════════════════════════

interface AutoPanelProps {
  cfg: AutoConfig;
  onChange: (cfg: AutoConfig) => void;
  disabled: boolean;
  defaultCfg: AutoConfig;
}

function AutoPanel({ cfg, onChange, disabled, defaultCfg }: AutoPanelProps) {
  const update = <K extends keyof AutoConfig>(key: K, value: AutoConfig[K]) =>
    onChange({ ...cfg, [key]: value });

  return (
    <div className="space-y-3 p-3 rounded-lg bg-surface2 border border-border">
      <div className="flex items-center justify-between">
        <p className="text-text-muted text-xs font-mono uppercase tracking-widest">
          Auto সেটিংস
        </p>
        <button
          type="button"
          onClick={() => onChange(defaultCfg)}
          disabled={disabled}
          className="text-text-tertiary hover:text-text-primary text-[10px] font-mono disabled:opacity-30"
        >
          রিসেট
        </button>
      </div>

      {/* Number of bets */}
      <div>
        <label className="block text-xs font-mono text-text-secondary mb-1">
          বেট সংখ্যা <span className="text-text-muted">(0 = অসীম)</span>
        </label>
        <input
          type="number"
          min={0}
          max={10000}
          step={1}
          value={cfg.numberOfBets}
          onChange={(e) => update('numberOfBets', Math.max(0, parseInt(e.target.value || '0', 10)))}
          disabled={disabled}
          className="input-cyber w-full text-sm font-mono"
        />
      </div>

      {/* Stop conditions */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-mono text-text-secondary mb-1">
            Take profit ($)
          </label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={cfg.stopOnProfitUsd}
            onChange={(e) => update('stopOnProfitUsd', Math.max(0, parseFloat(e.target.value || '0')))}
            disabled={disabled}
            placeholder="0 = off"
            className="input-cyber w-full text-sm font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-mono text-text-secondary mb-1">
            Stop loss ($)
          </label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={cfg.stopOnLossUsd}
            onChange={(e) => update('stopOnLossUsd', Math.max(0, parseFloat(e.target.value || '0')))}
            disabled={disabled}
            placeholder="0 = off"
            className="input-cyber w-full text-sm font-mono"
          />
        </div>
      </div>

      {/* On-win strategy */}
      <div>
        <label className="block text-xs font-mono text-text-secondary mb-1">
          জিতলে
        </label>
        <div className="flex gap-2">
          <StrategyButton
            active={cfg.onWin === 'reset'}
            disabled={disabled}
            onClick={() => update('onWin', 'reset')}
            label="রিসেট"
          />
          <StrategyButton
            active={cfg.onWin === 'increase'}
            disabled={disabled}
            onClick={() => update('onWin', 'increase')}
            label="বাড়াও"
          />
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            value={cfg.onWinIncreasePct}
            onChange={(e) => update('onWinIncreasePct', Math.max(0, parseFloat(e.target.value || '0')))}
            disabled={disabled || cfg.onWin !== 'increase'}
            placeholder="%"
            className="input-cyber flex-1 text-sm font-mono"
          />
        </div>
      </div>

      {/* On-loss strategy */}
      <div>
        <label className="block text-xs font-mono text-text-secondary mb-1">
          হারলে
        </label>
        <div className="flex gap-2">
          <StrategyButton
            active={cfg.onLoss === 'reset'}
            disabled={disabled}
            onClick={() => update('onLoss', 'reset')}
            label="রিসেট"
          />
          <StrategyButton
            active={cfg.onLoss === 'increase'}
            disabled={disabled}
            onClick={() => update('onLoss', 'increase')}
            label="বাড়াও"
          />
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            value={cfg.onLossIncreasePct}
            onChange={(e) => update('onLossIncreasePct', Math.max(0, parseFloat(e.target.value || '0')))}
            disabled={disabled || cfg.onLoss !== 'increase'}
            placeholder="%"
            className="input-cyber flex-1 text-sm font-mono"
          />
        </div>
      </div>
    </div>
  );
}

// ── Helper: strategy button ────────────────────────────────────
interface StrategyButtonProps {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}
function StrategyButton({ active, disabled, onClick, label }: StrategyButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        flex-1 py-1.5 rounded-md text-xs font-mono border transition-all duration-150
        disabled:opacity-30 disabled:cursor-not-allowed
        ${active
          ? 'border-brand-green text-brand-green bg-brand-green/10'
          : 'border-border text-text-muted hover:border-brand-green/40'
        }
      `}
    >
      {label}
    </button>
  );
}