'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN KYC REVIEW PANEL — review user KYC submissions
 * ═══════════════════════════════════════════════════════════════
 *
 *  Lists all KYC submissions and lets super_admin approve/reject.
 *  Reads from /api/kyc (status) and a simple admin-list endpoint.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Check, X, Loader2, Shield, ChevronLeft, ChevronRight } from 'lucide-react';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface KycSubmission {
  user_id: string;
  username: string;
  email: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  provider: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export default function AdminKycReviewPanel() {
  const [items, setItems] = useState<KycSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'expired'>('pending');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;
  const [actionId, setActionId] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
        limit: String(limit),
      });
      const res = await fetch(`${API}/kyc/admin/list?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setItems(data.data || []);
        setTotal(data.pagination?.total || 0);
      } else {
        setError(data.error || 'Failed to load KYC submissions');
      }
    } catch {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token, statusFilter, page]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const decide = async (userId: string, decision: 'approve' | 'reject') => {
    setActionId(userId);
    try {
      const res = await fetch(`${API}/kyc/admin/${decision}/${userId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        fetchItems();
      } else {
        setError(data.error || 'Failed to update');
      }
    } catch {
      setError('Network error');
    }
    setActionId(null);
  };

  const statusBadge = (s: KycSubmission['status']) => {
    const map: Record<KycSubmission['status'], string> = {
      pending:        'bg-brand-gold/15 text-brand-gold',
      approved:       'bg-brand-green/15 text-brand-green',
      rejected:       'bg-brand-red/15 text-brand-red',
      expired:        'bg-text-muted/15 text-text-muted',
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${map[s]}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {s.replace('_', ' ')}
      </span>
    );
  };

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-brand-info" />
          <h3 className="heading-display text-sm text-text-primary">KYC Review Queue</h3>
        </div>
        <div className="flex items-center gap-2">
          {(['pending', 'approved', 'rejected', 'expired', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-3 py-1 rounded text-xs font-mono ${
                statusFilter === s
                  ? 'bg-brand-maroon text-white'
                  : 'border border-border text-text-secondary hover:border-brand-maroon/50'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              {['User', 'Email', 'Status', 'Provider', 'Submitted', 'Actions'].map(h => (
                <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                <Loader2 className="inline animate-spin mr-2" size={14} />Loading…
              </td></tr>
            ) : error ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-brand-red">{error}</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No KYC submissions.</td></tr>
            ) : (
              items.map((k) => (
                <tr key={k.user_id} className="border-b border-border/50 hover:bg-white/2">
                  <td className="px-4 py-2.5 text-text-primary">{k.username}</td>
                  <td className="px-4 py-2.5 text-text-muted">{k.email || '—'}</td>
                  <td className="px-4 py-2.5">{statusBadge(k.status)}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{k.provider || '—'}</td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {k.created_at ? new Date(k.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {k.status === 'pending' ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => decide(k.user_id, 'approve')}
                          disabled={actionId === k.user_id}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-green/40 text-brand-green hover:bg-brand-green/10"
                        >
                          <Check size={11} /> Approve
                        </button>
                        <button
                          onClick={() => decide(k.user_id, 'reject')}
                          disabled={actionId === k.user_id}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-red/40 text-brand-red hover:bg-brand-red/10"
                        >
                          <X size={11} /> Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs font-mono">
          <span className="text-text-muted">
            {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1 rounded border border-border disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-text-muted">{page} / {Math.ceil(total / limit)}</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="p-1 rounded border border-border disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}