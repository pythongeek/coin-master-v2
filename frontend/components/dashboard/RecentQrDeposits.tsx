'use client';
/**
 * =============================================================
 *  RECENT QR DEPOSITS - shown on dashboard if user has any
 * =============================================================
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock, XCircle, AlertCircle, Loader2, ArrowRight, Upload, Search } from 'lucide-react';
import { listMyQrDeposits, type QrOrderStatus } from '@/lib/api/wallet';
import { usePaymentUpdates, type PaymentUpdateEvent } from '@/lib/usePaymentUpdates';

function statusBadge(status: QrOrderStatus): { icon: typeof Clock; color: string; label: string } {
  switch (status) {
    case 'paid':
      return { icon: CheckCircle2, color: 'text-green-400 bg-green-500/10', label: 'Credited' };
    case 'failed':
      return { icon: XCircle, color: 'text-red-400 bg-red-500/10', label: 'Failed' };
    case 'expired':
      return { icon: Clock, color: 'text-gray-400 bg-gray-500/10', label: 'Expired' };
    case 'verifying':
      return { icon: Search, color: 'text-yellow-400 bg-yellow-500/10', label: 'Reviewing' };
    case 'detected':
      return { icon: Loader2, color: 'text-blue-400 bg-blue-500/10', label: 'Verifying' };
    case 'awaiting_payment':
    default:
      return { icon: Clock, color: 'text-text-muted bg-bg-elevated', label: 'Awaiting' };
  }
}

export default function RecentQrDeposits() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('');

  // Subscribe to live payment updates so the widget updates without polling
  usePaymentUpdates(userId, (event: PaymentUpdateEvent) => {
    setOrders((prev) => prev.map((o) =>
      o.merchant_order_id === event.orderId || o.orderId === event.orderId
        ? { ...o, status: event.status, llm_verdict: event.llmVerdict, llm_confidence: event.llmConfidence }
        : o
    ));
    setLastUpdate(new Date().toISOString());
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
        if (!token) { setLoading(false); return; }
        const res = await listMyQrDeposits(token, 5);
        if (!cancelled) setOrders(res.orders || []);
        // Extract userId from JWT (we have the token in localStorage)
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            if (payload.userId) setUserId(payload.userId);
          }
        } catch (_) { /* ignore */ }
      } catch (err: unknown) {
        if (!cancelled) {
          const m = err instanceof Error ? err.message : String(err);
          setError(m);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return null;
  if (error || orders.length === 0) return null;

  return (
    <div className="glass-card p-4 rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-sm text-text-primary">Recent Deposits</h3>
        <Link
          href="/wallet/deposit"
          className="text-xs text-brand-green hover:underline font-mono inline-flex items-center gap-1"
        >
          New deposit <ArrowRight size={12} />
        </Link>
      </div>
      <div className="space-y-2">
        {orders.map((o) => {
          const badge = statusBadge(o.status);
          const Icon = badge.icon;
          return (
            <div key={o.merchant_order_id} className="flex items-center gap-3 py-2">
              <Icon size={14} className={badge.color.split(' ')[0]} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm text-text-primary">
                  ${o.amount_usdt.toFixed(2)} USDT
                </div>
                <div className="text-xs text-text-muted font-mono">
                  {new Date(o.created_at).toLocaleString()} | {o.chain}
                </div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded font-mono ${badge.color}`}>
                {badge.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
