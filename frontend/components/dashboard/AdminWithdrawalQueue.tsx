'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN WITHDRAWAL QUEUE — /api/admin/withdrawals UI
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Check, X, ArrowDownUp, RefreshCw, Clock, AlertCircle, Loader2 } from 'lucide-react';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type Status = 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'all';

interface Withdrawal {
  id: string;
  user_id: string;
  username: string;
  email: string | null;
  amount: string | number;
  currency: string;
  status: string;
  metadata: any;
  created_at: string;
  confirmed_at: string | null;
}

interface Stats {
  pending: number;
  confirmed: number;
  failed: number;
  total_confirmed: number;
  total_pending: number;
  today_total: number;
}

export default function AdminWithdrawalQueue() {
  const [status, setStatus] = useState<Status>('pending');
  const [items, setItems] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/admin/withdrawals/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setStats(data.stats);
    } catch { /* ignore */ }
  }, [token]);

  const fetchItems = useCallback(async (s: Status = status) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/withdrawals?status=${s}&limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setItems(data.withdrawals || []);
      } else {
        setError(data.error || 'Failed to load withdrawals');
      }
    } catch (e) {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token, status]);

  useEffect(() => {
    fetchItems();
    fetchStats();
  }, [status, fetchItems, fetchStats]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const approve = async (id: string) => {
    setActionId(id);
    try {
      const res = await fetch(`${API}/admin/withdrawals/${id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setItems(prev => prev.map(it => it.id === id ? { ...it, status: 'confirmed' } : it));
        showToast(`Approved withdrawal ${id.slice(0, 8)}`);
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
        setItems(prev => prev.map(it => it.id === id ? { ...it, status: 'failed' } : it));
        showToast(`Rejected withdrawal ${id.slice(0, 8)}`);
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

  const amount = (a: string | number) => typeof a === 'string' ? parseFloat(a) : a;

  return (
    <div className="glass-card overflow-hidden">
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2 rounded bg-brand-green text-black text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}

      {/* Header + Stats */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="heading-display text-sm text-text-primary">Withdrawal Queue</h3>
          <button
            onClick={() => { fetchItems(); fetchStats(); }}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              { label: 'Pending', value: stats.pending, color: 'text-amber-400' },
              { label: 'Approved', value: stats.confirmed, color: 'text-brand-green' },
              { label: 'Failed', value: stats.failed, color: 'text-brand-red' },
              { label: 'Today', value: stats.today_total, color: 'text-text-primary' },
            ].map(s => (
              <div key={s.label} className="px-3 py-2 rounded bg-void border border-border">
                <div className={`text-lg font-mono font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[10px] text-text-muted">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap gap-2">
        {(['pending', 'confirmed', 'failed', 'cancelled', 'all'] as Status[]).map(s => (
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

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              {['User', 'Amount', 'Status', 'Requested', 'Actions'].map(h => (
                <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">
                <Loader2 size={16} className="animate-spin inline mr-2" /> Loading...
              </td></tr>
            ) : error ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-brand-red">
                <AlertCircle size={14} className="inline mr-1" /> {error}
              </td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">
                <Clock size={14} className="inline mr-1" /> No withdrawals in this queue.
              </td></tr>
            ) : (
              items.map((w) => (
                <tr key={w.id} className="border-b border-border/50 hover:bg-white/2">
                  <td className="px-4 py-2.5">
                    <div className="text-text-primary">{w.username || w.user_id}</div>
                    <div className="text-[10px] text-text-muted">{w.email || w.currency}</div>
                  </td>
                  <td className="px-4 py-2.5 text-text-primary">
                    ${amount(w.amount).toFixed(2)} {w.currency}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusClass(w.status)}`}>
                      {w.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {new Date(w.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">
                    {w.status === 'pending' && (
                      <div className="flex items-center gap-2">
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
                              onClick={() => { setRejectingId(null); setRejectReason(''); }}
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
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-green/35 text-brand-green hover:bg-brand-green/10 disabled:opacity-40"
                            >
                              <Check size={11} /> Approve
                            </button>
                            <button
                              onClick={() => setRejectingId(w.id)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-red/35 text-brand-red hover:bg-brand-red/10"
                            >
                              <X size={11} /> Reject
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
