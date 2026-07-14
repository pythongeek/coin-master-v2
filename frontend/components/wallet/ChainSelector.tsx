'use client';
/**
 * =============================================================
 *  CHAIN SELECTOR - user picks which chain to deposit on
 * =============================================================
 *  Cards showing each enabled chain with fee / speed / network info.
 *  Highlights the default (BSC, cheapest + memo support) and
 *  warns about TRC20 (no memo -> harder matching, slower credit).
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Zap, Coins, AlertTriangle, Loader2 } from 'lucide-react';
import { listEnabledChains, type ChainInfo } from '@/lib/api/wallet';

interface Props {
  token: string;
  selected: string;
  onChange: (chainKey: string) => void;
}

export default function ChainSelector({ token, selected, onChange }: Props) {
  const [chains, setChains] = useState<ChainInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listEnabledChains(token);
        if (!cancelled) setChains(res.chains);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (error) {
    return (
      <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
        <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
        <span className="text-red-300 text-sm">Failed to load chains: {error}</span>
      </div>
    );
  }

  if (!chains) {
    return (
      <div className="flex items-center justify-center py-4 text-text-muted text-sm font-mono">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading chains...
      </div>
    );
  }

  if (chains.length === 0) {
    return (
      <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm font-mono">
        No deposit chains are currently enabled. Contact support.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {chains.map((c) => {
        const isSelected = selected === c.chainKey;
        const isDefault = c.chainKey === 'BSC';
        return (
          <button
            key={c.chainKey}
            type="button"
            onClick={() => onChange(c.chainKey)}
            className={`w-full text-left p-3 rounded-lg border transition ${
              isSelected
                ? 'border-brand-green bg-brand-green/10'
                : 'border-border-default hover:border-brand-green/50'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="mt-0.5">
                  {isSelected ? (
                    <CheckCircle2 size={18} className="text-brand-green" />
                  ) : (
                    <Coins size={18} className="text-text-muted" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm text-text-primary font-bold">
                      {c.displayName}
                    </span>
                    {isDefault && (
                      <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-mono">
                        Recommended
                      </span>
                    )}
                    {c.memoSupported ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono inline-flex items-center gap-1">
                        <Zap size={10} />
                        Fast credit
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono inline-flex items-center gap-1">
                        <AlertTriangle size={10} />
                        Slower credit
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs font-mono">
                    <div>
                      <span className="text-text-muted">Network fee</span>
                      <div className="text-text-primary">
                        ${c.avgFeeUsdt.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span className="text-text-muted">Detection</span>
                      <div className="text-text-primary">
                        ~{c.estimatedSeconds < 60
                          ? `${c.estimatedSeconds}s`
                          : `${Math.round(c.estimatedSeconds / 60)}m`}
                      </div>
                    </div>
                    <div>
                      <span className="text-text-muted">Confirmations</span>
                      <div className="text-text-primary">
                        {c.minConfirmations} block{c.minConfirmations === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  {c.notes && (
                    <p className="text-xs text-text-muted mt-1">{c.notes}</p>
                  )}
                </div>
              </div>
              {isSelected && (
                <span className="text-xs text-brand-green font-mono whitespace-nowrap">Selected</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}