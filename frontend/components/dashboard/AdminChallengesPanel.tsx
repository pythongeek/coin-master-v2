"use client";

/**
 * AdminChallengesPanel — View challenge definitions and platform completion stats.
 */

import { useState, useEffect } from "react";
import { Target, Trophy } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";

const API =
  typeof window !== "undefined" && !window.location.host.startsWith("localhost:") && window.location.host !== "localhost"
    ? "/api"
    : process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface ChallengeDef {
  id: string;
  label: string;
  target: number;
  reward: number;
  metric: string;
}

interface ChallengeStats {
  total_completions: string;
  total_rewards: string;
  completions_24h: string;
}

export default function AdminChallengesPanel() {
  const { addToast } = useToast();
  const [token, setToken] = useState("");
  const [definitions, setDefinitions] = useState<ChallengeDef[]>([]);
  const [stats, setStats] = useState<ChallengeStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setToken(localStorage.getItem("cf_token") || "");
  }, []);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/challenges`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setDefinitions(data.definitions || []);
        setStats(data.stats || null);
      } else {
        addToast(data.error || "Failed to load challenges", "error");
      }
    } catch (e) {
      addToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token]);

  if (loading) {
    return <div className="glass-card p-5 rounded-2xl text-center text-text-muted">Loading...</div>;
  }

  return (
    <div className="glass-card p-5 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-9 h-9 rounded-full bg-brand-maroon/20 flex items-center justify-center text-brand-maroon">
          <Target size={18} />
        </div>
        <div>
          <div className="font-bold text-text-primary">Challenges / Missions</div>
          <div className="text-xs text-text-muted">Daily mission definitions and stats</div>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">Total completions</div>
            <div className="font-bold text-text-primary">{stats.total_completions}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">Total rewards</div>
            <div className="font-bold text-brand-green">{parseFloat(String(stats.total_rewards)).toFixed(2)}</div>
          </div>
          <div className="p-3 rounded-lg bg-surface2/40 text-center">
            <div className="text-xs text-text-muted">24h completions</div>
            <div className="font-bold text-text-primary">{stats.completions_24h}</div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {definitions.map((def) => (
          <div key={def.id} className="flex items-center justify-between p-3 rounded-lg bg-surface2/40">
            <div className="flex items-center gap-2">
              <Trophy size={14} className="text-brand-gold" />
              <div>
                <div className="text-sm font-medium text-text-primary">{def.label}</div>
                <div className="text-xs text-text-muted">{def.metric} · target {def.target}</div>
              </div>
            </div>
            <div className="text-sm font-bold text-brand-green">{def.reward} coins</div>
          </div>
        ))}
      </div>

      <div className="mt-4 text-xs text-text-muted">
        Edit definitions in Game Config via the <code>dailyChallenges</code> JSON field.
      </div>
    </div>
  );
}
