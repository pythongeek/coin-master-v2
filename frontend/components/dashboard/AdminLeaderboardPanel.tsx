"use client";

/**
 * AdminLeaderboardPanel — Manage wagering leaderboard and distribute prizes.
 */

import { useState, useEffect } from "react";
import { Trophy, Crown, RefreshCw, Award } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
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

interface LeaderboardStats {
  total_prizes: number;
  total_given: string;
  prizes_24h: number;
}

export default function AdminLeaderboardPanel() {
  const { addToast } = useToast();
  const [token, setToken] = useState("");
  const [period, setPeriod] = useState<"daily" | "weekly">("daily");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [stats, setStats] = useState<LeaderboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [distributing, setDistributing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = localStorage.getItem("cf_token") || "";
    setToken(t);
  }, []);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/leaderboard?period=${period}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setEntries(data.entries || []);
        setStats(data.stats || null);
      } else {
        addToast(data.error || "Failed to load leaderboard", "error");
      }
    } catch (e) {
      addToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token, period]);

  const distribute = async () => {
    if (!token) return;
    if (!confirm(`Distribute ${period} leaderboard prizes?`)) return;
    setDistributing(true);
    try {
      const res = await fetch(`${API}/admin/leaderboard/distribute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      const data = await res.json();
      if (data.success) {
        addToast(`Distributed ${data.result.distributed} prizes (${data.result.total} coins)`, "success");
        load();
      } else {
        addToast(data.error || "Failed to distribute", "error");
      }
    } catch (e) {
      addToast(String(e), "error");
    } finally {
      setDistributing(false);
    }
  };

  return (
    <div className="glass-card p-5 rounded-2xl border border-border bg-surface/60">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-brand-gold/20 flex items-center justify-center text-brand-gold">
            <Trophy size={18} />
          </div>
          <div>
            <div className="font-bold text-text-primary">Leaderboard</div>
            <div className="text-xs text-text-muted">Wagering tournament</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["daily", "weekly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs rounded-lg border ${
                  period === p
                    ? "bg-brand-info/20 border-brand-info text-brand-info"
                    : "border-border text-text-muted hover:text-text-primary"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="p-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:border-brand-info/40"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={distribute}
            disabled={distributing || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-gold/20 text-brand-gold border border-brand-gold/30 hover:bg-brand-gold/30 text-xs font-medium"
          >
            <Award size={14} />
            {distributing ? "Working..." : "Distribute prizes"}
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">Total prizes</div>
            <div className="font-bold text-text-primary">{stats.total_prizes}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">Total given</div>
            <div className="font-bold text-brand-green">{parseFloat(String(stats.total_given)).toFixed(2)}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">24h prizes</div>
            <div className="font-bold text-text-primary">{stats.prizes_24h}</div>
          </div>
        </div>
      )}

      <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
        {entries.length === 0 && !loading && (
          <div className="text-center text-text-muted text-sm py-6">No wagers yet for this period.</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.userId}
            className="flex items-center justify-between p-3 rounded-lg bg-surface2/40 hover:bg-surface2/60 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-surface flex items-center justify-center text-xs font-bold text-text-muted">
                {entry.rank === 1 ? <Crown size={14} className="text-brand-gold" /> : entry.rank}
              </div>
              <div>
                <div className="text-sm font-medium text-text-primary">{entry.username}</div>
                <div className="text-xs text-text-muted">{entry.totalBets} bets</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-bold text-text-primary">${entry.totalWagered.toFixed(2)}</div>
              {entry.prize > 0 && (
                <div className="text-xs text-brand-green">Prize: {entry.prize} coins</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
