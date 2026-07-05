"use client";

/**
 * ScatterBonus — Pick-a-Coin mini bonus game
 * Shows 3 mystery coins after a triggered scatter. The user taps one
 * to reveal a pre-committed multiplier and claim a free credit.
 */

import { useState } from "react";
import { Coins } from "lucide-react";
import { useGameStore, BetResult } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { useTranslation } from "@/hooks/useTranslation";

export function ScatterBonus() {
  const { t } = useTranslation();
  const { pendingScatter, setPendingScatter, setActiveScatter } = useGameStore();
  const [revealIndex, setRevealIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  if (!pendingScatter?.scatter?.triggered) return null;

  const scatter = pendingScatter.scatter;
  const handlePick = (index: number) => {
    if (loading || revealIndex !== null) return;
    setRevealIndex(index);
    setLoading(true);

    const socket = getSocket();
    socket.emit("scatter:pick", { betId: pendingScatter.betId, pickIndex: index });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="glass-card max-w-md w-full p-6 text-center">
        <h2 className="text-xl font-bold text-brand-gold mb-2">
          🪙 {t("scatterBonusTitle") || "Scatter Bonus!"}
        </h2>
        <p className="text-text-secondary text-sm mb-6">
          {t("scatterBonusDesc") || "Pick a mystery coin to reveal your bonus multiplier."}
        </p>

        <div className="flex items-center justify-center gap-4 mb-6">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              onClick={() => handlePick(index)}
              disabled={loading}
              className={`
                relative w-24 h-24 rounded-full flex items-center justify-center
                transition-all duration-300 transform hover:scale-105
                ${revealIndex === index
                  ? "bg-brand-gold/20 ring-2 ring-brand-gold"
                  : "bg-surface border border-border hover:border-brand-gold/50"
                }
                ${revealIndex !== null && revealIndex !== index ? "opacity-50" : ""}
              `}
            >
              {revealIndex === index ? (
                <div className="text-center">
                  <div className="text-2xl font-bold text-brand-gold">
                    {scatter.multiplier?.toFixed(2)}x
                  </div>
                  <div className="text-xs text-text-secondary">${scatter.payout?.toFixed(2)}</div>
                </div>
              ) : (
                <Coins className="w-10 h-10 text-brand-gold" />
              )}
            </button>
          ))}
        </div>

        {revealIndex !== null && scatter.payout && scatter.multiplier && (
          <div className="text-brand-green font-medium">
            {t("scatterBonusWon") || "Bonus won"}: ${scatter.payout.toFixed(2)} ({scatter.multiplier.toFixed(2)}x)
          </div>
        )}

        <button
          onClick={() => setPendingScatter(null)}
          className="mt-4 text-xs text-text-muted hover:text-text-primary"
        >
          {t("close") || "Close"}
        </button>
      </div>
    </div>
  );
}
