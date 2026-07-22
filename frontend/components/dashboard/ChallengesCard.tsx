"use client";

/**
 * ChallengesCard — Daily mission progress and claim widget.
 */

import { useState, useEffect, useCallback } from "react";
import { Target, CheckCircle, Lock } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { getApiBase } from '@/lib/api/base';


const API = getApiBase();

interface ChallengeProgress {
  id: string;
  label: string;
  target: number;
  current: number;
  reward: number;
  completed: boolean;
  claimed: boolean;
}

export function ChallengesCard({ token, onClaim }: { token: string; onClaim?: () => void }) {
  const { addToast } = useToast();
  const [challenges, setChallenges] = useState<ChallengeProgress[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchChallenges = useCallback(async () => {
    const res = await fetch(`${API}/dashboard/challenges`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) setChallenges(data.data || []);
  }, [token]);

  useEffect(() => {
    setLoading(true);
    fetchChallenges().finally(() => setLoading(false));
  }, [fetchChallenges]);

  const claim = async (id: string) => {
    const res = await fetch(`${API}/dashboard/challenges/${id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) {
      setChallenges(data.data);
      addToast("Challenge reward claimed!", "success");
      onClaim?.();
    } else {
      addToast(data.error || "Claim failed", "error");
    }
  };

  if (loading) {
    return (
      <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60 h-32 flex items-center justify-center text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  if (challenges.length === 0) {
    return null;
  }

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-brand-maroon/20 flex items-center justify-center text-brand-maroon">
          <Target size={18} />
        </div>
        <div>
          <div className="font-bold text-text-primary">Daily Challenges</div>
          <div className="text-xs text-text-muted">Complete missions for rewards</div>
        </div>
      </div>

      <div className="space-y-3">
        {challenges.map((c) => {
          const pct = Math.min(100, Math.round((c.current / c.target) * 100));
          return (
            <div key={c.id} className="p-3 rounded-lg bg-surface2/40">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-medium text-text-primary">{c.label}</div>
                <div className="text-xs text-text-muted">{c.current} / {c.target}</div>
              </div>
              <div className="w-full h-2 bg-surface rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-brand-maroon transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-brand-gold">Reward: {c.reward} coins</div>
                {c.claimed ? (
                  <div className="flex items-center gap-1 text-xs text-brand-green">
                    <CheckCircle size={12} /> Claimed
                  </div>
                ) : c.completed ? (
                  <button
                    onClick={() => claim(c.id)}
                    className="px-3 py-1 rounded-lg bg-brand-green text-white text-xs font-medium hover:bg-brand-green/90"
                  >
                    Claim
                  </button>
                ) : (
                  <div className="flex items-center gap-1 text-xs text-text-muted">
                    <Lock size={12} /> Locked
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
