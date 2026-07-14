'use client';
/**
 * =============================================================
 *  USER TRANSACTION HISTORY - /wallet/transactions
 * =============================================================
 *  Phase 8 P2-E: dedicated page for users to see their deposits,
 *  withdrawals, bets, wins, bonuses, rakeback, etc.
 *
 *  Features:
 *    - Type filter pills (all / deposit / withdrawal / bet / win / bonus / ...)
 *    - Pagination (50 per page)
 *    - Status badges + amount formatting
 *    - Tx hash clickable to block explorer (when present)
 *    - Live refresh button
 *    - Color-coded amounts (green for incoming, red for outgoing)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ArrowDownCircle, ArrowUpCircle, RefreshCw, Loader2, AlertCircle,
  ExternalLink, ChevronLeft, ChevronRight, Filter,
} from 'lucide-react';
import {
  getTransactionHistory,
  type UserTransaction,
  type TransactionHistoryResponse,
} from '@/lib/api/wallet';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

const TYPE_FILTERS = [
  { key: '', label: 'All' },
  { key: 'deposit', label: 'Deposits' },
  { key: 'withdrawal', label: 'Withdrawals' },
  { key: 'bet', label: 'Bets' },
  { key: 'win', label: 'Wins' },
  { key: 'payout', label: 'Payouts' },
  { key: 'bonus', label: 'Bonuses' },
  { key: 'rakeback', label: 'Rakeback' },
  { key: 'affiliate_reward', label: 'Affiliate' },
];

function statusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'confirmed':
      return 'bg-brand-green/20 text-brand-green';
    case 'pending':
      return 'bg-amber-500/20 text-amber-400';
    case 'failed':
    case 'rejected':
      return 'bg-red-500/20 text-red-400';
    case 'cancelled':
      return 'bg-gray-500/20 text-gray-400';
    default:
      return 'bg-bg-elevated text-text-muted';
  }
}

function explorerUrl(chain: string | null, txHash: string | null): string | null {
  if (!txHash) return null;
  switch (chain) {
    case 'BSC': return `https://bscscan.com/tx/${txHash}`;
    case 'ETH': return `https://etherscan.io/tx/${txHash}`;
    case 'TRX': return `https://tronscan.org/#/transaction/${txHash}`;
    case 'ERC20': return `https://etherscan.io/tx/${txHash}`;
    default: return null;
  }
}

export default function TransactionsPage() {
  const [data, setData] = useState<TransactionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(0);

  const token = getToken();
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getTransactionHistory(token, {
        limit,
        offset: page * limit,
        type: typeFilter || undefined,
      });
      setData(res);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [token, page, typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 0 when filter changes
  useEffect(() => {
    setPage(0);
  }, [typeFilter]);

  return (
    <main className="min-h-screen bg-bg-base p-4 md:p-6 max-w-4xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Transactions</h1>
          <p className="text-text-muted text-sm mt-1">
            All your deposits, withdrawals, bets, and bonuses.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-2 rounded bg-bg-elevated hover:bg-bg-elevated/70 disabled:opacity-50"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      {/* Type filter pills */}
      <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-2">
        <Filter size={14} className="text-text-muted flex-shrink-0" />
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.key || 'all'}
            type="button"
            onClick={() => setTypeFilter(f.key)}
            className={`px-3 py-1 rounded-full text-xs font-mono whitespace-nowrap transition ${
              typeFilter === f.key
                ? 'bg-brand-green/20 text-brand-green border border-brand-green/40'
                : 'bg-bg-elevated text-text-muted hover:bg-bg-elevated/70 border border-transparent'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-text-muted" size={32} />
        </div>
      )}

      {/* Empty state */}
      {data && data.transactions.length === 0 && (
        <div className="glass-card p-8 rounded-xl text-center">
          <ArrowUpCircle size={32} className="text-text-muted mx-auto mb-3" />
          <h2 className="text-text-primary font-bold mb-2">No transactions yet</h2>
          <p className="text-text-muted text-sm">
            {typeFilter ? `No ${typeFilter} transactions yet.` : 'Make a deposit to get started.'}
          </p>
        </div>
      )}

      {/* Transactions list */}
      {data && data.transactions.length > 0 && (
        <div className="glass-card rounded-xl overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.transactions.map((tx: UserTransaction) => {
              const incoming = ['deposit', 'win', 'payout', 'bonus', 'rakeback', 'affiliate_reward'].includes(tx.type);
              return (
                <div key={tx.id} className="p-3 hover:bg-bg-elevated/30 transition">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {incoming ? (
                        <ArrowDownCircle size={18} className="text-brand-green flex-shrink-0" />
                      ) : (
                        <ArrowUpCircle size={18} className="text-amber-400 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-text-primary font-mono text-sm capitalize">
                          {tx.type.replace(/_/g, ' ')}
                        </div>
                        <div className="text-[10px] text-text-muted font-mono">
                          {new Date(tx.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex items-center gap-3">
                      <div>
                        <div className={`font-mono text-sm font-bold ${incoming ? 'text-brand-green' : 'text-text-primary'}`}>
                          {incoming ? '+' : '-'}{Math.abs(tx.amount).toFixed(4)}
                        </div>
                        <div className="text-[10px] text-text-muted font-mono">
                          <span className={`px-2 py-0.5 rounded ${statusColor(tx.status)}`}>
                            {tx.status}
                          </span>
                        </div>
                      </div>
                      {tx.txHash && explorerUrl(tx.metadata?.chain as string ?? null, tx.txHash) && (
                        <a
                          href={explorerUrl(tx.metadata?.chain as string ?? null, tx.txHash)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-text-muted hover:text-brand-green p-1"
                          title="View on block explorer"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </div>
                  </div>
                  {typeof tx.metadata?.memo === 'string' && (
                    <div className="text-[10px] text-text-muted font-mono mt-1 ml-7 truncate">
                      Note: {tx.metadata.memo}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs font-mono">
            <span className="text-text-muted">
              {data.pagination.total === 0 ? '0' :
                `${data.pagination.offset + 1}-${data.pagination.offset + data.transactions.length} of ${data.pagination.total}`}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0 || loading}
                className="p-1 rounded bg-bg-elevated hover:bg-bg-elevated/70 disabled:opacity-30"
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-text-muted px-2">Page {page + 1}</span>
              <button
                type="button"
                onClick={() => setPage(page + 1)}
                disabled={!data.pagination.hasMore || loading}
                className="p-1 rounded bg-bg-elevated hover:bg-bg-elevated/70 disabled:opacity-30"
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}