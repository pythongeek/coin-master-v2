'use client';
/**
 * Phase 3 / P3-3b — Audience Graphs (D3)
 *
 * One panel, six views, one D3 component under the hood.
 * - pill-button sub-nav switches the active metric
 * - re-uses D3ForceGraph (P3-3a) for the visualisation itself
 * - node click → openUserDrill (the existing risk-profile modal)
 *
 * 6 audience views:
 *   top_depositors | top_winners | top_withdrawers | top_volume
 *   top_risk        | top_fraud_signals
 *
 * Surgical addition: no other panel touched, no admin menu change
 * (the panel is added in P3-3c, not this sub-step).
 */
import { useState, useEffect, useCallback } from 'react';
import { Users, TrendingUp, AlertTriangle, Loader2, RefreshCw, Banknote, Trophy, Wallet, Activity, ShieldAlert, ListChecks, Network } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import D3ForceGraph, { GraphNode, GraphEdge } from './D3ForceGraph';

interface AudienceResult {
  metric: string;
  generatedAt: string;
  range: { from: string; to: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const METRIC_TABS: Array<{ key: string; label: string; Icon: any; hint: string }> = [
  { key: 'top_depositors',    label: 'Top Depositors',   Icon: Banknote,    hint: 'sum(deposit) last 30d' },
  { key: 'top_winners',       label: 'Top Winners',      Icon: Trophy,      hint: 'sum(win/payout) last 30d' },
  { key: 'top_withdrawers',   label: 'Top Withdrawers',  Icon: Wallet,      hint: 'sum(withdrawal) last 30d' },
  { key: 'top_volume',        label: 'Top Volume',       Icon: Activity,    hint: 'sum(bet wager) last 30d' },
  { key: 'top_risk',          label: 'Top Risk',         Icon: ShieldAlert, hint: 'current user_risk_scores' },
  { key: 'top_fraud_signals', label: 'Fraud Signals',    Icon: AlertTriangle,hint: 'count(*) fraud_signals 30d' },
];

export default function AdminAudienceGraphs() {
  const token = useGameStore((s) => s.token);
  const [active, setActive] = useState('top_depositors');
  const [data, setData] = useState<AudienceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);

  const load = useCallback(async (metric: string) => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const r: any = await api.get(`/admin/graphs/audience-metric?metric=${metric}&limit=${limit}`, token);
      if (r.success) setData(r.result);
      else setError(r.error || 'Load failed');
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally { setLoading(false); }
  }, [token, limit]);

  useEffect(() => { load(active); }, [active, load]);

  const activeTab = METRIC_TABS.find((t) => t.key === active) ?? METRIC_TABS[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="heading-display text-lg text-text-primary flex items-center gap-2">
          <Users className="text-brand-gold" size={20} /> Audience Graphs
        </h2>
        <div className="flex items-center gap-2">
          <label className="text-text-muted text-[10px] uppercase tracking-wide">Limit</label>
          <input
            type="number"
            min={5}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Math.max(5, Math.min(100, parseInt(e.target.value, 10) || 50)))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-xs w-16 text-text-primary font-mono"
          />
          <button type="button" onClick={() => load(active)} disabled={loading}
            className="flex items-center gap-1 px-2 py-1 bg-surface-2 border border-border rounded text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <p className="text-text-muted text-xs max-w-3xl">
        Six audience views, each rendered as a D3 force-directed graph.
        Node <span className="text-text-secondary">size</span> = metric value,
        <span className="text-text-secondary"> fill</span> = risk tier.
        Click a node to drill in.
      </p>

      {/* Sub-nav pills */}
      <div className="flex flex-wrap gap-1">
        {METRIC_TABS.map((t) => {
          const Icon = t.Icon;
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActive(t.key)}
              title={t.hint}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs ${
                isActive
                  ? 'bg-brand-gold text-black font-medium'
                  : 'bg-surface-2 border border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon size={12} />
              {t.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="p-3 bg-brand-red/10 border border-brand-red/30 rounded-lg text-brand-red text-sm flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Graph + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-3">
        <div className="bg-surface border border-border rounded-lg p-3">
          {loading && !data ? (
            <p className="text-text-muted text-sm py-8 text-center">
              <Loader2 size={14} className="animate-spin inline mr-1" />
              Loading {activeTab.label}…
            </p>
          ) : data && data.nodes.length > 1 ? (
            <D3ForceGraph
              nodes={data.nodes}
              edges={data.edges}
              scope={`audience:${active}`}
              width={680}
              height={420}
              chargeStrength={-260}
              linkDistance={70}
              collideRadius={28}
              nodeSizeFrom="metric"
              sizeScale={4}
              minRadius={8}
              maxRadius={30}
              maxNodes={100}
            />
          ) : (
            <p className="text-text-muted text-sm py-8 text-center">No data for this metric.</p>
          )}
        </div>

        {/* Side panel: top-N list */}
        <div className="bg-surface border border-border rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-text-muted text-[10px] uppercase tracking-wide mb-2">
            <ListChecks size={11} /> {activeTab.label} · top 10
          </div>
          {!data ? (
            <p className="text-text-muted text-xs">—</p>
          ) : (
            <ol className="space-y-1 text-xs">
              {data.nodes
                .filter((n) => !n.id.startsWith('__centre_'))
                .sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))
                .slice(0, 10)
                .map((n, i) => (
                <li key={n.id} className="flex items-center justify-between border-b border-border/30 pb-1 last:border-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-text-muted font-mono w-4 text-right">{i + 1}.</span>
                    <span className="text-text-primary font-mono truncate">{n.username ?? n.id.slice(0, 8)}</span>
                    {n.isFlagged && <span className="px-1 py-0 rounded bg-brand-gold/20 text-brand-gold text-[9px]">F</span>}
                  </span>
                  <span className="text-text-secondary font-mono">
                    {n.metricLabel?.startsWith('Fraud') ? n.metric
                     : n.metricLabel === 'Risk score' ? (n.metric ?? 0).toFixed(0)
                     : n.metricLabel?.startsWith('Deposited') || n.metricLabel?.startsWith('Won') || n.metricLabel?.startsWith('Withdrawn') || n.metricLabel?.startsWith('Wagered')
                       ? `$${Math.round(n.metric ?? 0).toLocaleString()}`
                       : Math.round(n.metric ?? 0).toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <p className="text-text-muted text-[10px]">
        Range: {data ? `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}` : '—'}
        {' · '}Generated {data ? new Date(data.generatedAt).toLocaleTimeString() : '—'}
        {' · '}<Network size={10} className="inline" /> Force-directed · drag + zoom + persistence
      </p>
    </div>
  );
}
