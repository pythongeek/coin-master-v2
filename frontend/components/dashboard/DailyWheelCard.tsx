"use client";

/**
 * DailyWheelCard — Provably-fair daily login prize spinner.
 */

import { useState, useCallback } from "react";
import { Gift, Loader2, Lock } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface WheelData {
  enabled: boolean;
  canSpin: boolean;
  nextSpinAt: string | null;
}

interface WheelPrize {
  label: string;
  value: number;
  type: string;
}

export function DailyWheelCard({ wheel, token, onSpin }: { wheel?: WheelData; token: string; onSpin: () => void }) {
  const { t } = useTranslation();
  const [spinning, setSpinning] = useState(false);
  const [lastPrize, setLastPrize] = useState<WheelPrize | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spin = useCallback(async () => {
    if (!wheel?.canSpin || spinning) return;
    setSpinning(true);
    setError(null);

    try {
      const clientSeed = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
      const res = await fetch(`${API}/dashboard/wheel/spin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ clientSeed }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Spin failed");
      setLastPrize(data.data.prize);
      onSpin();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSpinning(false);
    }
  }, [wheel, spinning, token, onSpin]);

  if (!wheel?.enabled) return null;

  const nextAt = wheel.nextSpinAt ? new Date(wheel.nextSpinAt) : null;
  const cooldownText = nextAt && !wheel.canSpin
    ? `${t("nextSpin") || "Next spin"}: ${nextAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : null;

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-purple/20 flex items-center justify-center text-brand-purple">
            <Gift size={18} />
          </div>
          <div className="font-bold text-text-primary">{t("dailyWheel") || "Daily Wheel"}</div>
        </div>
        {!wheel.canSpin ? (
          <div className="flex items-center gap-1 text-xs text-text-muted">
            <Lock size={12} /> {cooldownText}
          </div>
        ) : (
          <div className="text-xs font-bold text-brand-green">{t("freeSpin") || "Free spin available!"}</div>
        )}
      </div>

      <div className="flex items-center justify-center py-4">
        <button
          onClick={spin}
          disabled={!wheel.canSpin || spinning}
          className={`relative w-32 h-32 rounded-full border-4 flex flex-col items-center justify-center transition-all ${
            wheel.canSpin
              ? "border-brand-purple bg-brand-purple/10 hover:bg-brand-purple/20 text-brand-purple cursor-pointer"
              : "border-border bg-surface2/50 text-text-muted cursor-not-allowed"
          }`}
        >
          {spinning ? (
            <Loader2 className="animate-spin" size={28} />
          ) : (
            <>
              <Gift size={28} className="mb-1" />
              <span className="text-xs font-bold">{wheel.canSpin ? (t("spin") || "SPIN") : (t("locked") || "LOCKED")}</span>
            </>
          )}
        </button>
      </div>

      {lastPrize && wheel.canSpin === false && (
        <div className="text-center text-sm font-bold text-brand-green mb-2">
          🎉 {t("youWon") || "You won"} {lastPrize.label}!
        </div>
      )}

      {error && (
        <div className="text-center text-xs text-brand-red">{error}</div>
      )}
    </div>
  );
}
