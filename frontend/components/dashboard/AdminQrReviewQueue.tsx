'use client';
/**
 * =============================================================
 *  ADMIN QR REVIEW QUEUE - held deposit orders awaiting decision
 * =============================================================
 *
 *  Shows all QR orders in 'verifying' state (held by AI for review).
 *  Admin can RELEASE (credit the user) or REJECT (mark failed, no credit).
 *  Every decision writes to payment_review_decisions for the feedback loop.
 *
 *  Used by /admin/payments/deposits page.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, RefreshCw, Clock, AlertCircle, Loader2, ExternalLink, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface ReviewItem {
  id: string;
  merchant_order_id: string;
  user_id: string;
  username: string | null;
  amount_usdt: number;
  amount_coins: number;
  qr_memo: string;
  chain: string;
  receive_address: string;
  detected_tx_hash: string | null;
  detected_at: string | null;
  created_at: string;
  expires_at: string;
  llm_verdict: string | null;
  llm_confidence: number | null;
  llm_reason: string | null;
  llm_model_version: string | null;
  rule_verdict: string | null;
  rule_disagreement: boolean | null;
  admin_hold_reason: string | null;
  receipt_uploaded: boolean;
  review_age_sec: number;
}

function formatAge(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function verdictColor(v: string | null): string {
  if (!v) return 'text-text-muted';
  if (v === 'AUTO_CREDIT') return 'text-green-400';
  if (v === 'MANUAL_HOLD') return 'text-yellow-400';
  if (v === 'REJECT') return 'text-red-400';
  return 'text-text-muted';
}

export default function AdminQrReviewQueue() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { addToast } = useToast();

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/review-queue`, { headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setItems(json.queue);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  async function decide(orderId: string, decision: 'release' | 'reject') {
    setActionId(orderId);
    try {
      const res = await fetch(`${API}/admin/payments/qr-orders/${encodeURIComponent(orderId)}/${decision}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ decisionNote: note || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      addToast(decision === 'release' ? 'Order released' : 'Order rejected', 'success');
      setNote('');
      setNoteFor(null);
      load();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      addToast(`Action failed: ${m}`, 'error');
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-mono text-text-primary">QR Deposit Review Queue</h2>
          <p className="text-xs text-text-muted font-mono mt-1">
            Held by AI for human review (LLM flagged or LLM-rule disagreement)
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-2 rounded hover:bg-bg-elevated"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={`text-text-muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      {items.length === 0 && !loading && (
        <div className="glass-card p-8 text-center">
          <CheckCircle2 size={32} className="mx-auto text-brand-green mb-2" />
          <p className="text-text-muted font-mono text-sm">No orders awaiting review. Queue is clear.</p>
        </div>
      )}

      {items.map((item) => {
        const isExpanded = expandedId === item.merchant_order_id;
        const isActing = actionId === item.merchant_order_id;
        const isNoteOpen = noteFor === item.merchant_order_id;
        return (
          <div key={item.id} className="glass-card p-4 rounded-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="font-mono text-sm text-text-primary">${item.amount_usdt.toFixed(2)} USDT</span>
                  <span className="text-text-muted">|</span>
                  <span className="font-mono text-xs text-text-muted">{item.username || item.user_id.slice(0, 8)}</span>
                  <span className="text-text-muted">|</span>
                  <span className={`font-mono text-xs ${verdictColor(item.llm_verdict)}`}>
                    LLM: {item.llm_verdict || 'n/a'}{item.llm_confidence != null ? ` (${(item.llm_confidence * 100).toFixed(0)}%)` : ''}
                  </span>
                  {item.rule_disagreement && (
                    <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                      LLM/rule disagree
                    </span>
                  )}
                  {item.receipt_uploaded && (
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">
                      receipt
                    </span>
                  )}
                  <span className="text-xs text-text-muted font-mono ml-auto flex items-center gap-1">
                    <Clock size={12} />
                    {formatAge(item.review_age_sec)}
                  </span>
                </div>

                {item.llm_reason && (
                  <p className="text-xs text-text-muted font-mono mt-1">
                    <span className="text-text-primary">AI reason:</span> {item.llm_reason}
                  </p>
                )}
                {item.admin_hold_reason && (
                  <p className="text-xs text-text-muted font-mono mt-1">
                    <span className="text-text-primary">Hold reason:</span> {item.admin_hold_reason}
                  </p>
                )}

                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border-default space-y-1 text-xs font-mono">
                    <div><span className="text-text-muted">orderId:</span> <span className="text-text-primary">{item.merchant_order_id}</span></div>
                    <div><span className="text-text-muted">memo:</span> <span className="text-brand-green font-bold">{item.qr_memo}</span></div>
                    <div><span className="text-text-muted">chain:</span> <span className="text-text-primary">{item.chain}</span></div>
                    <div className="break-all"><span className="text-text-muted">address:</span> <span className="text-text-primary">{item.receive_address}</span></div>
                    {item.detected_tx_hash && (
                      <div className="break-all">
                        <span className="text-text-muted">tx:</span>{' '}
                        <a
                          href={`https://bscscan.com/tx/${item.detected_tx_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-green hover:underline inline-flex items-center gap-1"
                        >
                          {item.detected_tx_hash.slice(0, 20)}...
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    )}
                    {item.rule_verdict && (
                      <div>
                        <span className="text-text-muted">rule:</span>{' '}
                        <span className={verdictColor(item.rule_verdict)}>{item.rule_verdict}</span>
                      </div>
                    )}
                    {item.llm_model_version && (
                      <div><span className="text-text-muted">model:</span> <span className="text-text-primary">{item.llm_model_version}</span></div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <Link
                  href={`/admin/payments/deposits/${encodeURIComponent(item.merchant_order_id)}`}
                  className="p-2 rounded hover:bg-bg-elevated text-text-muted"
                  aria-label="View details"
                >
                  <Eye size={16} />
                </Link>
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : item.merchant_order_id)}
                  className="p-2 rounded hover:bg-bg-elevated text-text-muted"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>
            </div>

            {isNoteOpen && (
              <div className="mt-3 pt-3 border-t border-border-default">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Decision note (optional, max 1000 chars)..."
                  maxLength={1000}
                  rows={2}
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded text-text-primary text-sm font-mono focus:outline-none focus:border-brand-green"
                />
              </div>
            )}

            <div className="mt-3 flex gap-2">
              {!isNoteOpen ? (
                <button
                  type="button"
                  onClick={() => { setNoteFor(item.merchant_order_id); setNote(''); }}
                  className="text-xs px-3 py-1.5 rounded border border-border-default text-text-muted hover:border-text-primary font-mono"
                >
                  Add note
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setNoteFor(null); setNote(''); }}
                  className="text-xs px-3 py-1.5 rounded border border-border-default text-text-muted hover:border-text-primary font-mono"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={() => decide(item.merchant_order_id, 'release')}
                disabled={isActing}
                className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white font-mono flex items-center gap-1 disabled:opacity-50"
              >
                {isActing ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                Release (credit)
              </button>
              <button
                type="button"
                onClick={() => decide(item.merchant_order_id, 'reject')}
                disabled={isActing}
                className="text-xs px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-mono flex items-center gap-1 disabled:opacity-50"
              >
                {isActing ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
