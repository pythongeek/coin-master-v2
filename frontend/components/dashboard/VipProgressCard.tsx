"use client";

/**
 * VipProgressCard — Gamified VIP tier progress bar
 */

import { Crown, Sparkles } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";

interface VipData {
  currentTier: { name: string; rakebackPercent: number; color: string; icon: string };
  nextTier: { name: string; wagerRequired: number } | null;
  progressPercent: number;
  wagerToNext: number;
}

export function VipProgressCard({ vip, totalWagered }: { vip: VipData | null; totalWagered: number }) {
  const { t } = useTranslation();

  if (!vip) return null;

  const { currentTier, nextTier, progressPercent, wagerToNext } = vip;
  const isMax = !nextTier;

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60"
      style={{ borderColor: `${currentTier.color}40` }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-lg"
            style={{ backgroundColor: `${currentTier.color}20`, color: currentTier.color }}
          >
            {currentTier.icon}
          </div>
          <div>
            <div className="text-xs text-text-muted font-mono uppercase">{t("vipTier") || "VIP Tier"}</div>
            <div className="font-bold text-text-primary" style={{ color: currentTier.color }}>
              {currentTier.name}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-muted">{t("rakeback") || "Rakeback"}</div>
          <div className="font-bold text-brand-green">{(currentTier.rakebackPercent * 100).toFixed(2)}%</div>
        </div>
      </div>

      <div className="h-2.5 w-full bg-surface2 rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${progressPercent}%`, backgroundColor: currentTier.color }}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <div className="text-text-secondary">
          {t("wagered") || "Wagered"}: <span className="text-text-primary font-bold">${totalWagered.toFixed(2)}</span>
        </div>
        <div className="text-text-secondary">
          {isMax ? (
            <span className="flex items-center gap-1 text-brand-gold">
              <Crown size={12} />
              {t("maxTier") || "Max tier"}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Sparkles size={12} className="text-brand-gold" />
              ${wagerToNext.toFixed(0)} to {nextTier.name}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
