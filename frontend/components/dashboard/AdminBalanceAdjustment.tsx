'use client';
/**
 * =============================================================
 *  ADMIN BALANCE ADJUSTMENT - manual credit / deduct
 * =============================================================
 *
 *  UI for super_admin to:
 *   1. Look up any user (by UUID) and see their wallet balances
 *   2. Credit or deduct coins with reason + category
 *   3. View full audit trail (with filters)
 *
 *  Replaces the broken / unused AdminCoinManagement component.
 *  Wired into AdminClientShell as a new 'balance_adjust' tab.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Coins, Plus, Minus, RefreshCw, AlertCircle, CheckCircle2, Loader2,
  Search, ChevronRight, History,
} from 'lucide-react';
import {
  getAdminUserBalances,
  adminCreditBalance,
  adminDeductBalance,
  getAdminBalanceHistory,
  type AdminUserBalance,
  type AdminBalanceAdjustment,
  type AdminBalanceHistoryEntry,
} from '@/lib/api/wallet';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

type Tab = 'adjust' | 'history';

const CATEGORIES = [
  { key: 'manual', label: 'Manual' },
  { key: 'goodwill', label: 'Goodwill' },
  { key: 'correction', label: 'Correction' },
  { key: 'chargeback', label: 'Chargeback' },
  { key: 'prize', label: 'Prize' },
  { key: 'refund', label: 'Refund' },
  { key: 'other', label: 'Other' },
];

export default function AdminBalanceAdjustment() {
  const [tab, setTab] = useState<Tab>('adjust');
  const [token] = useState(getToken());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <Coins size={20} className="text-brand-green" />
          Manual Balance Adjustment
        </h2>
      </div>

      {/* Tab nav */}
      <div className="flex gap-2 border-b border-border">
        <button
          type="button"
          onClick={() => setTab('adjust')}
          className={`px-4 py-2 font-mono text-sm flex items-center gap-2 border-b-2 transition ${
            tab === 'adjust'
              ? 'border-brand-green text-text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          <Plus size={14} /> Adjust
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`px-4 py-2 font-mono text-sm flex items-center gap-2 border-b-2 transition ${
            tab === 'history'
              ? 'border-brand-green text-text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          <History size={14} /> Audit Trail
        </button>
      </div>

      {tab === 'adjust' && <AdjustTab token={token} />}
      {tab === 'history' && <HistoryTab token={token} />}
    </div>
  );
}

// ===========================================================================
//  Adjust Tab
// ===========================================================================

function AdjustTab({ token }: { token: string }) {
  const [userId, setUserId] = useState('');
  const [balances, setBalances] = useState<AdminUserBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [selectedWallet, setSelectedWallet] = useState<AdminUserBalance | null>(null);
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('manual');
  const [submitting, setSubmitting] = useState(false);

  function flash(type: 'ok' | 'err', msg: string) {
    setNotice({ type, msg });
    setTimeout(() => setNotice(null), 5000);
  }

  async function loadBalances() {
    if (!userId.trim()) return;
    setLoading(true);
    setError(null);
    setBalances([]);
    setSelectedWallet(null);
    try {
      const r = await getAdminUserBalances(token, userId.trim());
      setBalances(r.balances);
      if (r.balances.length === 0) {
        setError('User has no wallets. They must deposit first to create a wallet.');
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  async function submit() {
    if (!selectedWallet) {
      flash('err', 'Select a wallet first');
      return;
    }
    const n = parseFloat(amount);
    if (!isFinite(n) || n <= 0) {
      flash('err', 'Amount must be a positive number');
      return;
    }
    if (reason.trim().length < 20) {
      flash('err', 'Reason must be at least 20 characters (for audit)');
      return;
    }
    setSubmitting(true);
    try {
      const fn = direction === 'credit' ? adminCreditBalance : adminDeductBalance;
      const r = await fn(token, {
        userId: userId.trim(),
        walletId: selectedWallet.walletId,
        amount: n,
        reason: reason.trim(),
        category: category as 'manual' | 'goodwill' | 'correction' | 'chargeback' | 'prize' | 'refund' | 'other',
      });
      flash('ok', `${direction === 'credit' ? 'Credited' : 'Debited'} ${n} ${selectedWallet.tokenSymbol}. New balance: ${r.result.balanceAfter} (email sent: ${r.result.emailSent})`);
      // Reload balances to show the new amount
      await loadBalances();
      // Reset form
      setAmount('');
      setReason('');
    } catch (err: unknown) {
      flash('err', (err as Error).message);
    }
    setSubmitting(false);
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`p-3 rounded flex items-start gap-2 ${
          notice.type === 'ok' ? 'bg-brand-green/10 border border-brand-green/30' : 'bg-red-500/10 border border-red-500/30'
        }`}>
          {notice.type === 'ok' ? (
            <CheckCircle2 size={16} className="text-brand-green flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
          )}
          <span className={`text-sm ${notice.type === 'ok' ? 'text-brand-green' : 'text-red-300'}`}>
            {notice.msg}
          </span>
        </div>
      )}

      {/* Step 1: Find user */}
      <div className="glass-card p-4 rounded-xl">
        <h3 className="text-text-primary font-mono text-base font-bold mb-2">1. Find User</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="User UUID (e.g. b64784cf-2aa2-459b-8924-eda1e25e2315)"
            className="flex-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
          />
          <button
            type="button"
            onClick={loadBalances}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-green/20 text-brand-green rounded text-xs font-mono hover:bg-brand-green/30 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            Lookup
          </button>
        </div>
        {error && (
          <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-red-300 text-xs font-mono">
            {error}
          </div>
        )}
      </div>

      {/* Step 2: Pick wallet */}
      {balances.length > 0 && (
        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-text-primary font-mono text-base font-bold mb-2">2. Select Wallet</h3>
          <div className="space-y-2">
            {balances.map((w) => (
              <button
                key={w.walletId}
                type="button"
                onClick={() => setSelectedWallet(w)}
                className={`w-full p-3 rounded-lg border text-left flex items-center justify-between transition ${
                  selectedWallet?.walletId === w.walletId
                    ? 'bg-brand-green/10 border-brand-green/40'
                    : 'bg-bg-elevated/50 border-border hover:border-border-default'
                }`}
              >
                <div>
                  <div className="text-text-primary font-mono text-sm font-bold">
                    {w.tokenSymbol} <span className="text-text-muted text-xs font-normal">on {w.chain}</span>
                  </div>
                  <div className="text-[10px] text-text-muted font-mono">
                    {w.walletId}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-text-primary font-mono text-sm font-bold">
                    {w.balance.toFixed(4)}
                  </div>
                  <div className="text-[10px] text-text-muted font-mono">
                    available: {w.withdrawable.toFixed(4)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Adjust */}
      {selectedWallet && (
        <div className="glass-card p-4 rounded-xl">
          <h3 className="text-text-primary font-mono text-base font-bold mb-3">3. Adjust</h3>

          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => setDirection('credit')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded text-sm font-mono font-bold transition ${
                direction === 'credit'
                  ? 'bg-brand-green text-white'
                  : 'bg-bg-elevated text-text-muted hover:text-text-primary'
              }`}
            >
              <Plus size={14} /> Credit
            </button>
            <button
              type="button"
              onClick={() => setDirection('debit')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded text-sm font-mono font-bold transition ${
                direction === 'debit'
                  ? 'bg-red-500 text-white'
                  : 'bg-bg-elevated text-text-muted hover:text-text-primary'
              }`}
            >
              <Minus size={14} /> Debit
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <label className="block">
              <span className="text-[10px] text-text-muted font-mono">Amount ({selectedWallet.tokenSymbol})</span>
              <input
                type="number"
                min="0.00000001"
                step="0.00000001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-text-muted font-mono">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block mb-3">
            <span className="text-[10px] text-text-muted font-mono">Reason (min 20 chars - logged for audit)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Player requested goodwill credit after documented system issue #1234"
              rows={3}
              className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
            />
            <div className="text-[10px] text-text-muted font-mono mt-0.5">
              {reason.length} / 20 chars minimum
            </div>
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-mono font-bold text-sm transition disabled:opacity-50 ${
                direction === 'credit'
                  ? 'bg-brand-green text-white hover:bg-brand-green/90'
                  : 'bg-red-500 text-white hover:bg-red-500/90'
              }`}
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
              {direction === 'credit' ? 'Credit' : 'Debit'} {amount || '0'} {selectedWallet.tokenSymbol}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
//  History Tab
// ===========================================================================

function HistoryTab({ token }: { token: string }) {
  const [entries, setEntries] = useState<AdminBalanceHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filterUser, setFilterUser] = useState('');
  const [filterDir, setFilterDir] = useState('');

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getAdminBalanceHistory(token, {
        limit,
        offset,
        userId: filterUser.trim() || undefined,
        direction: (filterDir || undefined) as 'credit' | 'debit' | undefined,
      });
      setEntries(r.entries);
      setTotal(r.total);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
    setLoading(false);
  }, [token, offset, filterUser, filterDir]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 rounded-xl">
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="block flex-1 min-w-[200px]">
            <span className="text-[10px] text-text-muted font-mono">Filter by user UUID</span>
            <input
              type="text"
              value={filterUser}
              onChange={(e) => { setFilterUser(e.target.value); setOffset(0); }}
              placeholder="User UUID (optional)"
              className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-text-muted font-mono">Direction</span>
            <select
              value={filterDir}
              onChange={(e) => { setFilterDir(e.target.value); setOffset(0); }}
              className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary"
            >
              <option value="">All</option>
              <option value="credit">Credit</option>
              <option value="debit">Debit</option>
            </select>
          </label>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-elevated rounded text-xs font-mono hover:bg-bg-elevated/70 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-red-300 text-xs font-mono">
            {error}
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-text-muted" size={20} />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-text-muted text-xs font-mono text-center py-6">No adjustment history yet.</p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div
                key={e.id}
                className={`p-3 rounded border ${
                  e.direction === 'credit'
                    ? 'bg-brand-green/5 border-brand-green/20'
                    : 'bg-red-500/5 border-red-500/20'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    {e.direction === 'credit' ? (
                      <Plus size={14} className="text-brand-green" />
                    ) : (
                      <Minus size={14} className="text-red-400" />
                    )}
                    <span className={`font-mono text-sm font-bold ${
                      e.direction === 'credit' ? 'text-brand-green' : 'text-red-400'
                    }`}>
                      {e.direction === 'credit' ? '+' : '-'}{e.amount_coins.toFixed(4)} {e.token_symbol}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono px-1.5 py-0.5 bg-bg-elevated rounded">
                      {e.category}
                    </span>
                  </div>
                  <span className="text-[10px] text-text-muted font-mono">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="text-[10px] text-text-muted font-mono">
                  User: <span className="text-text-primary">{e.user_username || e.user_id.slice(0, 12)}</span> ({e.user_email || '-'})
                  {' · '}
                  Admin: <span className="text-text-primary">{e.admin_username}</span>
                  {' · '}
                  Balance: {e.balance_before.toFixed(4)} → {e.balance_after.toFixed(4)} {e.token_symbol}
                </div>
                <div className="text-[10px] text-text-secondary font-mono mt-1 italic">
                  {e.reason}
                </div>
                <details className="mt-1">
                  <summary className="text-[9px] text-text-muted cursor-pointer hover:text-text-primary">details</summary>
                  <div className="mt-1 p-1.5 bg-bg-base rounded text-[9px] font-mono space-y-0.5">
                    <div>adjustment_id: {e.id}</div>
                    <div>transaction_id: {e.transaction_id || '-'}</div>
                    <div>ip: {e.ip_address || '-'}</div>
                  </div>
                </details>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="mt-3 flex items-center justify-between text-[10px] font-mono text-text-muted">
            <span>{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0 || loading}
                className="px-2 py-1 bg-bg-elevated rounded disabled:opacity-30"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total || loading}
                className="px-2 py-1 bg-bg-elevated rounded disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}