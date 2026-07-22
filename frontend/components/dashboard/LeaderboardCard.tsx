"use client";

/**
 * LeaderboardCard — Wagering volume top players panel.
 */

import { useState, useEffect } from "react";
import { Trophy, Medal } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { getApiBase } from '@/lib/api/base';


const API = getApiBase();

interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  totalWagered: number;
  totalBets: number;
  prize: number;
}

interface LeaderboardData {
  entries: LeaderboardEntry[];
  position: { position: number | null; totalWagered: number; prize: number };
}

export function LeaderboardCard({ token }: { token: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [period, setPeriod] = useState<"daily" | "weekly">("daily");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/dashboard/leaderboard?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setData(d.data);
      })
      .finally(() => setLoading(false));
  }, [period, token]);

  if (loading) {
    return (
      <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60 h-40 flex items-center justify-center text-text-muted text-sm">
        {t("loading") || "Loading..."}
      </div>
    );
  }

  if (!data?.entries?.length) {
    return null;
  }

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-gold/20 flex items-center justify-center text-brand-gold">
            <Trophy size={18} />
          </div>
          <div>
            <div className="font-bold text-text-primary">{t("leaderboard") || "Leaderboard"}</div>
            <div className="text-xs text-text-muted">{t("topWagerers") || "Top wagerers"}</div>
          </div>
        </div>
        <div className="flex gap-1">
          {(["daily", "weekly"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 py-1 text-xs rounded-lg border ${
                period === p
                  ? "bg-brand-info/20 border-brand-info text-brand-info"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
            >
              {t(p) || p}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {data.entries.slice(0, 10).map((entry) => (
          <div
            key={entry.userId}
            className={`flex items-center justify-between p-2 rounded-lg text-sm ${
              data.position?.position === entry.rank
                ? "bg-brand-info/10 border border-brand-info/30"
                : "bg-surface2/40"
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-xs font-bold text-text-muted">
                {entry.rank <= 3 ? <Medal size={14} className={
                  entry.rank === 1 ? "text-brand-gold" : entry.rank === 2 ? "text-gray-300" : "text-amber-600"
                } /> : entry.rank}
              </div>
              <div className="text-text-primary font-medium truncate max-w-[120px]">{entry.username}</div>
            </div>
            <div className="text-right">
              <div className="text-text-primary font-bold">${entry.totalWagered.toFixed(2)}</div>
              {entry.prize > 0 && (
                <div className="text-xs text-brand-green">+{entry.prize} coins</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {data.position?.position && (
        <div className="mt-3 pt-3 border-t border-border text-center text-xs text-text-muted">
          {t("yourRank") || "Your rank"}: #{data.position.position} · ${data.position.totalWagered.toFixed(2)} wagered
        </div>
      )}
    </div>
  );
}
