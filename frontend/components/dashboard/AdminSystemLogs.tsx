'use client';
/**
 * =============================================================
 *  ADMIN SYSTEM LOGS VIEWER
 * =============================================================
 *  Filterable list with aggregations sidebar.
 *  - Free-text search across action + details JSONB + ip_address
 *  - Filter by user, category (multi), action, severity (multi), date range
 *  - Aggregations: counts by category, severity, top actions/users, 7-day timeline
 *  - Click row to see full details + JSON viewer for `details`
 *  - Admin can add compliance notes to any row
 *  - Export filtered results as CSV
 *
 *  Auto-refreshes every 10s by default; pause button to stop.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileText, Loader2, RefreshCw, Search, X, ChevronDown, ChevronUp, AlertCircle,
  Download, Pause, Play, Save, Eye,
} from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface AuditLog {
  id: string;
  user_id: string | null;
  username: string | null;
  email: string | null;
  category: string;
  action: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, any> | null;
  admin_notes: string | null;
  admin_notes_by: string | null;
  admin_notes_at: string | null;
  created_at: string;
}

interface StatBucket { category?: string; severity?: string; action?: string; user_id?: string; username?: string; n: number; day?: string; }
interface UserEntry { id: string; username: string; email: string | null; log_count: number; last_log_at: string; }

const CATEGORIES = ['admin', 'auth', 'security', 'config', 'system',
  'bonus', 'withdrawal', 'wagering', 'rain', 'payment', 'affiliate', 'fraud', 'support'];
const SEVERITIES = ['debug', 'info', 'warn', 'error', 'critical'];
const SEVERITY_COLORS: Record<string, string> = {
  debug: 'bg-text-muted/20 text-text-muted',
  info: 'bg-blue-500/20 text-blue-400',
  warn: 'bg-amber-500/20 text-amber-400',
  error: 'bg-orange-500/20 text-orange-400',
  critical: 'bg-red-500/20 text-red-400',
};

export default function AdminSystemLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [severities, setSeverities] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Aggregations
  const [stats, setStats] = useState<{
    byCategory: StatBucket[];
    bySeverity: StatBucket[];
    topActions: StatBucket[];
    topUsers: StatBucket[];
    timeline: StatBucket[];
  } | null>(null);
  const [knownUsers, setKnownUsers] = useState<UserEntry[]>([]);

  // Detail view
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<Record<string, string>>({});

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(true);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Build query string from filters
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', String(pageSize));
    params.set('offset', String(page * pageSize));
    if (q) params.set('q', q);
    if (userId) params.set('user_id', userId);
    if (categories.length > 0) params.set('category', categories.join(','));
    if (actionFilter) params.set('action', actionFilter);
    if (severities.length > 0) params.set('severity', severities.join(','));
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(to).toISOString());
    return params.toString();
  }, [q, userId, categories, actionFilter, severities, from, to, page]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/admin/audit/logs?${queryString}`, { headers });
      const j = await r.json();
      if (j.success) {
        setLogs(j.logs);
        setTotal(j.total);
      } else {
        setError(j.error || 'Failed to load');
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [queryString]);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/audit/stats`, { headers });
      const j = await r.json();
      if (j.success) setStats(j);
    } catch { /* silent */ }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/audit/users`, { headers });
      const j = await r.json();
      if (j.success) setKnownUsers(j.users);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => { loadStats(); loadUsers(); }, [loadStats, loadUsers]);

  // Auto-refresh every 10s
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      loadLogs();
      loadStats();
    }, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, loadLogs, loadStats]);

  function toggleCategory(c: string) {
    setPage(0);
    setCategories((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }
  function toggleSeverity(s: string) {
    setPage(0);
    setSeverities((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  }
  function clearFilters() {
    setQ('');
    setUserId('');
    setCategories([]);
    setActionFilter('');
    setSeverities([]);
    setFrom('');
    setTo('');
    setPage(0);
  }

  async function exportCsv() {
    try {
      const r = await fetch(`${API}/admin/audit/export?${queryString}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(`Export failed: ${(e as Error).message}`);
    }
  }

  async function saveNote(logId: string) {
    const note = (editingNotes[logId] || '').trim();
    if (!note) return;
    try {
      const r = await fetch(`${API}/admin/audit/logs/${logId}/notes`, {
        method: 'POST', headers, body: JSON.stringify({ note }),
      });
      const j = await r.json();
      if (j.success) {
        // Update local state
        setLogs((prev) => prev.map((l) => l.id === logId ? {
          ...l,
          admin_notes: j.log.admin_notes,
          admin_notes_at: j.log.admin_notes_at,
          admin_notes_by: j.log.admin_notes_by,
        } : l));
        setEditingNotes((prev) => ({ ...prev, [logId]: '' }));
      } else {
        setError(j.error || 'Failed to save note');
      }
    } catch (e: unknown) {
      setError(`Save note failed: ${(e as Error).message}`);
    }
  }

  const totalPages = Math.ceil(total / pageSize);
  const hasFilters = q || userId || categories.length > 0 || actionFilter || severities.length > 0 || from || to;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      {/* Main: log list */}
      <div className="space-y-3">
        {/* Filter bar */}
        <div className="glass-card p-3 rounded-xl space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Search action, details JSON, or IP address..."
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
                className="w-full pl-8 pr-3 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
              />
            </div>
            <input
              type="text"
              placeholder="user_id (UUID)"
              value={userId}
              onChange={(e) => { setUserId(e.target.value); setPage(0); }}
              className="w-48 px-2 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
            />
            <input
              type="text"
              placeholder="action"
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
              className="w-32 px-2 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
            />
            <button
              onClick={loadLogs}
              disabled={loading}
              className="p-1.5 rounded hover:bg-bg-elevated text-text-muted"
              title="Refresh now"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`p-1.5 rounded ${autoRefresh ? 'bg-brand-green/20 text-brand-green' : 'text-text-muted'}`}
              title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
            >
              {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={exportCsv}
              className="flex items-center gap-1 px-2 py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-elevated/70 text-xs font-mono"
              title="Export filtered logs as CSV"
            >
              <Download size={14} /> CSV
            </button>
          </div>

          {/* Category + Severity pills */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              <span className="text-text-muted font-mono">category:</span>
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => toggleCategory(c)}
                  className={`px-2 py-0.5 rounded font-mono text-[10px] border transition ${
                    categories.includes(c)
                      ? 'bg-brand-green/20 text-brand-green border-brand-green/40'
                      : 'bg-bg-elevated text-text-muted border-border hover:text-text-primary'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              <span className="text-text-muted font-mono">severity:</span>
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  onClick={() => toggleSeverity(s)}
                  className={`px-2 py-0.5 rounded font-mono text-[10px] border transition ${
                    severities.includes(s)
                      ? SEVERITY_COLORS[s] + ' border-current'
                      : 'bg-bg-elevated text-text-muted border-border hover:text-text-primary'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => { setFrom(e.target.value); setPage(0); }}
                className="px-2 py-0.5 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
                title="From (inclusive)"
              />
              <span className="text-text-muted">→</span>
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => { setTo(e.target.value); setPage(0); }}
                className="px-2 py-0.5 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
                title="To (inclusive)"
              />
              {hasFilters && (
                <button
                  onClick={clearFilters}
                  className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded text-text-muted hover:text-text-primary font-mono text-[10px]"
                >
                  <X size={10} /> clear
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
            <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
            <span className="text-red-300 text-sm">{error}</span>
          </div>
        )}

        {/* Results table */}
        <div className="glass-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border text-xs text-text-muted font-mono flex items-center justify-between">
            <span>{loading ? 'Loading...' : `${total.toLocaleString()} match${total === 1 ? '' : 'es'}`} {hasFilters ? '(filtered)' : ''}</span>
            {totalPages > 1 && (
              <span>page {page + 1} / {totalPages}</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted text-left">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">IP</th>
                  <th className="px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {loading && logs.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted">
                    <Loader2 size={16} className="animate-spin inline mr-2" /> Loading...
                  </td></tr>
                ) : logs.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted">
                    <FileText size={14} className="inline mr-1" /> No audit logs match.
                  </td></tr>
                ) : (
                  logs.map((log) => {
                    const isExpanded = expandedId === log.id;
                    return (
                      <>
                        <tr
                          key={log.id}
                          className="border-b border-border/50 hover:bg-bg-elevated/30 cursor-pointer"
                          onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        >
                          <td className="px-3 py-2 text-text-muted">
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${SEVERITY_COLORS[log.severity]}`}>
                              {log.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-text-primary">{log.category}</td>
                          <td className="px-3 py-2 text-text-secondary">{log.action}</td>
                          <td className="px-3 py-2 text-text-muted">
                            {log.username || (log.user_id ? log.user_id.slice(0, 8) + '...' : '—')}
                          </td>
                          <td className="px-3 py-2 text-text-muted text-[10px]">{log.ip_address || '—'}</td>
                          <td className="px-3 py-2 text-text-muted text-[10px]">{new Date(log.created_at).toLocaleString()}</td>
                        </tr>
                        {isExpanded && (
                          <tr key={log.id + '-detail'} className="bg-bg-elevated/30">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Details JSON */}
                                <div>
                                  <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">Details</h4>
                                  {log.details && Object.keys(log.details).length > 0 ? (
                                    <pre className="p-3 bg-bg-elevated rounded font-mono text-xs text-text-secondary overflow-x-auto max-h-64 overflow-y-auto">
                                      {JSON.stringify(log.details, null, 2)}
                                    </pre>
                                  ) : (
                                    <p className="text-text-muted text-xs font-mono">No details recorded.</p>
                                  )}
                                </div>
                                {/* Notes + meta */}
                                <div>
                                  <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">Compliance note</h4>
                                  {log.admin_notes ? (
                                    <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded">
                                      <p className="text-text-primary text-xs font-mono whitespace-pre-wrap">{log.admin_notes}</p>
                                      <p className="text-text-muted text-[10px] font-mono mt-2">
                                        by {log.admin_notes_by?.slice(0, 8)} at {log.admin_notes_at ? new Date(log.admin_notes_at).toLocaleString() : '?'}
                                      </p>
                                    </div>
                                  ) : null}
                                  <textarea
                                    placeholder="Add a compliance note (visible to all admins)..."
                                    value={editingNotes[log.id] || ''}
                                    onChange={(e) => setEditingNotes((prev) => ({ ...prev, [log.id]: e.target.value }))}
                                    rows={3}
                                    className="mt-2 w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  <button
                                    onClick={(e) => { e.stopPropagation(); saveNote(log.id); }}
                                    disabled={!(editingNotes[log.id] || '').trim()}
                                    className="mt-2 flex items-center gap-1 px-3 py-1 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-xs font-mono disabled:opacity-30"
                                  >
                                    <Save size={12} /> Save note
                                  </button>
                                  <div className="mt-3 text-[10px] text-text-muted font-mono space-y-1">
                                    <div>Log ID: <span className="text-text-primary">{log.id}</span></div>
                                    <div>User ID: <span className="text-text-primary">{log.user_id || '—'}</span></div>
                                    <div>IP: <span className="text-text-primary">{log.ip_address || '—'}</span></div>
                                    <div>User agent: <span className="text-text-primary truncate inline-block max-w-xs">{log.user_agent || '—'}</span></div>
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
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-2 border-t border-border text-xs font-mono flex items-center justify-center gap-2">
              <button
                onClick={() => setPage(0)}
                disabled={page === 0}
                className="px-2 py-0.5 rounded text-text-muted hover:text-text-primary disabled:opacity-30"
              >
                « first
              </button>
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="px-2 py-0.5 rounded text-text-muted hover:text-text-primary disabled:opacity-30"
              >
                ‹ prev
              </button>
              <span className="text-text-muted">{page + 1} / {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded text-text-muted hover:text-text-primary disabled:opacity-30"
              >
                next ›
              </button>
              <button
                onClick={() => setPage(totalPages - 1)}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded text-text-muted hover:text-text-primary disabled:opacity-30"
              >
                last »
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar: aggregations */}
      <div className="space-y-3">
        {/* Counts by category */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">By category (7d)</h4>
          <div className="space-y-1">
            {(stats?.byCategory || []).map((b: any) => (
              <button
                key={b.category}
                onClick={() => { toggleCategory(b.category); }}
                className="flex items-center justify-between w-full px-2 py-1 rounded hover:bg-bg-elevated text-left"
              >
                <span className="text-text-primary text-xs font-mono">{b.category}</span>
                <span className="text-text-muted text-xs font-mono">{b.n}</span>
              </button>
            ))}
            {(!stats?.byCategory || stats.byCategory.length === 0) && (
              <p className="text-text-muted text-xs">No data</p>
            )}
          </div>
        </div>

        {/* Counts by severity */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">By severity (7d)</h4>
          <div className="space-y-1">
            {(stats?.bySeverity || []).map((b: any) => (
              <button
                key={b.severity}
                onClick={() => { toggleSeverity(b.severity); }}
                className="flex items-center justify-between w-full px-2 py-1 rounded hover:bg-bg-elevated text-left"
              >
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${SEVERITY_COLORS[b.severity]}`}>{b.severity}</span>
                <span className="text-text-muted text-xs font-mono">{b.n}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Top actions */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">Top actions (7d)</h4>
          <div className="space-y-1">
            {(stats?.topActions || []).map((b: any) => (
              <button
                key={b.action}
                onClick={() => { setActionFilter(b.action); setPage(0); }}
                className="flex items-center justify-between w-full px-2 py-1 rounded hover:bg-bg-elevated text-left"
              >
                <span className="text-text-primary text-xs font-mono truncate">{b.action}</span>
                <span className="text-text-muted text-xs font-mono">{b.n}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Top users */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">Top users (7d)</h4>
          <div className="space-y-1">
            {(stats?.topUsers || []).map((u: any) => (
              <button
                key={u.user_id}
                onClick={() => { setUserId(u.user_id); setPage(0); }}
                className="flex items-center justify-between w-full px-2 py-1 rounded hover:bg-bg-elevated text-left"
              >
                <span className="text-text-primary text-xs font-mono truncate">{u.username || u.user_id?.slice(0, 8)}</span>
                <span className="text-text-muted text-xs font-mono">{u.n}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 7-day timeline */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2">Activity (7d)</h4>
          <div className="flex items-end gap-1 h-20">
            {(stats?.timeline || []).map((t: any) => {
              const max = Math.max(1, ...((stats?.timeline || []).map((x: any) => x.n)));
              const h = (t.n / max) * 100;
              return (
                <div key={t.day} className="flex-1 flex flex-col items-center gap-1" title={`${t.day.slice(0, 10)}: ${t.n} events`}>
                  <div className="w-full bg-brand-green/40 rounded-t" style={{ height: `${h}%` }} />
                  <span className="text-[9px] text-text-muted font-mono">{t.day.slice(5, 10)}</span>
                </div>
              );
            })}
            {(!stats?.timeline || stats.timeline.length === 0) && (
              <p className="text-text-muted text-xs">No activity</p>
            )}
          </div>
        </div>

        {/* Known users (filter dropdown alt) */}
        <div className="glass-card p-3 rounded-xl">
          <h4 className="text-text-muted font-mono text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1">
            <Eye size={10} /> Active users ({knownUsers.length})
          </h4>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {knownUsers.slice(0, 20).map((u) => (
              <button
                key={u.id}
                onClick={() => { setUserId(u.id); setPage(0); }}
                className="flex items-center justify-between w-full px-2 py-1 rounded hover:bg-bg-elevated text-left text-[10px] font-mono"
                title={u.email || ''}
              >
                <span className="text-text-primary truncate">{u.username}</span>
                <span className="text-text-muted">{u.log_count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}