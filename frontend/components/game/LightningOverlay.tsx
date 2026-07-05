"use client";

/**
 * LightningOverlay — Mystery Multiplier flash UI
 * Pre-announces a boosted payout multiplier during the spin.
 */

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useGameStore } from "@/lib/store";
import { useTranslation } from "@/hooks/useTranslation";

export function LightningOverlay() {
  const { t } = useTranslation();
  const { lastResult, gameStatus } = useGameStore();
  const [visible, setVisible] = useState(false);

  const lightning = lastResult?.lightning;

  useEffect(() => {
    if (lightning?.triggered && gameStatus === "spinning") {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), lightning.durationSeconds * 1000);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [lightning, gameStatus]);

  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none animate-pulse">
      <div className="relative flex flex-col items-center">
        <div className="absolute inset-0 blur-2xl bg-brand-gold/30 rounded-full" />
        <div className="relative px-8 py-4 rounded-2xl border-2 border-brand-gold bg-surface/90 shadow-2xl">
          <div className="flex items-center gap-3">
            <Zap className="w-8 h-8 text-brand-gold fill-brand-gold" />
            <div className="text-center">
              <div className="text-xs uppercase tracking-widest text-brand-gold font-bold">
                {t("lightningRound") || "LIGHTNING ROUND"}
              </div>
              <div className="text-4xl font-black text-white">
                {lightning?.multiplier.toFixed(2)}x
              </div>
              <div className="text-xs text-text-muted">
                {t("boostedPayout") || "Boosted payout"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
