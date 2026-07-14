'use client';
/**
 * =============================================================
 *  ADMIN QR ORDER DETAIL - full evidence view
 * =============================================================
 *  Sections rendered:
 *    - Order metadata (status, amounts, user, memo, chain)
 *    - On-chain detection (tx hash with BscScan link)
 *    - Binance ledger entry (raw JSON, expandable)
 *    - AI/LLM evidence (verdict, confidence, reason, rule disagreement)
 *    - Receipt preview (inline image + OCR text)
 *    - Decision history (audit trail of admin actions)
 *    - Decision actions (release / reject / hold with note)
 *
  Reachable from /admin -> Deposit Review -> click an item's chevron icon
 */

import { useEffect, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Brain,
  Receipt,
  Database,
  History,
  FileText,
} from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface OrderDetail {
  merchant_order_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  kyc_tier: string | null;
  amount_usdt: number;
  amount_coins: number;
  status: string;
  qr_memo: string | null;
  chain: string | null;
  receive_address: string | null;
  detected_tx_hash: string | null;
  detected_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  expires_at: string;
  llm_verdict: string | null;
  llm_confidence: number | null;
  llm_reason: string | null;
  llm_model_version: string | null;
  rule_verdict: string | null;
  rule_disagreement: boolean | null;
  admin_hold_reason: string | null;
  receipt_url: string | null;
  receipt_uploaded: boolean;
  binance_ledger_entry: any;
  receipt_ocr: any;
  shadow_mode: boolean;
  admin_decided_by: string | null;
  admin_decided_at: string | null;
  status_message: string | null;
}

interface Decision {
  decision: string;
  decision_note: string | null;
  original_verdict: string | null;
  original_confidence: number | null;
  original_reason: string | null;
  created_at: string;
  admin_username: string | null;
}

interface Receipt {
  id: string;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  uploaded_at: string;
  ocr_result: any;
}

function verdictColor(v: string | null): string {
  if (!v) return 'text-text-muted';
  if (v === 'AUTO_CREDIT') return 'text-green-400';
  if (v === 'MANUAL_HOLD') return 'text-yellow-400';
  if (v === 'REJECT') return 'text-red-400';
  if (v === 'paid') return 'text-green-400';
  if (v === 'failed') return 'text-red-400';
  if (v === 'expired') return 'text-gray-400';
  return 'text-text-muted';
}

function statusBadge(status: string): string {
  switch (status) {
    case 'paid': return 'bg-green-500/20 text-green-400';
    case 'verifying': return 'bg-yellow-500/20 text-yellow-400';
    case 'detected': return 'bg-blue-500/20 text-blue-400';
    case 'failed': return 'bg-red-500/20 text-red-400';
    case 'expired': return 'bg-gray-500/20 text-gray-400';
    default: return 'bg-bg-elevated text-text-muted';
  }
}

function CollapsibleJson({ data, label }: { data: any; label: string }) {
  const [open, setOpen] = useState(false);
  if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) return null;
  return (
    <div className="border border-border-default rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-bg-elevated rounded-lg"
      >
        <span className="font-mono text-xs text-text-primary">{label}</span>
        {open ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
      </button>
      {open && (
        <pre className="px-3 pb-3 text-xs font-mono text-text-muted overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const router = useRouter();
  const { orderId } = use(params);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [llmPrompt, setLlmPrompt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState('');

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/qr-orders/${encodeURIComponent(orderId)}`, { headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setOrder(json.order);
      setDecisions(json.decisions || []);
      setReceipts(json.receipts || []);
      setLlmPrompt(json.llmPrompt);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [orderId, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(decision: 'release' | 'reject' | 'hold') {
    if (!order) return;
    setActionRunning(decision);
    try {
      const res = await fetch(`${API}/admin/payments/qr-orders/${encodeURIComponent(order.merchant_order_id)}/${decision}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ decisionNote: actionNote || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setActionNote('');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionRunning(null);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-brand-green" />
      </main>
    );
  }

  if (error || !order) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-4 font-mono">
          <ArrowLeft size={14} /> Back to admin
        </Link>
        <div className="glass-card p-6 rounded-xl">
          <AlertCircle size={32} className="text-red-400 mb-2" />
          <h1 className="text-lg font-mono text-text-primary mb-1">Failed to load order</h1>
          <p className="text-sm text-text-muted font-mono">{error || 'Order not found'}</p>
        </div>
      </main>
    );
  }

  const isTerminal = ['paid', 'failed', 'expired'].includes(order.status);
  const canDecide = order.status === 'verifying';

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary font-mono">
          <ArrowLeft size={14} /> Back to admin
        </Link>
        <button
          type="button"
          onClick={load}
          className="p-2 rounded hover:bg-bg-elevated"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={`text-text-muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-bold font-mono text-text-primary mb-2">
          ${order.amount_usdt.toFixed(2)} USDT
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded font-mono ${statusBadge(order.status)}`}>
            {order.status}
          </span>
          <span className="text-xs text-text-muted font-mono">
            {order.username || order.user_id.slice(0, 8)} | {order.chain} | {order.kyc_tier || 'no-kyc'}
          </span>
          {order.shadow_mode && (
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 font-mono">
              shadow-mode
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted font-mono mt-2 break-all">
          orderId: {order.merchant_order_id}
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left column */}
        <div className="space-y-4">
          {/* AI evidence */}
          <section className="glass-card p-4 rounded-xl">
            <h2 className="text-sm font-mono text-text-primary mb-3 flex items-center gap-2">
              <Brain size={16} className="text-brand-green" /> AI Evidence
            </h2>
            <dl className="space-y-2 text-sm font-mono">
              <div>
                <dt className="text-text-muted text-xs">LLM verdict</dt>
                <dd className={verdictColor(order.llm_verdict)}>
                  {order.llm_verdict || 'n/a'}
                  {order.llm_confidence != null && (
                    <span className="text-text-muted"> ({(order.llm_confidence * 100).toFixed(0)}%)</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">LLM reason</dt>
                <dd className="text-text-primary text-xs">{order.llm_reason || 'n/a'}</dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">Rule verdict</dt>
                <dd className={verdictColor(order.rule_verdict)}>
                  {order.rule_verdict || 'n/a'}
                </dd>
              </div>
              {order.rule_disagreement && (
                <div className="text-yellow-400 text-xs px-2 py-1 rounded bg-yellow-500/10">
                  LLM and rule disagreed - forced MANUAL_HOLD
                </div>
              )}
              {order.llm_model_version && (
                <div>
                  <dt className="text-text-muted text-xs">Model</dt>
                  <dd className="text-text-primary">{order.llm_model_version}</dd>
                </div>
              )}
              {llmPrompt && (
                <div>
                  <dt className="text-text-muted text-xs">Prompt version</dt>
                  <dd className="text-text-primary text-xs">
                    v{llmPrompt.version} ({llmPrompt.few_shot_count} few-shot)
                  </dd>
                </div>
              )}
              {order.admin_hold_reason && (
                <div>
                  <dt className="text-text-muted text-xs">Hold reason</dt>
                  <dd className="text-text-primary text-xs">{order.admin_hold_reason}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* On-chain detection */}
          <section className="glass-card p-4 rounded-xl">
            <h2 className="text-sm font-mono text-text-primary mb-3 flex items-center gap-2">
              <Database size={16} className="text-brand-green" /> On-chain Detection
            </h2>
            {order.detected_tx_hash ? (
              <dl className="space-y-2 text-sm font-mono">
                <div>
                  <dt className="text-text-muted text-xs">Transaction</dt>
                  <dd className="break-all">
                    <a
                      href={`https://bscscan.com/tx/${order.detected_tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-green hover:underline inline-flex items-center gap-1"
                    >
                      {order.detected_tx_hash}
                      <ExternalLink size={12} />
                    </a>
                  </dd>
                </div>
                {order.detected_at && (
                  <div>
                    <dt className="text-text-muted text-xs">Detected at</dt>
                    <dd className="text-text-primary">{new Date(order.detected_at).toLocaleString()}</dd>
                  </div>
                )}
                <CollapsibleJson data={order.binance_ledger_entry} label="Binance ledger entry (raw)" />
              </dl>
            ) : (
              <p className="text-sm text-text-muted font-mono">Not yet detected on-chain</p>
            )}
          </section>

          {/* Receipts */}
          <section className="glass-card p-4 rounded-xl">
            <h2 className="text-sm font-mono text-text-primary mb-3 flex items-center gap-2">
              <Receipt size={16} className="text-brand-green" /> Receipts ({receipts.length})
            </h2>
            {receipts.length === 0 ? (
              <p className="text-sm text-text-muted font-mono">No receipts uploaded</p>
            ) : (
              <div className="space-y-3">
                {receipts.map((r) => (
                  <div key={r.id} className="border border-border-default rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-mono text-xs text-text-primary">
                        {r.original_name || 'receipt'}
                      </div>
                      <div className="text-xs text-text-muted font-mono">
                        {(r.size_bytes / 1024).toFixed(1)} KB | sha256:{r.sha256.slice(0, 10)}...
                      </div>
                    </div>
                    <img
                      src={`${API}/admin/payments/qr-orders/${encodeURIComponent(order.merchant_order_id)}/receipt/${r.id}`}
                      alt="Receipt"
                      className="w-full max-w-md rounded border border-border-default"
                    />
                    {r.ocr_result && (
                      <CollapsibleJson data={r.ocr_result} label="OCR result" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Order metadata */}
          <section className="glass-card p-4 rounded-xl">
            <h2 className="text-sm font-mono text-text-primary mb-3 flex items-center gap-2">
              <FileText size={16} className="text-brand-green" /> Order
            </h2>
            <dl className="space-y-2 text-sm font-mono">
              <div>
                <dt className="text-text-muted text-xs">Memo</dt>
                <dd className="text-brand-green font-bold tracking-wider">{order.qr_memo || 'n/a'}</dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">Receive address</dt>
                <dd className="text-text-primary text-xs break-all">{order.receive_address || 'n/a'}</dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">User</dt>
                <dd className="text-text-primary">
                  {order.username || order.user_id.slice(0, 8)}
                  {order.email && <span className="text-text-muted"> ({order.email})</span>}
                </dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">Amount</dt>
                <dd className="text-text-primary">
                  {order.amount_usdt.toFixed(2)} USDT = {order.amount_coins.toFixed(2)} Coin
                </dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">Created</dt>
                <dd className="text-text-primary text-xs">{new Date(order.created_at).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-text-muted text-xs">Expires</dt>
                <dd className="text-text-primary text-xs">{new Date(order.expires_at).toLocaleString()}</dd>
              </div>
              {order.confirmed_at && (
                <div>
                  <dt className="text-text-muted text-xs">Confirmed</dt>
                  <dd className="text-text-primary text-xs">{new Date(order.confirmed_at).toLocaleString()}</dd>
                </div>
              )}
              {order.status_message && (
                <div>
                  <dt className="text-text-muted text-xs">Status message</dt>
                  <dd className="text-text-primary text-xs">{order.status_message}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Decision history */}
          <section className="glass-card p-4 rounded-xl">
            <h2 className="text-sm font-mono text-text-primary mb-3 flex items-center gap-2">
              <History size={16} className="text-brand-green" /> Decision History
            </h2>
            {decisions.length === 0 ? (
              <p className="text-sm text-text-muted font-mono">No admin decisions yet</p>
            ) : (
              <div className="space-y-2">
                {decisions.map((d, i) => (
                  <div key={i} className="border border-border-default rounded p-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-mono px-2 py-0.5 rounded ${
                        d.decision === 'release' ? 'bg-green-500/20 text-green-400' :
                        d.decision === 'reject' ? 'bg-red-500/20 text-red-400' :
                        'bg-yellow-500/20 text-yellow-400'
                      }`}>
                        {d.decision}
                      </span>
                      <span className="text-text-muted font-mono">
                        by {d.admin_username || 'unknown'} on {new Date(d.created_at).toLocaleString()}
                      </span>
                    </div>
                    {d.original_verdict && (
                      <p className="text-xs text-text-muted font-mono mt-1">
                        LLM said {d.original_verdict} ({(d.original_confidence || 0) * 100 | 0}%) - reason: {d.original_reason}
                      </p>
                    )}
                    {d.decision_note && (
                      <p className="text-xs text-text-primary font-mono mt-1">
                        Note: {d.decision_note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Decision actions */}
          {!isTerminal && (
            <section className="glass-card p-4 rounded-xl">
              <h2 className="text-sm font-mono text-text-primary mb-3">Take Action</h2>
              <textarea
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                placeholder="Optional note (visible in audit log)..."
                maxLength={1000}
                rows={2}
                className="w-full mb-3 px-3 py-2 bg-bg-elevated border border-border-default rounded text-text-primary text-sm font-mono focus:outline-none focus:border-brand-green"
              />
              <div className="flex flex-wrap gap-2">
                {order.status === 'verifying' && (
                  <>
                    <button
                      type="button"
                      onClick={() => decide('release')}
                      disabled={actionRunning !== null}
                      className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white font-mono flex items-center gap-1 disabled:opacity-50"
                    >
                      {actionRunning === 'release' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      Release (credit user)
                    </button>
                    <button
                      type="button"
                      onClick={() => decide('reject')}
                      disabled={actionRunning !== null}
                      className="text-xs px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-mono flex items-center gap-1 disabled:opacity-50"
                    >
                      {actionRunning === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                      Reject (no credit)
                    </button>
                  </>
                )}
                {(order.status === 'awaiting_payment' || order.status === 'detected') && (
                  <button
                    type="button"
                    onClick={() => decide('hold')}
                    disabled={actionRunning !== null}
                    className="text-xs px-3 py-1.5 rounded bg-yellow-600 hover:bg-yellow-500 text-white font-mono flex items-center gap-1 disabled:opacity-50"
                  >
                    {actionRunning === 'hold' ? <Loader2 size={12} className="animate-spin" /> : <AlertCircle size={12} />}
                    Hold for review
                  </button>
                )}
              </div>
              {canDecide && (
                <p className="text-xs text-text-muted font-mono mt-2">
                  Decision will be written to payment_review_decisions for the LLM feedback loop.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
