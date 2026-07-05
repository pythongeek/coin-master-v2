'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN AUDIT LOG VIEWER — /api/admin/audit-logs + /api/admin/fraud-logs
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { ScrollText, AlertTriangle, RefreshCw, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type Tab = 'audit' | 'fraud';

interface AuditLog {
  id: string;
  table_name: string;
  record_id: string;
  action: string;
  old_data: any;
  new_data: any;
  changed_by: string;
  changed_by_username: string;
  ip_address: string;
  user_agent: string;
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

export default function AdminAuditLogViewer() {
  const [tab, setTab] = useState<Tab>('audit');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [fraudLogs, setFraudLogs] = useState<FraudLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchLogs = useCallback(async (t: Tab = tab, o: number = offset) => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = t === 'audit' ? 'audit-logs' : 'fraud-logs';
      const res = await fetch(`${API}/admin/${endpoint}?limit=${PAGE_SIZE}&offset=${o}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        if (t === 'audit') setAuditLogs(data.logs || []);
        else setFraudLogs(data.logs || []);
        setTotal(data.pagination?.total || 0);
      } else {
        setError(data.error || 'Failed to load logs');
      }
    } catch (e) {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token, tab, offset]);

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
        <button
          onClick={() => fetchLogs(tab, offset)}
          className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              {tab === 'audit' ? (
                <>
                  <th className="px-4 py-2 font-normal">Time</th>
                  <th className="px-4 py-2 font-normal">Admin</th>
                  <th className="px-4 py-2 font-normal">Action</th>
                  <th className="px-4 py-2 font-normal">Table</th>
                  <th className="px-4 py-2 font-normal">Changes</th>
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
                  <td className="px-4 py-2.5 text-text-primary">{log.changed_by_username || log.changed_by}</td>
                  <td className="px-4 py-2.5 text-text-primary">{log.action}</td>
                  <td className="px-4 py-2.5 text-text-muted">{log.table_name}</td>
                  <td className="px-4 py-2.5 text-text-muted max-w-xs truncate" title={formatJson({ old: log.old_data, new: log.new_data })}>
                    {formatJson({ old: log.old_data, new: log.new_data })}
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{log.ip_address}</td>
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
