'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN AUDIT LOG VIEWER — /api/admin/audit/logs + /export
 *  Phase 2.6 — added filter controls + CSV export button.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { ScrollText, AlertTriangle, RefreshCw, Loader2, ChevronLeft, ChevronRight, Search, Download, X } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

type Tab = 'audit' | 'fraud';

interface AuditLog {
  id: string;
  user_id: string | null;
  username: string | null;
  email: string | null;
  category: string;
  action: string;
  severity: string;
  ip_address: string | null;
  user_agent: string | null;
  details: any;
  created_at: string;
}

interface FraudLog {
  id: string;
  user_id: string;
  username: string;
  type: string;
  ip_address: string;
  fingerprint: string;
  details: any;
  created_at: string;
}

const PAGE_SIZE = 25;
const SEVERITIES = ['debug', 'info', 'warn', 'error', 'critical'] as const;
const CATEGORIES = ['admin', 'bonus', 'fraud', 'kyc', 'withdrawal', 'wagering',
  'rain', 'payment', 'affiliate', 'support', 'security', 'system', 'config', 'auth'];
const SEVERITY_COLOR: Record<string, string> = {
  debug: 'bg-text-muted/20 text-text-muted',
  info: 'bg-blue-500/20 text-blue-300',
  warn: 'bg-brand-orange/20 text-brand-orange',
  error: 'bg-brand-red/20 text-brand-red',
  critical: 'bg-brand-red/40 text-brand-red',
};

export default function AdminAuditLogViewer() {
  const token = useGameStore((s) => s.token);
  const [tab, setTab] = useState<Tab>('audit');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [fraudLogs, setFraudLogs] = useState<FraudLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  // Phase 2.6 — filter state.
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [severity, setSeverity] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  const fetchLogs = useCallback(async (t: Tab = tab, o: number = offset) => {
    setLoading(true);
    setError(null);
    try {
      if (t === 'fraud') {
        // Existing fraud_logs endpoint — left as-is (no new filters here, surgical scope).
        const res = await fetch(`/api/admin/fraud-logs?limit=${PAGE_SIZE}&offset=${o}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.success) {
          setFraudLogs(data.logs || []);
          setTotal(data.pagination?.total || 0);
        } else {
          setError(data.error || 'Failed to load logs');
        }
      } else {
        // Audit logs — Phase 2.6: filter params forwarded to backend.
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(o),
        });
        if (q) params.set('q', q);
        if (category) params.set('category', category);
        if (severity) params.set('severity', severity);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const r: any = await api.get(`/admin/audit/logs?${params.toString()}`, token);
        if (r.success) {
          setAuditLogs(r.logs || []);
          setTotal(r.total || 0);
        } else {
          setError(r.error || 'Failed to load logs');
        }
      }
    } catch (e) {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token, tab, offset, q, category, severity, from, to]);

  // Phase 2.6 — rebuild CSV from current page (or first 1000 filtered rows).
  const exportCsv = async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams({ limit: '1000', offset: '0' });
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      if (severity) params.set('severity', severity);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/admin/audit/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setError(`CSV export failed: HTTP ${res.status}`); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError('CSV export failed');
    }
  };

  useEffect(() => {
    setOffset(0);
    fetchLogs(tab, 0);
  }, [tab, fetchLogs]);

  useEffect(() => {
    fetchLogs(tab, offset);
  }, [offset, fetchLogs]);

  const formatJson = (v: any) => JSON.stringify(v, null, 2).slice(0, 200);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="glass-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="heading-display text-sm text-text-primary">Audit & Fraud Logs</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTab('audit')}
              className={`px-3 py-1.5 rounded text-xs font-mono flex items-center gap-1.5 transition-all ${
                tab === 'audit'
                  ? 'bg-brand-maroon text-white'
                  : 'border border-border text-text-secondary hover:border-brand-maroon/50'
              }`}
            >
              <ScrollText size={12} /> Audit
            </button>
            <button
              onClick={() => setTab('fraud')}
              className={`px-3 py-1.5 rounded text-xs font-mono flex items-center gap-1.5 transition-all ${
                tab === 'fraud'
                  ? 'bg-brand-red text-white'
                  : 'border border-border text-text-secondary hover:border-brand-red/50'
              }`}
            >
              <AlertTriangle size={12} /> Fraud
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'audit' && (
            <button
              onClick={exportCsv}
              className="flex items-center gap-1.5 px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-brand-gold"
              title="Export filtered rows as CSV"
            >
              <Download size={13} /> CSV
            </button>
          )}
          <button
            onClick={() => fetchLogs(tab, offset)}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {/* ── Phase 2.6 filter row (audit tab only) ─────────── */}
      {tab === 'audit' && (
        <div className="px-4 py-2 border-b border-border bg-surface-2/30 flex flex-wrap gap-2 items-center text-xs">
          <div className="relative flex-1 min-w-[120px]">
            <Search size={12} className="absolute left-2 top-2.5 text-text-muted" />
            <input
              placeholder="Free text (action / details / IP / user)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full bg-surface border border-border rounded pl-7 pr-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
            />
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="bg-surface border border-border rounded px-2 py-1.5 text-xs">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}
            className="bg-surface border border-border rounded px-2 py-1.5 text-xs">
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-surface border border-border rounded px-2 py-1.5 text-xs" title="From date" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-surface border border-border rounded px-2 py-1.5 text-xs" title="To date" />
          <button
            onClick={() => { setOffset(0); fetchLogs(tab, 0); }}
            className="px-3 py-1.5 bg-brand-gold text-black rounded text-xs font-medium"
          >
            Apply
          </button>
          <button
            onClick={() => { setQ(''); setCategory(''); setSeverity(''); setFrom(''); setTo(''); setOffset(0); fetchLogs(tab, 0); }}
            className="flex items-center gap-1 px-2 py-1.5 text-text-muted hover:text-text-primary text-xs"
            title="Clear filters"
          >
            <X size={11} /> Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              {tab === 'audit' ? (
                <>
                  <th className="px-4 py-2 font-normal">Time</th>
                  <th className="px-4 py-2 font-normal">Category</th>
                  <th className="px-4 py-2 font-normal">Severity</th>
                  <th className="px-4 py-2 font-normal">Action</th>
                  <th className="px-4 py-2 font-normal">User / Admin</th>
                  <th className="px-4 py-2 font-normal">Details</th>
                  <th className="px-4 py-2 font-normal">IP</th>
                </>
              ) : (
                <>
                  <th className="px-4 py-2 font-normal">Time</th>
                  <th className="px-4 py-2 font-normal">User</th>
                  <th className="px-4 py-2 font-normal">Type</th>
                  <th className="px-4 py-2 font-normal">IP</th>
                  <th className="px-4 py-2 font-normal">Fingerprint</th>
                  <th className="px-4 py-2 font-normal">Details</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                <Loader2 size={16} className="animate-spin inline mr-2" /> Loading...
              </td></tr>
            ) : error ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-brand-red">{error}</td></tr>
            ) : (tab === 'audit' ? auditLogs : fraudLogs).length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No logs found.</td></tr>
            ) : (
              tab === 'audit' ? auditLogs.map((log) => (
                <tr key={log.id} className="border-b border-border/50 hover:bg-white/2">
                  <td className="px-4 py-2.5 text-text-muted">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5"><span className="px-1.5 py-0.5 rounded bg-surface-2 text-[10px]">{log.category}</span></td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${SEVERITY_COLOR[log.severity] || 'bg-surface-2 text-text-muted'}`}>
                      {log.severity}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-primary">{log.action}</td>
                  <td className="px-4 py-2.5 text-text-primary">
                    {log.username ?? <span className="text-text-muted">system</span>}
                    {log.email && <div className="text-text-muted text-[10px]">{log.email}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-text-muted max-w-xs truncate" title={formatJson(log.details)}>
                    {formatJson(log.details)}
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{log.ip_address ?? '—'}</td>
                </tr>
              )) : fraudLogs.map((log) => (
                <tr key={log.id} className="border-b border-border/50 hover:bg-white/2">
                  <td className="px-4 py-2.5 text-text-muted">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-text-primary">{log.username || log.user_id}</td>
                  <td className="px-4 py-2.5 text-brand-red">{log.type}</td>
                  <td className="px-4 py-2.5 text-text-muted">{log.ip_address}</td>
                  <td className="px-4 py-2.5 text-text-muted truncate max-w-xs">{log.fingerprint}</td>
                  <td className="px-4 py-2.5 text-text-muted truncate max-w-xs" title={formatJson(log.details)}>{formatJson(log.details)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-3">
        <div className="text-xs text-text-muted">{total} total logs</div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
            disabled={offset <= 0}
            className="px-2 py-1 rounded border border-border text-text-secondary disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs text-text-muted">Page {page} / {totalPages || 1}</span>
          <button
            onClick={() => setOffset(o => Math.min(total - PAGE_SIZE, o + PAGE_SIZE))}
            disabled={offset + PAGE_SIZE >= total}
            className="px-2 py-1 rounded border border-border text-text-secondary disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
