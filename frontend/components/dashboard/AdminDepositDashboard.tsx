'use client';
/**
 * =============================================================
 *  ADMIN DEPOSIT DASHBOARD - 3 sub-tabs:
 *    Review Queue  - held for human decision
 *    All Orders    - every QR deposit, filterable + paginated
 *    LLM Stats     - verdict distribution, confidence histogram
 * =============================================================
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw, Filter } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';
import AdminQrReviewQueue from './AdminQrReviewQueue';
import AdminChainConfig from './AdminChainConfig';

const API = getApiBase();

type SubTab = 'queue' | 'all' | 'stats' | 'chains';

interface OrderRow {
  id: string;
  merchant_order_id: string;
  user_id: string;
  username: string | null;
  amount_usdt: number;
  amount_coins: number;
  status: string;
  qr_memo: string | null;
  chain: string | null;
  detected_tx_hash: string | null;
  llm_verdict: string | null;
  llm_confidence: number | null;
  llm_reason: string | null;
  rule_verdict: string | null;
  rule_disagreement: boolean | null;
  receipt_uploaded: boolean;
  admin_hold_reason: string | null;
  created_at: string;
  expires_at: string;
}

interface LlmStats {
  verdictDistribution: Array<{ llm_verdict: string; count: number }>;
  confidenceHistogram: Array<{ bucket: string; count: number }>;
  falseAutoCount: number;
  disagreementRate: { disagree: number; totalScored: number };
  statusCounts: Array<{ status: string; count: number }>;
  windowDays: number;
}

function statusBadge(s: string): string {
  switch (s) {
    case 'paid': return 'bg-green-500/20 text-green-400';
    case 'verifying': return 'bg-yellow-500/20 text-yellow-400';
    case 'detected': return 'bg-blue-500/20 text-blue-400';
    case 'failed': return 'bg-red-500/20 text-red-400';
    case 'expired': return 'bg-gray-500/20 text-gray-400';
    case 'awaiting_payment': return 'bg-bg-elevated text-text-muted';
    default: return 'bg-bg-elevated text-text-muted';
  }
}

function AllOrdersPanel() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      const res = await fetch(`${API}/admin/payments/qr-orders?${params}`, { headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setRows(json.orders);
      setTotal(json.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, offset, token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Filter size={14} className="text-text-muted" />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}
          className="bg-bg-elevated border border-border-default rounded px-2 py-1 text-sm font-mono"
        >
          <option value="">All statuses</option>
          <option value="awaiting_payment">Awaiting payment</option>
          <option value="detected">Detected</option>
          <option value="verifying">Verifying (held)</option>
          <option value="paid">Paid</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
        </select>
        <span className="text-xs text-text-muted font-mono">
          {total} total
        </span>
        <button type="button" onClick={load} className="ml-auto p-1.5 rounded hover:bg-bg-elevated">
          <RefreshCw size={14} className={`text-text-muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="p-2 rounded bg-red-500/10 text-red-300 text-sm font-mono">{error}</div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead className="text-xs text-text-muted border-b border-border-default">
            <tr>
              <th className="text-left p-2">Order</th>
              <th className="text-left p-2">User</th>
              <th className="text-right p-2">Amount</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Chain</th>
              <th className="text-left p-2">Memo</th>
              <th className="text-left p-2">AI</th>
              <th className="text-left p-2">Created</th>
              <th className="text-left p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border-default/50 hover:bg-bg-elevated/30">
                <td className="p-2 text-xs text-text-primary">{r.merchant_order_id.slice(0, 16)}...</td>
                <td className="p-2 text-xs text-text-muted">{r.username || r.user_id.slice(0, 8)}</td>
                <td className="p-2 text-right text-text-primary">${r.amount_usdt.toFixed(2)}</td>
                <td className="p-2">
                  <span className={`text-xs px-2 py-0.5 rounded ${statusBadge(r.status)}`}>{r.status}</span>
                </td>
                <td className="p-2 text-xs text-text-muted">{r.chain || '-'}</td>
                <td className="p-2 text-xs text-brand-green font-bold">{r.qr_memo || '-'}</td>
                <td className="p-2 text-xs">
                  {r.llm_verdict ? (
                    <span className={
                      r.llm_verdict === 'AUTO_CREDIT' ? 'text-green-400' :
                      r.llm_verdict === 'REJECT' ? 'text-red-400' :
                      'text-yellow-400'
                    }>
                      {r.llm_verdict} {r.llm_confidence ? `(${Math.round(r.llm_confidence * 100)}%)` : ''}
                    </span>
                  ) : <span className="text-text-muted">-</span>}
                  {r.rule_disagreement && (
                    <span className="ml-1 text-yellow-400" title="LLM-rule disagree">[!]</span>
                  )}
                </td>
                <td className="p-2 text-xs text-text-muted">{new Date(r.created_at).toLocaleString()}</td>
                <td className="p-2 text-xs">
                  <Link href={`/admin/payments/deposits/${encodeURIComponent(r.merchant_order_id)}`} className="text-brand-green hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && !loading && (
          <p className="text-sm text-text-muted font-mono text-center py-8">No orders match the filter.</p>
        )}
      </div>

      <div className="flex items-center justify-between text-xs font-mono">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
          className="px-3 py-1 rounded border border-border-default text-text-muted hover:border-text-primary disabled:opacity-30"
        >
          Prev
        </button>
        <span className="text-text-muted">
          {offset + 1}-{Math.min(offset + limit, total)} of {total}
        </span>
        <button
          type="button"
          disabled={offset + limit >= total}
          onClick={() => setOffset(offset + limit)}
          className="px-3 py-1 rounded border border-border-default text-text-muted hover:border-text-primary disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function LlmStatsPanel() {
  const [stats, setStats] = useState<LlmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string>('');

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/llm-stats`, { headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setStats(json.stats);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  async function rebuild() {
    setRebuilding(true);
    setRebuildMsg('');
    try {
      const res = await fetch(`${API}/admin/payments/llm-prompt-rebuild`, { method: 'POST', headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setRebuildMsg(`Rebuilt v${json.result.newVersion}: scanned=${json.result.decisionsScanned}, few-shot=${json.result.fewShotCount}, saved=${json.result.saved}`);
    } catch (err: unknown) {
      setRebuildMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRebuilding(false);
    }
  }

  if (loading && !stats) {
    return <p className="text-sm text-text-muted font-mono">Loading LLM stats...</p>;
  }
  if (error) {
    return <p className="text-sm text-red-400 font-mono">{error}</p>;
  }
  if (!stats) return null;

  const maxVerdictCount = Math.max(1, ...stats.verdictDistribution.map((v) => v.count));
  const maxBucketCount = Math.max(1, ...stats.confidenceHistogram.map((v) => v.count));
  const maxStatusCount = Math.max(1, ...stats.statusCounts.map((v) => v.count));

  const disagreementPct = stats.disagreementRate.totalScored > 0
    ? Math.round((stats.disagreementRate.disagree / stats.disagreementRate.totalScored) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted font-mono">
          Last {stats.windowDays} days. {stats.disagreementRate.totalScored} scored by LLM
        </p>
        <div className="flex items-center gap-2">
          {rebuildMsg && <span className="text-xs text-text-muted font-mono">{rebuildMsg}</span>}
          <button
            type="button"
            onClick={rebuild}
            disabled={rebuilding}
            className="text-xs px-3 py-1 rounded border border-border-default text-text-muted hover:border-brand-green hover:text-brand-green font-mono disabled:opacity-50"
          >
            {rebuilding ? 'Rebuilding...' : 'Rebuild prompt now'}
          </button>
          <button type="button" onClick={load} className="p-1.5 rounded hover:bg-bg-elevated">
            <RefreshCw size={14} className={`text-text-muted ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-sm font-mono text-text-primary mb-3">Verdict distribution</h3>
          {stats.verdictDistribution.length === 0 ? (
            <p className="text-xs text-text-muted font-mono">No scored orders yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.verdictDistribution.map((v) => {
                const pct = Math.round((v.count / maxVerdictCount) * 100);
                const color = v.llm_verdict === 'AUTO_CREDIT' ? 'bg-green-500' :
                               v.llm_verdict === 'MANUAL_HOLD' ? 'bg-yellow-500' :
                               v.llm_verdict === 'REJECT' ? 'bg-red-500' :
                               'bg-text-muted';
                return (
                  <div key={v.llm_verdict} className="flex items-center gap-2">
                    <span className="text-xs text-text-muted font-mono w-24">{v.llm_verdict}</span>
                    <div className="flex-1 bg-bg-elevated rounded h-4 relative">
                      <div className={`${color} h-4 rounded`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-text-primary font-mono w-10 text-right">{v.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-sm font-mono text-text-primary mb-3">Confidence histogram</h3>
          {stats.confidenceHistogram.length === 0 ? (
            <p className="text-xs text-text-muted font-mono">No confidence data yet.</p>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {stats.confidenceHistogram.map((b) => {
                const pct = Math.round((b.count / maxBucketCount) * 100);
                return (
                  <div key={b.bucket} className="flex-1 flex flex-col items-center justify-end" title={`${b.bucket}: ${b.count}`}>
                    <span className="text-[10px] text-text-muted font-mono">{b.count}</span>
                    <div className="w-full bg-brand-green/60 rounded-t" style={{ height: `${pct}%` }} />
                    <span className="text-[10px] text-text-muted font-mono mt-1">{b.bucket}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-sm font-mono text-text-primary mb-3">Calibration signals</h3>
          <dl className="space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between">
              <dt className="text-text-muted">LLM-rule disagreements</dt>
              <dd className={disagreementPct > 30 ? 'text-yellow-400' : 'text-text-primary'}>
                {stats.disagreementRate.disagree} / {stats.disagreementRate.totalScored} ({disagreementPct}%)
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-text-muted">False AUTO_CREDIT (admin overrode)</dt>
              <dd className={stats.falseAutoCount > 0 ? 'text-red-400 font-bold' : 'text-text-primary'}>
                {stats.falseAutoCount}
              </dd>
            </div>
            <p className="text-xs text-text-muted mt-2 pt-2 border-t border-border-default">
              If disagreements are high, the rule-based verifier and LLM have divergent
              heuristics - tune the rule or prompt. If false AUTO_CREDIT is above 0, lower
              the AUTO_CREDIT threshold.
            </p>
          </dl>
        </div>

        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-sm font-mono text-text-primary mb-3">All QR orders by status</h3>
          <div className="space-y-1">
            {stats.statusCounts.map((s) => {
              const pct = Math.round((s.count / maxStatusCount) * 100);
              return (
                <div key={s.status} className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-mono w-32 ${statusBadge(s.status)}`}>{s.status}</span>
                  <div className="flex-1 bg-bg-elevated rounded h-3 relative">
                    <div className="bg-brand-green/50 h-3 rounded" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-text-primary font-mono w-10 text-right">{s.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminDepositDashboard() {
  const [subTab, setSubTab] = useState<SubTab>('queue');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b border-border-default">
        {([
          { id: 'queue', label: 'Review queue' },
          { id: 'all', label: 'All orders' },
          { id: 'stats', label: 'LLM stats' },
          { id: 'chains', label: 'Chain config' },
        ] as { id: SubTab; label: string }[]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={`px-4 py-2 text-sm font-mono border-b-2 transition ${
              subTab === t.id
                ? 'border-brand-green text-brand-green'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'queue' && <AdminQrReviewQueue />}
      {subTab === 'all' && <AllOrdersPanel />}
      {subTab === 'stats' && <LlmStatsPanel />}
      {subTab === 'chains' && <AdminChainConfig />}
    </div>
  );
}