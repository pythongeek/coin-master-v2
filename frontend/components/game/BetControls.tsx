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

import { useState, useEffect, useRef } from 'react';
import { Lock, RotateCw, Coins, Play, Square } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { emitSocket } from '@/lib/socket';
import { trackEvent } from '@/utils/analytics';
import { useTranslation } from '@/hooks/useTranslation';

// দ্রুত বেট পরিমাণ বেছে নেওয়ার প্রিসেট
const BET_PRESETS = [0.10, 0.50, 1.00, 5.00, 10.00, 50.00];

export default function BetControls() {
  const { t } = useTranslation();
  const {
    user, gameStatus, currentChoice, betAmount,
    setCurrentChoice, setBetAmount, setGameStatus,
    isAutoPlayRunning, setIsAutoPlayRunning,
    targetMultiplier, setTargetMultiplier,
  } = useGameStore();

  const [clientSeed, setClientSeed] = useState(() =>
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
  const [showSeed, setShowSeed] = useState(false);

  const isSpinning = gameStatus === 'spinning';
  const isResult   = gameStatus === 'result';
  const canBet     = user && !isSpinning && !isAutoPlayRunning;

  // Tabs
  const [activeTab, setActiveTab] = useState<'manual' | 'auto'>('manual');

  // Linked inputs (multiplier and win chance)
  const [multiplierInput, setMultiplierInput] = useState('2.00');
  const [winChanceInput, setWinChanceInput] = useState('49.0000');

  // Autoplay config states
  const [totalBetsInput, setTotalBetsInput] = useState('10');
  const [isInfiniteBets, setIsInfiniteBets] = useState(false);
  const [onWinAction, setOnWinAction] = useState<'reset' | 'increase'>('reset');
  const [onWinIncreasePercent, setOnWinIncreasePercent] = useState('100');
  const [onLossAction, setOnLossAction] = useState<'reset' | 'increase'>('reset');
  const [onLossIncreasePercent, setOnLossIncreasePercent] = useState('100');

  // Stop conditions states
  const [stopOnProfitEnabled, setStopOnProfitEnabled] = useState(false);
  const [stopOnProfitAmount, setStopOnProfitAmount] = useState('');
  const [stopOnLossEnabled, setStopOnLossEnabled] = useState(false);
  const [stopOnLossAmount, setStopOnLossAmount] = useState('');
  const [stopOnSingleWinEnabled, setStopOnSingleWinEnabled] = useState(false);
  const [stopOnSingleWinAmount, setStopOnSingleWinAmount] = useState('');

  // Strategy Presets
  const [strategyPreset, setStrategyPreset] = useState<'none' | 'martingale' | 'anti_martingale' | 'dalembert'>('none');

  // Autoplay statistics
  const [betsPlayedCount, setBetsPlayedCount] = useState(0);

  // Runtime tracking refs
  const initialBalanceRef = useRef<number>(0);
  const currentBetAmountRef = useRef<number>(0);
  const betsPlayedRef = useRef<number>(0);
  const betsRemainingRef = useRef<number>(0);
  const isAutoPlayRunningRef = useRef<boolean>(false);
  const nextBetTimeoutRef = useRef<any>(null);

  // Sync inputs with targetMultiplier store changes if updated outside
  useEffect(() => {
    if (!isAutoPlayRunningRef.current) {
      setMultiplierInput(targetMultiplier.toFixed(2));
      setWinChanceInput(((100 - 2.0) / targetMultiplier).toFixed(4));
    }
  }, [targetMultiplier]);

  const handleMultiplierChange = (valStr: string) => {
    setMultiplierInput(valStr);
    const parsed = parseFloat(valStr);
    if (!isNaN(parsed) && parsed >= 1.01 && parsed <= 1027604.48) {
      setTargetMultiplier(parsed);
      const calculatedChance = (100 - 2.0) / parsed;
      setWinChanceInput(calculatedChance.toFixed(4));
    }
  };

  const handleWinChanceChange = (valStr: string) => {
    setWinChanceInput(valStr);
    const parsed = parseFloat(valStr);
    if (!isNaN(parsed) && parsed >= 0.000095 && parsed <= 97.0297) {
      const calculatedMultiplier = (100 - 2.0) / parsed;
      setMultiplierInput(calculatedMultiplier.toFixed(2));
      setTargetMultiplier(calculatedMultiplier);
    }
  };

  const handleMultiplierBlur = () => {
    let parsed = parseFloat(multiplierInput) || 2.0;
    if (parsed < 1.01) parsed = 1.01;
    if (parsed > 1027604.48) parsed = 1027604.48;
    setMultiplierInput(parsed.toFixed(2));
    setTargetMultiplier(parsed);
    setWinChanceInput(((100 - 2.0) / parsed).toFixed(4));
  };

  const handleWinChanceBlur = () => {
    let parsed = parseFloat(winChanceInput) || 49.0;
    if (parsed < 0.000095) parsed = 0.000095;
    if (parsed > 97.0297) parsed = 97.0297;
    setWinChanceInput(parsed.toFixed(4));
    const calculatedMultiplier = (100 - 2.0) / parsed;
    setMultiplierInput(calculatedMultiplier.toFixed(2));
    setTargetMultiplier(calculatedMultiplier);
  };

  // ── বেট পাঠাও ──────────────────────────────────────────────
  const handleFlip = () => {
    if (!canBet || betAmount <= 0) return;

    emitSocket('game:bet', {
      choice: currentChoice,
      amount: betAmount,
      clientSeed,
      targetMultiplier: parseFloat(multiplierInput) || 2.0,
    });

    trackEvent('bet_placed', {
      mode: 'manual',
      choice: currentChoice,
      amount: betAmount,
      targetMultiplier: parseFloat(multiplierInput) || 2.0,
    });

    setGameStatus('spinning');

    // নতুন ক্লায়েন্ট সিড তৈরি করো পরের গেমের জন্য
    setClientSeed(Math.random().toString(36).slice(2) + Date.now().toString(36));
  };

  // ── অটো-প্লে লজিক ───────────────────────────────────────────
  const stopAutoPlay = (reason?: string) => {
    isAutoPlayRunningRef.current = false;
    setIsAutoPlayRunning(false);
    if (nextBetTimeoutRef.current) {
      clearTimeout(nextBetTimeoutRef.current);
      nextBetTimeoutRef.current = null;
    }

    trackEvent('autoplay_stop', {
      reason,
      betsPlayedCount: betsPlayedRef.current,
    });

    if (reason) {
      useGameStore.getState().addNotification(`${t('autoplayStopped')}: ${reason}`, 'info');
    }
  };

  const executeAutoplayBet = (amount: number) => {
    if (!user) return;
    if (user.balance < amount) {
      stopAutoPlay(t('insufficientBalance'));
      return;
    }

    emitSocket('game:bet', {
      choice: currentChoice,
      amount: amount,
      clientSeed,
      targetMultiplier: parseFloat(multiplierInput) || 2.0,
    });

    trackEvent('bet_placed', {
      mode: 'auto',
      choice: currentChoice,
      amount: amount,
      targetMultiplier: parseFloat(multiplierInput) || 2.0,
    });

    setGameStatus('spinning');
    setClientSeed(Math.random().toString(36).slice(2) + Date.now().toString(36));
  };

  const startAutoPlay = () => {
    if (!user) return;
    if (betAmount <= 0) return;
    if (betAmount > user.balance) {
      useGameStore.getState().addNotification(`❌ ${t('insufficientBalance')}`, 'info');
      trackEvent('autoplay_start_failed', { reason: 'insufficient_balance', betAmount });
      return;
    }

    const betsCount = isInfiniteBets ? Infinity : (parseInt(totalBetsInput) || 10);
    if (betsCount <= 0) return;

    trackEvent('autoplay_start', {
      betAmount,
      targetMultiplier: parseFloat(multiplierInput) || 2.0,
      totalBets: isInfiniteBets ? 'infinite' : betsCount,
    });

    initialBalanceRef.current = user.balance;
    currentBetAmountRef.current = betAmount;
    betsPlayedRef.current = 0;
    setBetsPlayedCount(0);
    betsRemainingRef.current = betsCount;
    isAutoPlayRunningRef.current = true;
    setIsAutoPlayRunning(true);

    executeAutoplayBet(betAmount);
  };

  const handleMainButtonClick = () => {
    if (activeTab === 'manual') {
      handleFlip();
    } else {
      if (isAutoPlayRunning) {
        stopAutoPlay();
      } else {
        startAutoPlay();
      }
    }
  };

  // রেজাল্ট হ্যান্ডলার (অটো-প্লে লুপ)
  const lastResult = useGameStore((state) => state.lastResult);

  useEffect(() => {
    if (!isAutoPlayRunning || !lastResult) return;

    // ১ বার খেলেছি
    if (!isInfiniteBets) {
      betsRemainingRef.current = Math.max(0, betsRemainingRef.current - 1);
    }
    betsPlayedRef.current += 1;
    setBetsPlayedCount(betsPlayedRef.current);

    const newBalance = lastResult.newBalance;
    const profit = newBalance - initialBalanceRef.current;

    // স্টপ কন্ডিশনস চেক করো
    let shouldStop = false;
    let stopReason = "";

    if (stopOnProfitEnabled && stopOnProfitAmount) {
      const targetProfit = parseFloat(stopOnProfitAmount);
      if (!isNaN(targetProfit) && profit >= targetProfit) {
        shouldStop = true;
        stopReason = `লাভের লক্ষ্যমাত্রা ($${targetProfit.toFixed(2)}) অর্জিত হয়েছে!`;
      }
    }

    if (stopOnLossEnabled && stopOnLossAmount) {
      const maxLoss = parseFloat(stopOnLossAmount);
      if (!isNaN(maxLoss) && (-profit) >= maxLoss) {
        shouldStop = true;
        stopReason = `ক্ষতির সীমা ($${maxLoss.toFixed(2)}) অর্জিত হয়েছে!`;
      }
    }

    if (stopOnSingleWinEnabled && stopOnSingleWinAmount) {
      const singleWinLimit = parseFloat(stopOnSingleWinAmount);
      if (!isNaN(singleWinLimit) && lastResult.payout >= singleWinLimit) {
        shouldStop = true;
        stopReason = `একক জয়ের সীমা ($${singleWinLimit.toFixed(2)}) অর্জিত হয়েছে!`;
      }
    }

    if (!isInfiniteBets && betsRemainingRef.current <= 0) {
      shouldStop = true;
      stopReason = "বেট সংখ্যা পূর্ণ হয়েছে!";
    }

    if (shouldStop) {
      stopAutoPlay(stopReason);
      return;
    }

    // পরবর্তী বেট পরিমাণ নির্ধারণ করো
    let nextBetAmount = currentBetAmountRef.current;
    
    if (strategyPreset === 'martingale') {
      if (lastResult.won) {
        nextBetAmount = betAmount; // রিসেট
      } else {
        nextBetAmount = currentBetAmountRef.current * 2; // দ্বিগুণ
      }
    } else if (strategyPreset === 'anti_martingale') {
      if (lastResult.won) {
        nextBetAmount = currentBetAmountRef.current * 2; // দ্বিগুণ
      } else {
        nextBetAmount = betAmount; // রিসেট
      }
    } else if (strategyPreset === 'dalembert') {
      if (lastResult.won) {
        nextBetAmount = Math.max(betAmount, currentBetAmountRef.current - betAmount);
      } else {
        nextBetAmount = currentBetAmountRef.current + betAmount;
      }
    } else {
      // None / Manual
      if (lastResult.won) {
        if (onWinAction === 'increase') {
          const pct = parseFloat(onWinIncreasePercent) || 0;
          nextBetAmount = nextBetAmount * (1 + pct / 100);
        } else {
          nextBetAmount = betAmount; // রিসেট
        }
      } else {
        if (onLossAction === 'increase') {
          const pct = parseFloat(onLossIncreasePercent) || 0;
          nextBetAmount = nextBetAmount * (1 + pct / 100);
        } else {
          nextBetAmount = betAmount; // রিসেট
        }
      }
    }

    nextBetAmount = parseFloat(nextBetAmount.toFixed(2));

    // ব্যালেন্স চেক
    if (nextBetAmount > newBalance) {
      nextBetAmount = newBalance;
    }

    if (nextBetAmount < 0.01) {
      stopAutoPlay("পরবর্তী বেট পরিমাণ সর্বনিম্ন সীমার নিচে!");
      return;
    }

    currentBetAmountRef.current = nextBetAmount;

    // ১.৫ সেকেন্ড বিরতি দিয়ে পরবর্তী বেট পাঠাও (স্পিনিং অ্যানিমেশন দেখতে সুবিধা হবে)
    nextBetTimeoutRef.current = setTimeout(() => {
      if (isAutoPlayRunningRef.current) {
        executeAutoplayBet(nextBetAmount);
      }
    }, 1500);

  }, [lastResult, isAutoPlayRunning]);

  // এরর আসলে অটো-প্লে থামিয়ে দাও
  useEffect(() => {
    if (isAutoPlayRunning && gameStatus === 'idle') {
      stopAutoPlay();
    }
  }, [gameStatus, isAutoPlayRunning]);

  // ক্লিনআপ
  useEffect(() => {
    return () => {
      if (nextBetTimeoutRef.current) clearTimeout(nextBetTimeoutRef.current);
    };
  }, []);

  // ── বেট পরিমাণ হেল্পার ─────────────────────────────────────
  const doubleBet = () => setBetAmount(Math.min(betAmount * 2, user?.balance ?? 0));
  const halfBet   = () => setBetAmount(Math.max(betAmount / 2, 0.01));
  const maxBet    = () => setBetAmount(user?.balance ?? 0);

  return (
    <div className="space-y-5">
      {/* ── ম্যানুয়াল / অটো ট্যাব ── */}
      <div className="flex bg-surface2 rounded-xl p-1 border border-border">
        <button
          onClick={() => {
            if (isAutoPlayRunning) return;
            setActiveTab('manual');
          }}
          disabled={isAutoPlayRunning}
          className={`flex-1 py-2 rounded-lg text-xs font-display font-semibold transition-all duration-150
            ${activeTab === 'manual'
              ? 'bg-surface border border-border text-brand-green shadow-elevate-sm'
              : 'text-text-secondary hover:text-text-primary'
            }
            disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {t('manual')}
        </button>
        <button
          onClick={() => {
            if (isAutoPlayRunning) return;
            setActiveTab('auto');
          }}
          disabled={isAutoPlayRunning}
          className={`flex-1 py-2 rounded-lg text-xs font-display font-semibold transition-all duration-150
            ${activeTab === 'auto'
              ? 'bg-surface border border-border text-brand-green shadow-elevate-sm'
              : 'text-text-secondary hover:text-text-primary'
            }
            disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {t('auto')}
        </button>
      </div>

      {/* ── ① হেডস / টেইলস বাছাই ─────────────────────────── */}
      <div>
        <p className="text-text-muted text-xs font-mono mb-3 uppercase tracking-widest">
          {t('yourChoice')}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {/* HEADS বাটন */}
          <button
            onClick={() => setCurrentChoice('heads')}
            disabled={isSpinning || isAutoPlayRunning}
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
            <span>{t('heads')}</span>
            {currentChoice === 'heads' && (
              <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-brand-green" />
            )}
          </button>

          {/* TAILS বাটন */}
          <button
            onClick={() => setCurrentChoice('tails')}
            disabled={isSpinning || isAutoPlayRunning}
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
            <span>{t('tails')}</span>
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
            {t('betAmount')}
          </p>
          {user && (
            <p className="text-text-muted text-xs font-mono">
              {t('balance')}: <span className="text-brand-green">${user.balance.toFixed(2)}</span>
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
            disabled={isSpinning || isAutoPlayRunning}
            className="input-cyber pl-8 text-right text-lg font-mono disabled:opacity-50"
            aria-label={t('betAmount')}
          />
        </div>

        {/* +/- হেল্পার বাটন */}
        <div className="flex gap-2 mb-3">
          {[
            { label: t('presetHalf'),   action: halfBet },
            { label: t('presetDouble'),  action: doubleBet },
            { label: t('presetMax'), action: maxBet },
          ].map(({ label, action }) => (
            <button
              key={label}
              onClick={action}
              disabled={isSpinning || isAutoPlayRunning}
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
              disabled={isSpinning || isAutoPlayRunning || (user ? preset > user.balance : false)}
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

      {/* ── ③ টার্গেট মাল্টিপ্লায়ার ও জয়ের সম্ভাবনা ── */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div>
          <label className="text-text-muted text-xs font-mono mb-2 uppercase block tracking-widest">{t('multiplier')}</label>
          <div className="relative">
            <input
              type="text"
              value={multiplierInput}
              onChange={(e) => handleMultiplierChange(e.target.value)}
              onBlur={handleMultiplierBlur}
              disabled={isSpinning || isAutoPlayRunning}
              className="input-cyber text-right pr-7 font-mono text-sm disabled:opacity-50"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted font-mono text-xs">×</span>
          </div>
        </div>
        <div>
          <label className="text-text-muted text-xs font-mono mb-2 uppercase block tracking-widest">{t('winChance')}</label>
          <div className="relative">
            <input
              type="text"
              value={winChanceInput}
              onChange={(e) => handleWinChanceChange(e.target.value)}
              onBlur={handleWinChanceBlur}
              disabled={isSpinning || isAutoPlayRunning}
              className="input-cyber text-right pr-7 font-mono text-sm disabled:opacity-50"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted font-mono text-xs">%</span>
          </div>
        </div>
      </div>

      {/* ── ④ অটো-প্লে কনফিগারেশন প্যানেল (শুধুমাত্র অটো মোডে) ── */}
      {activeTab === 'auto' && (
        <div className="space-y-4 pt-3 border-t border-border animate-lift-in">
          {/* বেট সংখ্যা */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-text-muted text-xs font-mono uppercase tracking-widest">বেট সংখ্যা</p>
              {isInfiniteBets && <span className="text-brand-green text-[10px] font-mono">আনলিমিটেড (∞)</span>}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={isInfiniteBets ? '∞' : totalBetsInput}
                onChange={(e) => {
                  setIsInfiniteBets(false);
                  setTotalBetsInput(e.target.value.replace(/[^0-9]/g, ''));
                }}
                disabled={isAutoPlayRunning}
                className="input-cyber font-mono text-right text-sm flex-1 disabled:opacity-50"
              />
              <div className="flex gap-1">
                {[10, 100].map((num) => (
                  <button
                    key={num}
                    onClick={() => {
                      setIsInfiniteBets(false);
                      setTotalBetsInput(String(num));
                    }}
                    disabled={isAutoPlayRunning}
                    className="px-2.5 py-1.5 bg-surface border border-border text-[11px] font-mono rounded-lg hover:border-brand-green/40 text-text-secondary disabled:opacity-40"
                  >
                    {num}
                  </button>
                ))}
                <button
                  onClick={() => setIsInfiniteBets(true)}
                  disabled={isAutoPlayRunning}
                  className={`px-2.5 py-1.5 border text-[11px] font-mono rounded-lg hover:border-brand-green/40 disabled:opacity-40
                    ${isInfiniteBets ? 'border-brand-green text-brand-green bg-brand-green/10' : 'bg-surface border-border text-text-secondary'}
                  `}
                >
                  ∞
                </button>
              </div>
            </div>
          </div>

          {/* কৌশল প্রিসেট (Strategy Preset) */}
          <div className="space-y-2 mb-3">
            <p className="text-text-muted text-[10px] font-mono uppercase tracking-widest">কৌশল প্রিসেট</p>
            <div className="relative">
              <select
                value={strategyPreset}
                onChange={(e) => setStrategyPreset(e.target.value as any)}
                disabled={isAutoPlayRunning}
                className="input-cyber w-full py-2 px-3 text-xs font-mono appearance-none disabled:opacity-50 border border-border bg-surface"
              >
                <option value="none">ম্যানুয়াল (None)</option>
                <option value="martingale">Martingale</option>
                <option value="anti_martingale">Anti-Martingale</option>
                <option value="dalembert">D'Alembert</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-text-muted">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
              </div>
            </div>
            {strategyPreset === 'martingale' && (
              <p className="text-text-muted text-[10px] font-mono mt-1 leading-tight">
                * হারলে বেট দ্বিগুণ হবে, জিতলে বেস বেটে রিসেট হবে।
              </p>
            )}
            {strategyPreset === 'anti_martingale' && (
              <p className="text-text-muted text-[10px] font-mono mt-1 leading-tight">
                * জিতলে বেট দ্বিগুণ হবে, হারলে বেস বেটে রিসেট হবে।
              </p>
            )}
            {strategyPreset === 'dalembert' && (
              <p className="text-text-muted text-[10px] font-mono mt-1 leading-tight">
                * হারলে বেট এক ইউনিট বাড়বে, জিতলে এক ইউনিট কমবে।
              </p>
            )}
          </div>

          {/* জিতলে / হারলে করণীয় */}
          <div className={`grid grid-cols-2 gap-3 transition-opacity duration-200 ${strategyPreset !== 'none' ? 'opacity-40 pointer-events-none' : ''}`}>
            {/* জিতলে করণীয় */}
            <div className="space-y-2">
              <p className="text-text-muted text-[10px] font-mono uppercase tracking-widest">জিতলে করণীয়</p>
              <div className="flex bg-surface rounded-lg border border-border p-0.5">
                <button
                  onClick={() => setOnWinAction('reset')}
                  disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                  className={`flex-1 py-1 rounded text-[11px] font-semibold font-display transition-all
                    ${onWinAction === 'reset' ? 'bg-surface2 text-brand-green' : 'text-text-secondary'}
                    disabled:opacity-50`}
                >
                  রিসেট
                </button>
                <button
                  onClick={() => setOnWinAction('increase')}
                  disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                  className={`flex-1 py-1 rounded text-[11px] font-semibold font-display transition-all
                    ${onWinAction === 'increase' ? 'bg-surface2 text-brand-green' : 'text-text-secondary'}
                    disabled:opacity-50`}
                >
                  বৃদ্ধি
                </button>
              </div>
              {onWinAction === 'increase' && (
                <div className="relative animate-lift-in">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={onWinIncreasePercent}
                    onChange={(e) => setOnWinIncreasePercent(e.target.value)}
                    disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                    className="input-cyber text-right pr-6 font-mono text-xs disabled:opacity-50 py-1"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted font-mono text-[9px]">%</span>
                </div>
              )}
            </div>

            {/* হারলে করণীয় */}
            <div className="space-y-2">
              <p className="text-text-muted text-[10px] font-mono uppercase tracking-widest">হারলে করণীয়</p>
              <div className="flex bg-surface rounded-lg border border-border p-0.5">
                <button
                  onClick={() => setOnLossAction('reset')}
                  disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                  className={`flex-1 py-1 rounded text-[11px] font-semibold font-display transition-all
                    ${onLossAction === 'reset' ? 'bg-surface2 text-brand-green' : 'text-text-secondary'}
                    disabled:opacity-50`}
                >
                  রিসেট
                </button>
                <button
                  onClick={() => setOnLossAction('increase')}
                  disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                  className={`flex-1 py-1 rounded text-[11px] font-semibold font-display transition-all
                    ${onLossAction === 'increase' ? 'bg-surface2 text-brand-green' : 'text-text-secondary'}
                    disabled:opacity-50`}
                >
                  বৃদ্ধি
                </button>
              </div>
              {onLossAction === 'increase' && (
                <div className="relative animate-lift-in">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={onLossIncreasePercent}
                    onChange={(e) => setOnLossIncreasePercent(e.target.value)}
                    disabled={isAutoPlayRunning || strategyPreset !== 'none'}
                    className="input-cyber text-right pr-6 font-mono text-xs disabled:opacity-50 py-1"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted font-mono text-[9px]">%</span>
                </div>
              )}
            </div>
          </div>

          {/* স্টপ কন্ডিশনস */}
          <div className="space-y-2">
            <p className="text-text-muted text-[10px] font-mono uppercase tracking-widest">স্টপ কন্ডিশনস</p>
            <div className="space-y-2 bg-surface/50 border border-border rounded-xl p-2.5">
              {/* লাভ হলে */}
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={stopOnProfitEnabled}
                    onChange={(e) => setStopOnProfitEnabled(e.target.checked)}
                    disabled={isAutoPlayRunning}
                    className="w-3.5 h-3.5 rounded border-border text-brand-green focus:ring-0 bg-void"
                  />
                  <span className="text-[11px] text-text-secondary font-display">লাভের লক্ষ্যমাত্রা</span>
                </label>
                {stopOnProfitEnabled && (
                  <div className="relative w-24 animate-lift-in">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[9px] font-mono">$</span>
                    <input
                      type="number"
                      placeholder="0.00"
                      value={stopOnProfitAmount}
                      onChange={(e) => setStopOnProfitAmount(e.target.value)}
                      disabled={isAutoPlayRunning}
                      className="input-cyber text-right py-1 text-xs font-mono pr-2.5 pl-5 disabled:opacity-50"
                    />
                  </div>
                )}
              </div>

              {/* ক্ষতি হলে */}
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={stopOnLossEnabled}
                    onChange={(e) => setStopOnLossEnabled(e.target.checked)}
                    disabled={isAutoPlayRunning}
                    className="w-3.5 h-3.5 rounded border-border text-brand-green focus:ring-0 bg-void"
                  />
                  <span className="text-[11px] text-text-secondary font-display">ক্ষতির সর্বোচ্চ সীমা</span>
                </label>
                {stopOnLossEnabled && (
                  <div className="relative w-24 animate-lift-in">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[9px] font-mono">$</span>
                    <input
                      type="number"
                      placeholder="0.00"
                      value={stopOnLossAmount}
                      onChange={(e) => setStopOnLossAmount(e.target.value)}
                      disabled={isAutoPlayRunning}
                      className="input-cyber text-right py-1 text-xs font-mono pr-2.5 pl-5 disabled:opacity-50"
                    />
                  </div>
                )}
              </div>

              {/* একক জয়ের লিমিট */}
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={stopOnSingleWinEnabled}
                    onChange={(e) => setStopOnSingleWinEnabled(e.target.checked)}
                    disabled={isAutoPlayRunning}
                    className="w-3.5 h-3.5 rounded border-border text-brand-green focus:ring-0 bg-void"
                  />
                  <span className="text-[11px] text-text-secondary font-display">{t('singleWin')}</span>
                </label>
                {stopOnSingleWinEnabled && (
                  <div className="relative w-24 animate-lift-in">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[9px] font-mono">$</span>
                    <input
                      type="number"
                      placeholder="0.00"
                      value={stopOnSingleWinAmount}
                      onChange={(e) => setStopOnSingleWinAmount(e.target.value)}
                      disabled={isAutoPlayRunning}
                      className="input-cyber text-right py-1 text-xs font-mono pr-2.5 pl-5 disabled:opacity-50"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ⑤ FLIP / AutoPlay বাটন ─────────────────────────────────────── */}
      <button
        onClick={handleMainButtonClick}
        disabled={
          (!isAutoPlayRunning && (!canBet || betAmount <= 0 || (user ? betAmount > user.balance : false)))
        }
        aria-label={
          isAutoPlayRunning
            ? 'Stop autoplay'
            : isSpinning
            ? 'Coin is spinning'
            : activeTab === 'auto'
            ? 'Start autoplay'
            : `Flip coin for $${betAmount.toFixed(2)} on ${currentChoice}`
        }
        className={`
          w-full py-4 rounded-xl font-display font-semibold text-lg tracking-wide
          transition-all duration-150 relative overflow-hidden flex items-center justify-center gap-2
          disabled:cursor-not-allowed disabled:opacity-40
          ${isAutoPlayRunning
            ? 'bg-brand-red text-void shadow-brand-red hover:bg-brand-red-dim hover:-translate-y-0.5 active:translate-y-0'
            : isSpinning
            ? 'bg-surface2 text-text-muted cursor-wait border border-border'
            : 'bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5 active:translate-y-0'
          }
        `}
        style={!isSpinning ? { backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 55%)' } : undefined}
        aria-live="polite"
      >
        {isAutoPlayRunning ? (
          <>
            <Square size={20} fill="currentColor" strokeWidth={0} />
            {t('stopAutoplay')} ({betsPlayedCount}/{isInfiniteBets ? '∞' : (parseInt(totalBetsInput) || 10)})
          </>
        ) : isSpinning ? (
          <>
            <span className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
            {t('spinning')}
          </>
        ) : isResult ? (
          <>
            <RotateCw size={20} strokeWidth={2.25} />
            {t('flipBtn')}
          </>
        ) : activeTab === 'auto' ? (
          <>
            <Play size={20} fill="currentColor" strokeWidth={0} />
            {t('startAutoplay')}
          </>
        ) : (
          <>
            <Coins size={20} strokeWidth={2.25} />
            {t('flipBtn')}
          </>
        )}
      </button>

      {/* ── ক্লায়েন্ট সিড সেটিং ────────────────────────────── */}
      <div>
        <button
          onClick={() => setShowSeed(!showSeed)}
          disabled={isAutoPlayRunning}
          className="flex items-center gap-1.5 text-text-muted text-xs font-mono hover:text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Lock size={12} />
          {showSeed ? 'সিড লুকান' : 'ক্লায়েন্ট সিড পরিবর্তন করুন'}
        </button>

        {showSeed && (
          <div className="mt-2 space-y-1">
            <input
              className="input-cyber text-xs disabled:opacity-50"
              value={clientSeed}
              onChange={(e) => setClientSeed(e.target.value)}
              placeholder="আপনার কাস্টম সিড"
              disabled={isAutoPlayRunning}
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
