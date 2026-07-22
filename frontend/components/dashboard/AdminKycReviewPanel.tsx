'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN KYC REVIEW PANEL — review user KYC submissions
 * ═══════════════════════════════════════════════════════════════
 *
 *  Lists KYC sessions from /api/kyc/admin/list and lets super_admin
 *  approve/reject with a note. Updated for the custom MiniMax flow.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Check, X, Loader2, Shield, ChevronLeft, ChevronRight, Eye, FileText } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface KycSession {
  id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'review' | 'rejected';
  risk_score: number | null;
  risk_tier: string | null;
  final_decision: string | null;
  document_valid: boolean | null;
  face_match: boolean | null;
  face_similarity: number | null;
  liveness_passed: boolean | null;
  sanctions_clear: boolean | null;
  extracted_fields: Record<string, string | undefined> | null;
  fraud_signals: string[] | null;
  compliance_reasoning: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  completed_at: string | null;
  // P3-2e: deepfake risk signal (enriched server-side in /kyc/admin/list)
  deepfake?: {
    score: number | null;
    checked_at: string | null;
    status: 'not_run' | 'ok' | 'error' | 'skipped' | 'timeout';
    threshold: number;
    enabled: boolean;
  } | null;
}

export default function AdminKycReviewPanel() {
  const [items, setItems] = useState<KycSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'review' | 'rejected'>('review');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;
  const [actionId, setActionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KycSession | null>(null);
  const [note, setNote] = useState('');

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (statusFilter !== 'all') params.set('status', statusFilter);
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

  const decide = async (sessionId: string, decision: 'approved' | 'rejected') => {
    setActionId(sessionId);
    try {
      const res = await fetch(`${API}/kyc/admin/review/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision, note }),
      });
      const data = await res.json();
      if (data.success) {
        setNote('');
        setDetail(null);
        fetchItems();
      } else {
        setError(data.error || 'Failed to update');
      }
    } catch {
      setError('Network error');
    }
    setActionId(null);
  };

  const statusBadge = (s: KycSession['status']) => {
    const map: Record<KycSession['status'], string> = {
      pending: 'bg-brand-gold/15 text-brand-gold',
      approved: 'bg-brand-green/15 text-brand-green',
      review: 'bg-brand-info/15 text-brand-info',
      rejected: 'bg-brand-red/15 text-brand-red',
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
          {(['review', 'pending', 'approved', 'rejected', 'all'] as const).map((s) => (
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
              {['Session', 'Status', 'Risk', 'Face', 'Liveness', 'Deepfake', 'Submitted', 'Actions'].map(h => (
                <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-text-muted">
                <Loader2 className="inline animate-spin mr-2" size={14} />Loading…
              </td></tr>
            ) : error ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-brand-red">{error}</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-text-muted">No KYC submissions.</td></tr>
            ) : (
              items.map((k) => (
                <tr key={k.id} className="border-b border-border/50 hover:bg-white/2">
                  <td className="px-4 py-2.5 text-text-primary font-mono text-[10px]">{k.id.slice(0, 8)}…</td>
                  <td className="px-4 py-2.5">{statusBadge(k.status)}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{k.risk_score ?? '—'} <span className="text-text-muted">{k.risk_tier ?? ''}</span></td>
                  <td className="px-4 py-2.5 text-text-secondary">{k.face_match === null ? '—' : k.face_match ? '✅' : '❌'} {k.face_similarity ? `(${(k.face_similarity * 100).toFixed(0)}%)` : ''}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{k.liveness_passed === null ? '—' : k.liveness_passed ? '✅' : '❌'}</td>
                  <td className="px-4 py-2.5">
                    <DeepfakeCell s={k.deepfake ?? null} />
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">
                    {k.created_at ? new Date(k.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setDetail(k)}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-border text-text-secondary hover:border-brand-info/50"
                      >
                        <Eye size={11} /> Details
                      </button>
                      {(k.status === 'review' || k.status === 'pending') && (
                        <>
                          <button
                            onClick={() => decide(k.id, 'approved')}
                            disabled={actionId === k.id}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-green/40 text-brand-green hover:bg-brand-green/10"
                          >
                            <Check size={11} /> Approve
                          </button>
                          <button
                            onClick={() => decide(k.id, 'rejected')}
                            disabled={actionId === k.id}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-brand-red/40 text-brand-red hover:bg-brand-red/10"
                          >
                            <X size={11} /> Reject
                          </button>
                        </>
                      )}
                    </div>
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

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="glass-card max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="heading-display text-sm text-text-primary">KYC Session Details</h3>
              <button onClick={() => setDetail(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="text-xs font-mono space-y-2 text-text-secondary">
              <div>Session ID: <span className="text-text-primary">{detail.id}</span></div>
              <div>User ID: <span className="text-text-primary">{detail.user_id}</span></div>
              <div>Status: {statusBadge(detail.status)}</div>
              <div>Risk: {detail.risk_score ?? '—'} ({detail.risk_tier ?? '—'})</div>
              <div>Document valid: {detail.document_valid === null ? '—' : detail.document_valid ? 'Yes' : 'No'}</div>
              <div>Face match: {detail.face_match === null ? '—' : detail.face_match ? 'Yes' : 'No'} {detail.face_similarity ? `(${(detail.face_similarity * 100).toFixed(1)}%)` : ''}</div>
              <div>Liveness: {detail.liveness_passed === null ? '—' : detail.liveness_passed ? 'Yes' : 'No'}</div>
              <div>Sanctions: {detail.sanctions_clear === null ? '—' : detail.sanctions_clear ? 'Clear' : 'Flag'}</div>
              <div>
                Extracted fields:
                <pre className="mt-1 p-2 rounded bg-black/30 text-[10px] overflow-auto">
                  {JSON.stringify(detail.extracted_fields, null, 2)}
                </pre>
              </div>
              <div>
                Fraud signals:
                <ul className="list-disc list-inside text-[10px] text-text-muted">
                  {(detail.fraud_signals || []).map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
              <div>
                Reasoning:
                <p className="mt-1 p-2 rounded bg-black/30 text-[10px] whitespace-pre-wrap">{detail.compliance_reasoning || '—'}</p>
              </div>
            </div>

            {(detail.status === 'review' || detail.status === 'pending') && (
              <div className="space-y-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Admin note (optional)"
                  className="input-cyber w-full text-xs h-20"
                />
                <div className="flex items-center gap-2">
                  <button onClick={() => decide(detail.id, 'approved')} disabled={actionId === detail.id} className="btn-primary text-xs px-3 py-1.5">
                    <Check size={11} className="inline mr-1" /> Approve
                  </button>
                  <button onClick={() => decide(detail.id, 'rejected')} disabled={actionId === detail.id} className="btn-secondary text-xs px-3 py-1.5">
                    <X size={11} className="inline mr-1" /> Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * P3-2e — Deepfake cell rendering.
 * Color codes: green (clean), red (above threshold), muted (no check yet
 * or error). Tooltip explains the threshold source.
 */
function DeepfakeCell({
  s,
}: {
  s: {
    score: number | null;
    checked_at: string | null;
    status: string;
    threshold: number;
    enabled: boolean;
  } | null;
}) {
  if (!s || !s.enabled) {
    return <span className="text-text-muted text-[10px]">—</span>;
  }
  if (s.status !== 'ok' || s.score === null) {
    return (
      <span className="text-text-muted text-[10px]" title={`status=${s.status}`}>
        {s.status}
      </span>
    );
  }
  const above = s.score >= s.threshold;
  const ageStr = s.checked_at
    ? new Date(s.checked_at).toLocaleDateString()
    : '—';
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] ${
        above ? 'bg-brand-red/20 text-brand-red' : 'bg-brand-green/20 text-brand-green'
      }`}
      title={`score=${s.score.toFixed(2)} threshold=${s.threshold} checked=${ageStr}`}
    >
      {s.score.toFixed(2)} {above ? '⚠' : '✓'}
    </span>
  );
}
