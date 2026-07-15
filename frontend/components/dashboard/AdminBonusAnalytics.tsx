'use client';
/**
 * Phase 2.7 — Bonus Analytics Dashboard (pure SVG, no chart dep).
 *
 * Fetches /api/admin/bonus/analytics and renders 4 cards:
 *   1. Daily claims sparkline (last 30d, inline SVG bars)
 *   2. Top bonus types (table with conversion badge)
 *   3. Withdrawal-conversion rate (big number + sub-stat)
 *   4. Active payout liability (big number)
 *
 * Surgical addition: mounted at the top of AdminBonusPanel.tsx.
 */
import { useState, useEffect, useCallback } from 'react';
import { BarChart3, TrendingUp, Wallet, Users, RefreshCw, Loader2 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

interface DailyPoint {
  day: string;
  claims: number;
  coins_granted: number;
  wagering_required: number;
}
interface TopType {
  bonus_type: string;
  claims: number;
  coins_granted: number;
  completed: number;
  expired: number;
  avg_completion_seconds: number | null;
}
interface Analytics {
  dailyClaims: DailyPoint[];
  topTypes: TopType[];
  conversion: { claimUsers30d: number; withdrewUsers30d: number; rate: number };
  liability: { activeCoins: number; activeClaims: number };
  generatedAt: string;
}

const W = 360;
const H = 100;
const BAR_GAP = 2;

function DailySparkline({ data }: { data: DailyPoint[] }) {
  if (!data || data.length === 0) {
    return <div className="text-text-muted text-xs p-4">No claims in last 30d.</div>;
  }
  const max = Math.max(...data.map((d) => d.claims), 1);
  const barW = Math.max(2, (W - BAR_GAP * (data.length - 1)) / data.length);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
      {data.map((d, i) => {
        const bh = (d.claims / max) * (H - 14);
        const x = i * (barW + BAR_GAP);
        const y = H - bh - 2;
        return (
          <g key={d.day}>
            <rect x={x} y={y} width={barW} height={bh} rx={1.2}
              className="fill-brand-gold/80 hover:fill-brand-gold">
              <title>{d.day}: {d.claims} claims · {Math.round(d.coins_granted).toLocaleString()} coins</title>
            </rect>
          </g>
        );
      })}
      <text x={4} y={H - 2} fontSize="9" fill="#64748b">{String(data[0].day).slice(0, 10)}</text>
      <text x={W - 4} y={H - 2} fontSize="9" fill="#64748b" textAnchor="end">{String(data[data.length - 1].day).slice(0, 10)}</text>
    </svg>
  );
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}
function dur(sec: number | null) {
  if (sec == null) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export default function AdminBonusAnalytics() {
  const token = useGameStore((s) => s.token);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const r: any = await api.get('/admin/analytics', token);
      if (r.success) setAnalytics(r.analytics);
      else setError(r.error || 'Load failed');
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return <div className="p-3 bg-brand-red/10 border border-brand-red/30 rounded text-brand-red text-sm">{error}</div>;
  }

  if (!analytics && !loading) {
    return <div className="text-text-muted text-sm py-4">No analytics available.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-text-primary font-medium flex items-center gap-2 text-sm">
          <BarChart3 size={14} className="text-brand-gold" /> Bonus Analytics
        </h3>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-50">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {/* Top row: 4 KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Kpi
          icon={<TrendingUp size={14} className="text-brand-gold" />}
          label="Claims (30d)"
          value={analytics ? String(analytics.dailyClaims.reduce((s, d) => s + d.claims, 0)) : '…'}
        />
        <Kpi
          icon={<Users size={14} className="text-blue-400" />}
          label="Claim users"
          value={analytics ? String(analytics.conversion.claimUsers30d) : '…'}
        />
        <Kpi
          icon={<Wallet size={14} className="text-brand-orange" />}
          label="Conversion"
          value={analytics ? pct(analytics.conversion.rate) : '…'}
          sub={analytics ? `${analytics.conversion.withdrewUsers30d} withdrew` : ''}
        />
        <Kpi
          icon={<Wallet size={14} className="text-brand-red" />}
          label="Active liability"
          value={analytics ? Math.round(analytics.liability.activeCoins).toLocaleString() : '…'}
          sub={analytics ? `${analytics.liability.activeClaims} active claim(s)` : ''}
        />
      </div>

      {/* Sparkline card */}
      <div className="bg-surface-2 border border-border rounded-lg p-3">
        <div className="text-text-muted text-[10px] mb-1 uppercase tracking-wide">Daily claims · last 30d</div>
        {loading && !analytics
          ? <div className="text-text-muted text-xs py-8 text-center"><Loader2 size={14} className="animate-spin inline mr-1" />Loading…</div>
          : <DailySparkline data={analytics?.dailyClaims ?? []} />}
      </div>

      {/* Top bonus types table */}
      <div className="bg-surface-2 border border-border rounded-lg p-3">
        <div className="text-text-muted text-[10px] mb-2 uppercase tracking-wide">Top bonus types · last 30d</div>
        {!analytics?.topTypes?.length
          ? <div className="text-text-muted text-xs py-4 text-center">No bonus claims in last 30d.</div>
          : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted text-left border-b border-border">
                  <th className="py-1 font-normal">Type</th>
                  <th className="py-1 font-normal text-right">Claims</th>
                  <th className="py-1 font-normal text-right">Granted</th>
                  <th className="py-1 font-normal text-right">Completed</th>
                  <th className="py-1 font-normal text-right">Avg to complete</th>
                </tr>
              </thead>
              <tbody>
                {analytics.topTypes.map((t) => (
                  <tr key={t.bonus_type} className="border-b border-border/40 last:border-0">
                    <td className="py-1.5 text-text-primary font-mono text-[11px]">{t.bonus_type}</td>
                    <td className="py-1.5 text-right">{t.claims}</td>
                    <td className="py-1.5 text-right text-brand-gold">{Math.round(t.coins_granted).toLocaleString()}</td>
                    <td className="py-1.5 text-right">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${t.completed > t.expired ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red'}`}>
                        {t.completed}/{t.claims}
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-text-muted">{dur(t.avg_completion_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 text-text-muted text-[10px] uppercase tracking-wide">
        {icon} {label}
      </div>
      <div className="text-text-primary font-mono text-lg mt-1">{value}</div>
      {sub && <div className="text-text-muted text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}
