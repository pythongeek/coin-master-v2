"use client";

/**
 * RakebackCard — Wager-based rebate claim widget.
 */

import { useState, useEffect, useCallback } from "react";
import { Coins, Gift } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";

const API =
  typeof window !== "undefined" && !window.location.host.startsWith("localhost:") && window.location.host !== "localhost"
    ? "/api"
    : process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface RakebackStatus {
  pending: number;
  claimed: number;
  totalWagered: number;
  rate: number;
  canClaim: boolean;
  minClaim: number;
}

export function RakebackCard({ token, onClaim }: { token: string; onClaim?: () => void }) {
  const { addToast } = useToast();
  const [status, setStatus] = useState<RakebackStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);

  const fetchStatus = useCallback(async () => {
    const res = await fetch(`${API}/dashboard/rakeback`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) setStatus(data.data);
  }, [token]);

  useEffect(() => {
    setLoading(true);
    fetchStatus().finally(() => setLoading(false));
  }, [fetchStatus]);

  const claim = async () => {
    setClaiming(true);
    try {
      const res = await fetch(`${API}/dashboard/rakeback/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setStatus(data.data);
        addToast(`Claimed ${data.data.claimed} rakeback!`, "success");
        onClaim?.();
      } else {
        addToast(data.error || "Claim failed", "error");
      }
    } catch (e) {
      addToast(String(e), "error");
    } finally {
      setClaiming(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60 h-32 flex items-center justify-center text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  if (!status || status.rate <= 0) {
    return null;
  }

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-green/20 flex items-center justify-center text-brand-green">
            <Gift size={18} />
          </div>
          <div>
            <div className="font-bold text-text-primary">Rakeback</div>
            <div className="text-xs text-text-muted">{status.rate.toFixed(2)}% effective rate</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-brand-green">{status.pending.toFixed(4)}</div>
          <div className="text-xs text-text-muted">available coins</div>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex justify-between text-xs text-text-muted">
          <span>24h wagered</span>
          <span>${status.totalWagered.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-xs text-text-muted">
          <span>24h claimed</span>
          <span>{status.claimed.toFixed(4)} coins</span>
        </div>
        <div className="flex justify-between text-xs text-text-muted">
          <span>Min claim</span>
          <span>{status.minClaim} coins</span>
        </div>
      </div>

      <button
        onClick={claim}
        disabled={!status.canClaim || claiming}
        className={`w-full py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-2 ${
          status.canClaim
            ? "bg-brand-green text-white hover:bg-brand-green/90"
            : "bg-surface2 text-text-muted cursor-not-allowed"
        }`}
      >
        <Coins size={14} />
        {claiming ? "Claiming..." : status.canClaim ? "Claim rakeback" : `Need ${status.minClaim} coins min`}
      </button>
    </div>
  );
}
