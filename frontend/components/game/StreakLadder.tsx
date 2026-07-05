"use client";

/**
 * StreakLadder — push-your-luck win streak bonus widget
 * Shows current streak rung, at-risk bonus, and a Bank button.
 */

import { useState } from "react";
import { TrendingUp, PiggyBank } from "lucide-react";
import { useGameStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { useTranslation } from "@/hooks/useTranslation";

const RUNGS = [
  { wins: 1, multiplier: 1.2, color: "from-gray-500 to-gray-400" },
  { wins: 2, multiplier: 1.5, color: "from-blue-500 to-blue-400" },
  { wins: 3, multiplier: 2.0, color: "from-purple-500 to-purple-400" },
  { wins: 4, multiplier: 3.0, color: "from-orange-500 to-orange-400" },
  { wins: 5, multiplier: 5.0, color: "from-red-500 to-red-400" },
];

export function StreakLadder() {
  const { t } = useTranslation();
  const { lastResult, user } = useGameStore();
  const [banking, setBanking] = useState(false);
  const [bankedMsg, setBankedMsg] = useState<string | null>(null);

  // Current streak comes from the last bet result
  const streak = lastResult?.streak;
  const currentStreak = streak?.currentStreak ?? 0;
  const atRisk = streak?.atRisk ?? 0;

  const bank = () => {
    if (atRisk <= 0 || banking) return;
    setBanking(true);
    const socket = getSocket();
    socket.emit("streak:bank", {}, (res: { ok: boolean; banked?: number; newBalance?: number; message?: string }) => {
      setBanking(false);
      if (res.ok) {
        setBankedMsg(res.message || `Banked $${res.banked?.toFixed(2)}`);
      } else {
        setBankedMsg(res.message || "Bank failed");
      }
    });
  };

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-brand-gold" />
          <h3 className="font-bold text-text-primary">{t("streakLadder") || "Streak Ladder"}</h3>
        </div>
        <button
          onClick={bank}
          disabled={atRisk <= 0 || banking}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-green/20 text-brand-green text-sm font-medium hover:bg-brand-green/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <PiggyBank className="w-4 h-4" />
          {banking ? t("banking") || "Banking..." : t("bank") || "Bank"}
        </button>
      </div>

      <div className="flex items-end justify-between gap-2 h-24 mb-3">
        {RUNGS.map((rung) => {
          const active = currentStreak >= rung.wins;
          const isCurrent = currentStreak === rung.wins;
          return (
            <div key={rung.wins} className="flex-1 flex flex-col items-center gap-1">
              <div
                className={`
                  w-full rounded-t-lg bg-gradient-to-t ${rung.color} transition-all duration-500
                  ${active ? "opacity-100" : "opacity-20"}
                `}
                style={{ height: `${(rung.wins / RUNGS.length) * 100}%` }}
              />
              <div className={`text-xs font-bold ${isCurrent ? "text-brand-gold" : "text-text-secondary"}`}>
                {rung.multiplier}x
              </div>
              <div className="text-[10px] text-text-muted">{rung.wins}W</div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="text-text-secondary">
          {t("currentStreak") || "Current streak"}: <span className="text-text-primary font-bold">{currentStreak}</span>
        </div>
        <div className="text-brand-gold font-bold">
          {t("atRisk") || "At risk"}: ${atRisk.toFixed(2)}
        </div>
      </div>

      {bankedMsg && (
        <div className="mt-2 text-xs text-brand-green text-center">{bankedMsg}</div>
      )}
    </div>
  );
}
