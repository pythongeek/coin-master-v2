'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  LIVE STATS — Sidebar panel: streak indicator + recent bets
 * ═══════════════════════════════════════════════════════════════
 *
 *  v2 upgrade over 1.4 basic version:
 *    1.6.1 — Hot streak highlight: streak counter glows + animates
 *             when count ≥ 5; "HOT STREAK!" badge appears
 *    1.6.2 — Filter chips: All / Wins / Losses toggle the table
 *    1.6.3 — Pagination: 10 rows per page with prev/next controls
 *
 *  STORAGE NOTE:
 *    Filter + pagination state is local (not persisted). If you want
 *    persistence, lift these to the Zustand store or sync to URL.
 *
 *  USAGE:
 *    <LiveStats />  // self-contained, reads from global store
 *
 *  STYLING:
 *    - Fills parent (height: 100% via flex-1)
 *    - Internal scroll if content exceeds container
 *    - Streak dots use brand coin colors (gold/silver)
 *    - Profit column color-coded green/red
 * ═══════════════════════════════════════════════════════════════
 */

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, TrendingDown, History, Flame, ChevronLeft, ChevronRight } from 'lucide-react';
import { useGameStore, BetResult } from '@/lib/store';
import { easing } from '@/design-system/tokens/animations';

const MAX_STREAK_DOTS = 20;
const PAGE_SIZE = 10;

type FilterMode = 'all' | 'wins' | 'losses';

/**
 * Compute current streak from a chronological bet history.
 * Returns { type: 'heads' | 'tails' | null, count: number }.
 *
 * NOTE: store adds NEW bets to the FRONT of betHistory, so betHistory[0]
 * is the most recent. We iterate from the front backwards until the
 * result type changes.
 */
function computeStreak(history: BetResult[]): { type: 'heads' | 'tails' | null; count: number } {
  if (history.length === 0) return { type: null, count: 0 };
  const latest = history[0];
  let count = 0;
  for (const bet of history) {
    if (bet.result === latest.result) count++;
    else break;
  }
  return { type: latest.result, count };
}

export default function LiveStats() {
  const { betHistory, user } = useGameStore();

  // ── Local UI state ───────────────────────────────────────
  const [filter, setFilter] = useState<FilterMode>('all');
  const [page, setPage] = useState(0);   // 0-indexed

  // ── Derived data ─────────────────────────────────────────
  const streak = useMemo(() => computeStreak(betHistory), [betHistory]);
  const streakDots = useMemo(
    () => betHistory.slice(0, MAX_STREAK_DOTS).reverse(),
    [betHistory],
  );

  // Hot streak: count >= 5 (per game design — ≥5 consecutive same-result
  // bets is the threshold for the Crypto Rain trigger per admin-config)
  const isHotStreak = streak.count >= 5;

  // Apply filter
  const filteredRows = useMemo(() => {
    switch (filter) {
      case 'wins':   return betHistory.filter((b) => b.won);
      case 'losses': return betHistory.filter((b) => !b.won);
      default:       return betHistory;
    }
  }, [betHistory, filter]);

  // Pagination (always reset to page 0 when filter changes or new bet arrives)
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = filteredRows.slice(pageStart, pageStart + PAGE_SIZE);

  // Reset page when filter or betHistory changes
  useMemo(() => {
    setPage(0);
  }, [filter, betHistory.length]);

  // ── Filter counts (for chip badges) ──────────────────────
  const counts = useMemo(() => {
    const wins = betHistory.filter((b) => b.won).length;
    return { all: betHistory.length, wins, losses: betHistory.length - wins };
  }, [betHistory]);

  return (
    <div className="glass-card flex flex-col h-full overflow-hidden">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-text-primary font-display font-semibold text-sm flex items-center gap-2">
          <History size={14} className="text-brand-info" />
          Live Stats
        </h3>
        <span className="text-text-muted text-[10px] font-mono uppercase tracking-wide">
          মোট {betHistory.length}
        </span>
      </div>

      {/* ── Streak indicator ─────────────────────────────────── */}
      <div
        className={[
          'p-3 m-3 rounded-lg border transition-colors duration-300',
          isHotStreak
            ? 'bg-brand-gold/10 border-brand-gold/40 shadow-brand-gold'
            : 'bg-surface2 border-transparent',
        ].join(' ')}
      >
        <div className="flex justify-between items-center mb-2">
          <span className="text-text-muted text-xs font-mono">Current Streak</span>

          {/* Streak counter — animated when hot */}
          {streak.type ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={`${streak.type}-${streak.count}-${isHotStreak}`}
                initial={{ scale: isHotStreak ? 1.3 : 1, opacity: 0.5 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.3, ease: easing.outExpo }}
                className={[
                  'font-bold font-mono text-sm flex items-center gap-1.5',
                  isHotStreak ? 'text-brand-gold' : 'text-text-secondary',
                ].join(' ')}
              >
                <Flame
                  size={isHotStreak ? 14 : 12}
                  className={isHotStreak ? 'animate-pulse-soft text-brand-gold' : 'text-text-muted'}
                />
                <span>{streak.count}× {streak.type === 'heads' ? 'Heads' : 'Tails'}</span>
              </motion.div>
            </AnimatePresence>
          ) : (
            <span className="text-text-muted text-xs font-mono">—</span>
          )}
        </div>

        {/* Hot streak banner — only when count >= 5 */}
        <AnimatePresence>
          {isHotStreak && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: easing.outExpo }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1 rounded bg-brand-gold/20 border border-brand-gold/30">
                <Flame size={11} className="text-brand-gold" />
                <span className="text-[10px] font-mono uppercase tracking-wide text-brand-gold font-semibold">
                  হট স্ট্রিক! · রেইন আসন্ন
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Streak dots — most recent on the right */}
        <div className="flex gap-1 flex-wrap">
          {streakDots.length === 0 ? (
            <span className="text-text-muted text-[10px] font-mono">No bets yet</span>
          ) : (
            streakDots.map((bet, i) => (
              <div
                key={`${bet.betId}-${i}`}
                title={`${bet.result} — ${bet.betAmount.toFixed(2)} (${bet.won ? 'won' : 'lost'})`}
                className={[
                  'w-3 h-3 rounded-full shrink-0 transition-opacity',
                  bet.result === 'heads' ? 'bg-brand-gold' : 'bg-text-secondary',
                  bet.won ? '' : 'opacity-50',
                  i === streakDots.length - 1 && isHotStreak ? 'ring-1 ring-brand-gold animate-pulse-soft' : '',
                ].join(' ')}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Filter chips ──────────────────────────────────────── */}
      <div className="px-3 pb-2 flex gap-1.5">
        {(['all', 'wins', 'losses'] as FilterMode[]).map((mode) => {
          const isActive = filter === mode;
          const count = counts[mode];
          const label = mode === 'all' ? 'সব' : mode === 'wins' ? 'জয়' : 'পরাজয়';
          const Icon = mode === 'wins' ? TrendingUp : mode === 'losses' ? TrendingDown : History;
          return (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              className={[
                'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-mono transition-all',
                isActive
                  ? mode === 'wins'
                    ? 'bg-brand-green/15 text-brand-green border border-brand-green/35'
                    : mode === 'losses'
                    ? 'bg-brand-red/15 text-brand-red border border-brand-red/35'
                    : 'bg-brand-info/15 text-brand-info border border-brand-info/35'
                  : 'bg-surface2 text-text-muted border border-transparent hover:border-border',
              ].join(' ')}
            >
              <Icon size={10} />
              <span>{label}</span>
              <span className={[
                'px-1 rounded text-[9px] tabular-nums',
                isActive ? 'bg-void/30' : 'bg-void/50',
              ].join(' ')}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Recent bets table (paginated) ─────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {pageRows.length === 0 ? (
            <div className="px-4 py-8 text-center text-text-muted text-xs font-mono">
              {filter === 'all' && 'কোনো Bet ইতিহাস নেই'}
              {filter === 'wins' && 'এখনো কোনো জয় নেই'}
              {filter === 'losses' && 'কোনো পরাজয় নেই (চালিয়ে যান!)'}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-text-muted text-[10px] uppercase tracking-wide sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th className="text-left p-2 font-medium">Player</th>
                  <th className="text-right p-2 font-medium">Bet</th>
                  <th className="text-right p-2 font-medium">Result</th>
                  <th className="text-right p-2 font-medium">P/L</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((bet) => {
                  const profit = bet.payout - bet.betAmount;
                  const isOwnBet = user?.userId === bet.betId || bet.betId.startsWith('own-');
                  return (
                    <tr
                      key={bet.betId}
                      className={[
                        'border-b border-border/50 hover:bg-surface2/50 transition-colors',
                        isOwnBet ? 'bg-brand-info/5' : '',
                      ].join(' ')}
                    >
                      <td className="p-2 text-text-secondary font-mono truncate max-w-[80px]">
                        {isOwnBet ? (
                          <span className="text-brand-info">👤 You</span>
                        ) : bet.choice === bet.result ? (
                          <span>🎯</span>
                        ) : (
                          <span>😢</span>
                        )}
                      </td>
                      <td className="p-2 text-right text-text-primary font-mono tabular-nums">
                        {bet.betAmount.toFixed(2)}
                      </td>
                      <td className="p-2 text-right">
                        <span
                          className={[
                            'inline-flex items-center gap-1 font-mono',
                            bet.result === 'heads' ? 'text-brand-gold' : 'text-text-secondary',
                          ].join(' ')}
                        >
                          {bet.result === 'heads' ? 'হে' : 'টে'}
                        </span>
                      </td>
                      <td className="p-2 text-right font-mono tabular-nums">
                        <span
                          className={[
                            'inline-flex items-center gap-0.5',
                            profit > 0 ? 'text-brand-green' : 'text-brand-red',
                          ].join(' ')}
                        >
                          {profit > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                          {profit > 0 ? '+' : ''}
                          {profit.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination controls (only if multiple pages) ──── */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-surface">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={12} />
              পূর্ব
            </button>

            <span className="text-[10px] font-mono text-text-muted tabular-nums">
              {safePage + 1} / {totalPages}
            </span>

            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              পরবর্তী
              <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>

      {/* ── Footer note ──────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-border text-[10px] text-text-muted text-center font-mono">
        শেষ ৫০টি Bet · {filter === 'all' ? 'সব' : filter === 'wins' ? 'শুধু জয়' : 'শুধু পরাজয়'} · রিয়েল-টাইম
      </div>
    </div>
  );
}