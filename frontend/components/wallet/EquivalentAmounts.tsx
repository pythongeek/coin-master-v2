'use client';
/**
 * =============================================================
 *  EQUIVALENT AMOUNTS - show USDT + USD + BDT side by side
 * =============================================================
 *  Renders a compact display of a Coin/USDT amount with its
 *  fiat equivalents. Used wherever money is shown (deposit page,
 *  admin withdrawal queue, dashboard widgets, etc).
 *
 *  Props:
 *    amount:       Coin/USDT amount (1:1 peg internally)
 *    rates:        FxRatesResponse.rates
 *    compact:      if true, show only USDT + BDT inline (saves space)
 *    freshLabel:   if true, show rate age (e.g. "5s ago")
 *    rateAgeSec:   rate freshness for the freshLabel
 */

import { Coins, DollarSign, Banknote } from 'lucide-react';

interface Props {
  amount: number;
  rates?: { USDT: number; USD: number; BDT: number } | null;
  compact?: boolean;
  freshLabel?: boolean;
  rateAgeSec?: number;
}

function freshBadge(ageSec: number): { label: string; tone: string } {
  if (ageSec === null || ageSec === undefined) {
    return { label: 'fallback rate', tone: 'text-text-muted' };
  }
  if (ageSec < 60) return { label: `${ageSec}s old`, tone: 'text-brand-green' };
  if (ageSec < 300) return { label: `${Math.floor(ageSec / 60)}m old`, tone: 'text-text-muted' };
  if (ageSec < 900) return { label: `${Math.floor(ageSec / 60)}m old`, tone: 'text-amber-400' };
  return { label: `${Math.floor(ageSec / 60)}m old`, tone: 'text-red-400' };
}

export default function EquivalentAmounts({
  amount,
  rates,
  compact = false,
  freshLabel = false,
  rateAgeSec,
}: Props) {
  const usdt = amount; // 1:1 peg
  const usd = rates ? amount * rates.USD : null;
  const bdt = rates ? amount * rates.BDT : null;

  if (compact) {
    return (
      <span className="inline-flex items-center gap-2 font-mono">
        <span className="text-text-primary font-bold">${usdt.toFixed(2)}</span>
        {bdt !== null && (
          <span className="text-text-muted text-xs">≈ ৳{bdt.toFixed(0)}</span>
        )}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-text-primary font-mono text-lg font-bold">
        <Coins size={16} className="text-amber-400" />
        ${usdt.toFixed(2)} USDT
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        {usd !== null ? (
          <div className="flex items-center gap-1 text-text-secondary">
            <DollarSign size={12} className="text-green-400" />
            <span>${usd.toFixed(2)} USD</span>
          </div>
        ) : (
          <div className="text-text-muted">USD: rate unavailable</div>
        )}
        {bdt !== null ? (
          <div className="flex items-center gap-1 text-text-secondary">
            <Banknote size={12} className="text-emerald-400" />
            <span>৳{bdt.toFixed(2)} BDT</span>
          </div>
        ) : (
          <div className="text-text-muted">BDT: rate unavailable</div>
        )}
      </div>
      {freshLabel && rateAgeSec !== undefined && (
        <div className={`text-[10px] font-mono ${freshBadge(rateAgeSec).tone}`}>
          Rate: {freshBadge(rateAgeSec).label}
        </div>
      )}
    </div>
  );
}
