'use client';
/**
 * =============================================================
 *  ADMIN WITHDRAWAL QUEUE - with risk scoring
 * =============================================================
 *
 *  Enhanced dashboard:
 *   - Per-row risk badge (low / medium / high / critical) with score
 *   - Sortable by risk score, amount, or date
 *   - Filter by minimum risk level (show me only high+critical)
 *   - Expandable detail panel showing every risk signal + reason
 *   - Approve / reject with reason
 *
 *  Multi-signal risk model (no single magic threshold):
 *    amount_band + account_age + history_ratio + recent_attempts
 *    + kyc_tier + geoip_mismatch + first_withdrawal
 *
 *  See services/withdrawal-risk.service.ts for the math.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Check,
  X,
  RefreshCw,
  Clock,
  AlertCircle,
  Loader2,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import EquivalentAmounts from '@/components/wallet/EquivalentAmounts';
import { getFxRates, type FxRatesResponse } from '@/lib/api/wallet';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

type Status = 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'all';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type SortKey = 'risk' | 'amount' | 'date';
type SortDir = 'asc' | 'desc';

interface RiskSignal {
  signal: string;
  weight: number;
  value: number;
  note: string;
}

interface Risk {
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
  suggestion: string;
  reasons: string[];
  computedAt: string;
}

interface WithdrawalEquivalent {
  usdt: number;
  usd: number;
  bdt: number;
}

interface Withdrawal {
  id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  amount: string | number;
  currency: string;
  status: string;
  ip_address: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  confirmed_at: string | null;
  risk?: Risk;
  equivalent?: WithdrawalEquivalent;
}

interface Stats {
  pending: number;
  confirmed: number;
  failed: number;
  total_confirmed: number;
  total_pending: number;
  today_total: number;
}

const RISK_COLORS: Record<RiskLevel, string> = {
  low: 'bg-green-500/15 text-green-400 border-green-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  critical: 'bg-red-500/20 text-red-400 border-red-500/40',
};

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function RiskBadge({ risk }: { risk: Risk | undefined }) {
  if (!risk) return <span className="text-text-muted text-[10px]">unscored</span>;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${RISK_COLORS[risk.level]}`}
      title={risk.reasons.join(' • ') || 'No risk signals'}
    >
      <ShieldAlert size={10} />
      {risk.level} · {risk.score}
    </span>
  );
}

export default function AdminWithdrawalQueue() {
  const [status, setStatus] = useState<Status>('pending');
  const [minRisk, setMinRisk] = useState<RiskLevel | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('risk');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [items, setItems] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [fxRates, setFxRates] = useState<FxRatesResponse | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { addToast } = useToast();

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/admin/withdrawals/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setStats(data.stats);
    } catch {
      /* ignore */
    }
  }, [token]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('status', status);
      params.set('limit', '200');
      if (minRisk) params.set('minRisk', minRisk);
      const res = await fetch(`${API}/admin/withdrawals?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setItems(data.withdrawals || []);
      } else {
        setError(data.error || 'Failed to load withdrawals');
      }
    } catch {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token, status, minRisk]);

  useEffect(() => {
    fetchItems();
    fetchStats();
    getFxRates().then(setFxRates).catch(() => { /* keep stale */ });
  }, [status, minRisk, fetchItems, fetchStats]);

  const approve = async (id: string) => {
    setActionId(id);
    try {
      const res = await fetch(`${API}/admin/withdrawals/${id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setItems((prev) =>
          prev.map((it) => (it.id === id ? { ...it, status: 'confirmed' } : it))
        );
        addToast(`Approved withdrawal ${id.slice(0, 8)}`, 'success');
        fetchStats();
      } else {
        setError(data.error || 'Approve failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setActionId(null);
    }
  };

  const reject = async (id: string) => {
    if (!rejectReason.trim()) return;
    setActionId(id);
    try {
      const res = await fetch(`${API}/admin/withdrawals/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: rejectReason }),
      });
      const data = await res.json();
      if (data.success) {
        setItems((prev) =>
          prev.map((it) => (it.id === id ? { ...it, status: 'failed' } : it))
        );
        addToast(`Rejected withdrawal ${id.slice(0, 8)}`, 'success');
        setRejectingId(null);
        setRejectReason('');
        fetchStats();
      } else {
        setError(data.error || 'Reject failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setActionId(null);
    }
  };

  const statusClass = (s: string) => {
    if (s === 'pending') return 'bg-amber-500/15 text-amber-400';
    if (s === 'confirmed') return 'bg-brand-green/15 text-brand-green';
    if (s === 'failed') return 'bg-brand-red/15 text-brand-red';
    if (s === 'cancelled') return 'bg-text-muted/15 text-text-muted';
    return 'bg-text-muted/15 text-text-muted';
  };

  const amount = (a: string | number) => (typeof a === 'string' ? parseFloat(a) : a);

  // Sort items
  const sortedItems = [...items].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'risk') {
      cmp = (a.risk?.score ?? 0) - (b.risk?.score ?? 0);
    } else if (sortKey === 'amount') {
      cmp = amount(a.amount) - amount(b.amount);
    } else {
      cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : '';

  return (
    <div className="glass-card overflow-hidden">
      {/* Header with stats */}
      {stats && (
        <div className="px-4 py-3 border-b border-border grid grid-cols-2 md:grid-cols-6 gap-3 text-xs font-mono">
          <div>
            <div className="text-text-muted">Pending</div>
            <div className="text-amber-400 text-lg font-bold">{stats.pending}</div>
          </div>
          <div>
            <div className="text-text-muted">Confirmed (all)</div>
            <div className="text-brand-green text-lg font-bold">{stats.confirmed}</div>
          </div>
          <div>
            <div className="text-text-muted">Rejected</div>
            <div className="text-brand-red text-lg font-bold">{stats.failed}</div>
          </div>
          <div>
            <div className="text-text-muted">Today total</div>
            <div className="text-text-primary text-lg font-bold">{stats.today_total}</div>
          </div>
          <div>
            <div className="text-text-muted">Pending amount</div>
            <div className="text-amber-400 text-lg font-bold">
              {parseFloat(String(stats.total_pending)).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-text-muted">Confirmed amount</div>
            <div className="text-brand-green text-lg font-bold">
              {parseFloat(String(stats.total_confirmed)).toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {(['pending', 'confirmed', 'failed', 'cancelled', 'all'] as Status[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded text-xs font-mono border transition-all ${
                status === s
                  ? 'bg-brand-maroon text-white border-brand-maroon'
                  : 'border-border text-text-secondary hover:border-brand-maroon/50'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-text-muted font-mono">Min risk:</span>
          <select
            value={minRisk ?? ''}
            onChange={(e) => setMinRisk((e.target.value || null) as RiskLevel | null)}
            className="bg-bg-elevated border border-border-default rounded px-2 py-1 text-xs font-mono text-text-primary"
          >
            <option value="">All</option>
            <option value="medium">≥ Medium</option>
            <option value="high">≥ High</option>
            <option value="critical">Critical only</option>
          </select>
          <button
            onClick={() => {
              fetchItems();
              fetchStats();
            }}
            disabled={loading}
            className="ml-2 p-1.5 rounded hover:bg-bg-elevated text-text-muted"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              <th className="px-4 py-2 font-mono font-normal">User</th>
              <th className="px-4 py-2 font-mono font-normal cursor-pointer select-none" onClick={() => {
                if (sortKey === 'amount') setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
                else { setSortKey('amount'); setSortDir('desc'); }
              }}>
                Amount ({fxRates ? 'USD + BDT' : 'USDT'}) {sortIcon('amount')}
              </th>
              <th className="px-4 py-2 font-mono font-normal">Status</th>
              <th className="px-4 py-2 font-mono font-normal cursor-pointer select-none" onClick={() => {
                if (sortKey === 'risk') setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
                else { setSortKey('risk'); setSortDir('desc'); }
              }}>
                Risk {sortIcon('risk')}
              </th>
              <th className="px-4 py-2 font-mono font-normal cursor-pointer select-none" onClick={() => {
                if (sortKey === 'date') setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
                else { setSortKey('date'); setSortDir('desc'); }
              }}>
                Requested {sortIcon('date')}
              </th>
              <th className="px-4 py-2 font-mono font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                  <Loader2 size={16} className="animate-spin inline mr-2" />
                  Loading...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-brand-red">
                  <AlertCircle size={14} className="inline mr-1" /> {error}
                </td>
              </tr>
            ) : sortedItems.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                  <Clock size={14} className="inline mr-1" /> No withdrawals match the filters.
                </td>
              </tr>
            ) : (
              sortedItems.map((w) => {
                const isExpanded = expandedId === w.id;
                const activeSignals = (w.risk?.signals ?? []).filter((s) => s.value > 0);
                return (
                  <>
                    <tr key={w.id} className="border-b border-border/50 hover:bg-white/2 align-top">
                      <td className="px-4 py-2.5">
                        <div className="text-text-primary">{w.username || w.user_id.slice(0, 8)}</div>
                        <div className="text-[10px] text-text-muted">{w.email || '-'}</div>
                        {w.ip_address && (
                          <div className="text-[10px] text-text-muted font-mono">
                            IP: {w.ip_address}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <EquivalentAmounts
                          amount={amount(w.amount)}
                          rates={fxRates?.rates}
                          compact={false}
                          freshLabel={false}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusClass(w.status)}`}
                        >
                          {w.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <RiskBadge risk={w.risk} />
                      </td>
                      <td className="px-4 py-2.5 text-text-muted">
                        {new Date(w.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : w.id)}
                            className="text-text-muted hover:text-text-primary p-1"
                            title="View risk signals"
                            aria-label={isExpanded ? 'Collapse risk signals' : 'Expand risk signals'}
                          >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                          {w.status === 'pending' && (
                            <>
                              {rejectingId === w.id ? (
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    placeholder="Reason"
                                    value={rejectReason}
                                    onChange={(e) => setRejectReason(e.target.value)}
                                    className="w-28 px-2 py-1 text-xs bg-void border border-brand-red/50 rounded"
                                    autoFocus
                                  />
                                  <button
                                    onClick={() => reject(w.id)}
                                    disabled={!rejectReason.trim() || actionId === w.id}
                                    className="text-brand-red disabled:opacity-40"
                                  >
                                    <Check size={13} />
                                  </button>
                                  <button
                                    onClick={() => {
                                      setRejectingId(null);
                                      setRejectReason('');
                                    }}
                                    className="text-text-muted"
                                  >
                                    <X size={13} />
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <button
                                    onClick={() => approve(w.id)}
                                    disabled={actionId === w.id}
                                    className="text-brand-green disabled:opacity-40 p-1"
                                    title="Approve"
                                  >
                                    {actionId === w.id ? (
                                      <Loader2 size={13} className="animate-spin" />
                                    ) : (
                                      <Check size={13} />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => setRejectingId(w.id)}
                                    className="text-brand-red p-1"
                                    title="Reject"
                                  >
                                    <X size={13} />
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && w.risk && (
                      <tr key={`${w.id}-risk`} className="bg-bg-elevated/30">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Risk signals */}
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-text-muted text-[10px] font-mono uppercase tracking-wider">
                                  Risk Signals ({activeSignals.length} active)
                                </h4>
                                <span className="text-[10px] text-text-muted font-mono">
                                  Total: <span className="text-text-primary font-bold">{w.risk.score}/100</span>
                                  <span className="mx-2">·</span>
                                  Suggestion:{' '}
                                  <span className="text-text-primary">{w.risk.suggestion.replace(/_/g, ' ')}</span>
                                </span>
                              </div>
                              <div className="space-y-1">
                                {w.risk.signals.map((s, i) => (
                                  <div
                                    key={i}
                                    className={`flex items-start gap-2 p-2 rounded text-[11px] ${
                                      s.value > 0
                                        ? 'bg-bg-elevated border border-border-default'
                                        : 'opacity-40'
                                    }`}
                                  >
                                    <div
                                      className={`w-1 self-stretch rounded ${
                                        s.value > 0 ? 'bg-amber-500' : 'bg-border-default'
                                      }`}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between">
                                        <span className="text-text-primary">
                                          {s.signal.replace(/_/g, ' ')}
                                        </span>
                                        <span className="text-text-muted font-mono">
                                          +{s.value}/{s.weight}
                                        </span>
                                      </div>
                                      <div className="text-text-muted">{s.note}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Reasons + actions */}
                            <div>
                              <h4 className="text-text-muted text-[10px] font-mono uppercase tracking-wider mb-2">
                                Summary
                              </h4>
                              <ul className="space-y-1 text-xs font-mono mb-3">
                                {w.risk.reasons.length === 0 ? (
                                  <li className="text-text-muted">No risk signals triggered - low risk.</li>
                                ) : (
                                  w.risk.reasons.map((r, i) => (
                                    <li key={i} className="text-text-primary flex items-start gap-1">
                                      <span className="text-amber-400 mt-0.5">▸</span> {r}
                                    </li>
                                  ))
                                )}
                              </ul>
                              <div className="border-t border-border pt-2 text-[10px] text-text-muted font-mono space-y-1">
                                <div>Risk level: <span className="text-text-primary">{w.risk.level}</span></div>
                                <div>Computed: <span className="text-text-primary">{new Date(w.risk.computedAt).toLocaleTimeString()}</span></div>
                                {w.ip_address && (
                                  <div>IP: <span className="text-text-primary font-mono">{w.ip_address}</span></div>
                                )}
                                {w.metadata?.memo && (
                                  <div>Memo: <span className="text-text-primary">{w.metadata.memo}</span></div>
                                )}
                                {w.metadata?.chain && (
                                  <div>Chain: <span className="text-text-primary font-mono">{w.metadata.chain}</span></div>
                                )}
                                {w.metadata?.currency && (
                                  <div>Currency: <span className="text-text-primary font-mono">{w.metadata.currency}</span></div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 border-t border-border text-[10px] text-text-muted font-mono">
        Showing {sortedItems.length} withdrawal{sortedItems.length === 1 ? '' : 's'}
        {minRisk && ` (min risk: ${minRisk})`}
      </div>
    </div>
  );
}
