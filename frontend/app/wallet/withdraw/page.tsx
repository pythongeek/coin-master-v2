'use client';
/**
 * =============================================================
 *  USER WITHDRAWAL PAGE - /wallet/withdraw
 * =============================================================
 *  Phase 1 of P0 (closes critical gap C1: no user-facing withdraw flow).
 *
 *  Flow:
 *    1. User logs in -> page fetches /api/wallet/balances
 *    2. User picks a wallet (e.g. USDT on BSC, TRX on Tron)
 *    3. User enters destination address (validated client-side + server-side)
 *    4. User enters amount (validated against wallet balance + per-currency min)
 *    5. POST /api/wallet/withdraw -> enters BullMQ -> admin approves
 *    6. User sees "pending review" + can check admin queue status
 *
 *  Safety:
 *    - Address is validated client-side BEFORE submit (saves a round trip
 *      and prevents typos from being submitted)
 *    - Server re-validates (defense in depth)
 *    - Memo field is optional, used for the user's own bookkeeping
 *    - KYC + self-exclusion checked server-side
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Wallet as WalletIcon, AlertCircle, Loader2, Send, CheckCircle2,
  ArrowRight, Lock, Info,
} from 'lucide-react';
import {
  getWalletBalances,
  requestWithdrawal,
  type WalletBalance,
  type KycInfo,
} from '@/lib/api/wallet';
import EquivalentAmounts from '@/components/wallet/EquivalentAmounts';
import { getFxRates, type FxRatesResponse } from '@/lib/api/wallet';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

interface AddressCheck {
  ok: boolean;
  error?: string;
}

function validateAddress(addr: string, networkCode: string): AddressCheck {
  const trimmed = (addr || '').trim();
  if (!trimmed) return { ok: false, error: 'Address is required' };
  const n = (networkCode || '').toUpperCase();
  if (['BSC', 'ETH', 'ARBITRUM', 'POLYGON', 'OPTIMISM', 'BASE'].includes(n)) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return { ok: false, error: 'Must be 0x followed by 40 hex chars' };
    }
  } else if (n === 'TRX') {
    if (!/^T[a-zA-Z0-9]{33}$/.test(trimmed)) {
      return { ok: false, error: 'Must be T followed by 33 base58 chars' };
    }
  } else if (n === 'SOL') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      return { ok: false, error: 'Must be 32-44 base58 chars' };
    }
  } else {
    return { ok: false, error: `Unknown network ${networkCode}` };
  }
  return { ok: true };
}

// Per-currency min (matches backend defaults in withdrawal-queue.ts)
const MIN_WITHDRAW: Record<string, number> = {
  USDT: 10, USDC: 10, DAI: 10,    // stablecoins
  ETH: 0.01,
  SOL: 0.1,
  TRX: 100,
  BNB: 0.01,
};

export default function WithdrawPage() {
  const router = useRouter();
  const [wallets, setWallets] = useState<WalletBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ txId: string; amount: number; token: string } | null>(null);
  const [fxRates, setFxRates] = useState<{ USDT: number; USD: number; BDT: number } | null>(null);
  const [kyc, setKyc] = useState<KycInfo | null>(null);

  // Form state
  const [selectedWalletId, setSelectedWalletId] = useState<string>('');
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [memo, setMemo] = useState('');

  const token = getToken();

  // Load wallets + FX rates on mount
  const loadWallets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getWalletBalances(token);
      setWallets(res.wallets);
      if (res.kyc) setKyc(res.kyc);
      // Auto-select first non-empty wallet
      const withBalance = res.wallets.find((w) => w.balance > 0);
      if (withBalance && !selectedWalletId) setSelectedWalletId(withBalance.id);
      else if (res.wallets.length > 0 && !selectedWalletId) setSelectedWalletId(res.wallets[0].id);
    } catch (e: unknown) {
      const m = (e as Error).message;
      setError(m.includes('Unauthorized') ? 'Please log in first' : m);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { loadWallets(); }, [loadWallets]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getFxRates();
        if (!cancelled) setFxRates(r.rates);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Derived: currently selected wallet
  const selectedWallet = useMemo(
    () => wallets.find((w) => w.id === selectedWalletId) || null,
    [wallets, selectedWalletId]
  );

  // Derived: address validation
  const addrCheck = useMemo(
    () => selectedWallet ? validateAddress(toAddress, selectedWallet.chain) : { ok: false },
    [toAddress, selectedWallet]
  );

  // Derived: amount validation
  const amountNum = parseFloat(amount);
  const minAmount = selectedWallet ? (MIN_WITHDRAW[selectedWallet.tokenSymbol] || 10) : 0;
  const amountCheck = useMemo(() => {
    if (!selectedWallet) return { ok: false, error: 'Select a wallet' };
    if (!amount) return { ok: false, error: 'Enter an amount' };
    if (isNaN(amountNum) || amountNum <= 0) return { ok: false, error: 'Amount must be a positive number' };
    if (amountNum < minAmount) return { ok: false, error: `Minimum withdrawal is ${minAmount} ${selectedWallet.tokenSymbol}` };
    if (amountNum > selectedWallet.balance) {
      return { ok: false, error: `Insufficient balance. Available: ${selectedWallet.balance.toFixed(4)} ${selectedWallet.tokenSymbol}` };
    }
    return { ok: true };
  }, [amount, amountNum, minAmount, selectedWallet]);

  // Derived: net amount user receives (subtract gas if applicable; backend handles this)
  const canSubmit = addrCheck.ok && amountCheck.ok && !submitting && selectedWallet && (kyc?.tierLevel ?? 0) > 0;

  async function handleSubmit() {
    if (!selectedWallet || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestWithdrawal(token, {
        walletId: selectedWallet.id,
        toAddress: toAddress.trim(),
        amount: amountNum,
        memo: memo.trim() || undefined,
      });
      setSuccess({
        txId: res.transactionId,
        amount: amountNum,
        token: selectedWallet.tokenSymbol,
      });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
    setSubmitting(false);
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-bg-base flex items-center justify-center">
        <Loader2 className="animate-spin text-text-muted" size={32} />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg-base p-4 md:p-6 max-w-2xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <Send size={24} className="text-brand-green" />
          Withdraw
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Send your balance to any external wallet. Withdrawals require admin review and are typically processed within 24 hours.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      {success ? (
        <div className="glass-card p-6 rounded-xl text-center">
          <CheckCircle2 size={48} className="text-brand-green mx-auto mb-4" />
          <h2 className="text-xl font-bold text-text-primary mb-2">Withdrawal submitted</h2>
          <p className="text-text-muted text-sm mb-4">
            {success.amount} {success.token} withdrawal pending admin review. You'll be notified when it's approved.
          </p>
          <div className="bg-bg-elevated p-3 rounded font-mono text-xs text-text-secondary break-all mb-4">
            Transaction ID: {success.txId}
          </div>
          <div className="flex gap-2 justify-center">
            <button
              type="button"
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 rounded bg-bg-elevated text-text-primary hover:bg-bg-elevated/70 text-sm font-mono"
            >
              Back to dashboard
            </button>
            <button
              type="button"
              onClick={() => { setSuccess(null); setToAddress(''); setAmount(''); setMemo(''); loadWallets(); }}
              className="px-4 py-2 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-sm font-mono"
            >
              New withdrawal
            </button>
          </div>
        </div>
      ) : wallets.length === 0 ? (
        <div className="glass-card p-6 rounded-xl text-center">
          <WalletIcon size={32} className="text-text-muted mx-auto mb-3" />
          <h2 className="text-text-primary font-bold mb-2">No wallets yet</h2>
          <p className="text-text-muted text-sm mb-4">Make a deposit first to create a wallet.</p>
          <button
            type="button"
            onClick={() => router.push('/wallet/deposit')}
            className="px-4 py-2 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-sm font-mono"
          >
            Deposit
          </button>
        </div>
      ) : (
        <>
          {/* KYC tier + limit info */}
          {kyc && (
            <div className="glass-card p-3 rounded-xl mb-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">KYC tier</span>
                  <span className="text-xs font-mono font-bold text-text-primary">
                    {kyc.tier ? `Tier ${kyc.tierLevel}` : 'Unverified'}
                  </span>
                  {kyc.tierLevel < 3 && (
                    <a href="/kyc" className="text-[10px] font-mono text-brand-green hover:underline">
                      {kyc.tierLevel === 0 ? 'Verify to withdraw to enable' : 'Upgrade tier to increase limits'}
                    </a>
                  )}
                </div>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                  kyc.tierLevel === 0 ? 'bg-red-500/20 text-red-400' :
                  kyc.tierLevel === 1 ? 'bg-amber-500/20 text-amber-400' :
                  kyc.tierLevel === 2 ? 'bg-blue-500/20 text-blue-400' :
                  'bg-brand-green/20 text-brand-green'
                }`}>
                  {kyc.status}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                <div>
                  <div className="text-text-muted">Per tx</div>
                  <div className="text-text-primary font-bold">${kyc.perTxLimit}</div>
                </div>
                <div>
                  <div className="text-text-muted">Daily limit</div>
                  <div className="text-text-primary font-bold">${kyc.dailyLimit}</div>
                </div>
                <div>
                  <div className="text-text-muted">Used today</div>
                  <div className="text-text-primary font-bold">${kyc.dailyUsed.toFixed(2)} / ${kyc.dailyRemaining.toFixed(2)} left</div>
                </div>
              </div>
            </div>
          )}

          {/* Wallet picker */}
          <div className="glass-card p-4 rounded-xl mb-4">
            <label className="block text-xs text-text-muted font-mono mb-2">From wallet</label>

            <div className="grid grid-cols-1 gap-2">
              {wallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setSelectedWalletId(w.id)}
                  className={`flex items-center justify-between p-3 rounded-lg border text-left ${
                    selectedWalletId === w.id
                      ? 'bg-brand-green/10 border-brand-green/40'
                      : 'bg-bg-elevated border-border hover:border-border-default'
                  }`}
                >
                  <div>
                    <div className="text-text-primary font-mono text-sm font-bold">
                      {w.tokenSymbol} <span className="text-text-muted font-normal">on {w.chain}</span>
                    </div>
                    <div className="text-[10px] text-text-muted font-mono">
                      {w.depositAddress.slice(0, 10)}...{w.depositAddress.slice(-6)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-text-primary font-mono text-sm font-bold">
                      {w.balance.toFixed(4)} {w.tokenSymbol}
                    </div>
                    {w.lockedBalance > 0 && (
                      <div className="text-[10px] text-amber-400 font-mono">
                        (locked: {w.lockedBalance.toFixed(4)})
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Address */}
          {selectedWallet && (
            <>
              <div className="glass-card p-4 rounded-xl mb-4">
                <label className="block text-xs text-text-muted font-mono mb-2">
                  Destination address ({selectedWallet.chain})
                </label>
                <input
                  type="text"
                  placeholder={selectedWallet.chain === 'TRX' ? 'T...' : '0x...'}
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                  className={`w-full px-3 py-2 bg-bg-elevated border rounded font-mono text-sm text-text-primary focus:outline-none ${
                    toAddress && !addrCheck.ok
                      ? 'border-red-500/50'
                      : addrCheck.ok
                      ? 'border-brand-green/40'
                      : 'border-border-default focus:border-brand-green'
                  }`}
                />
                {toAddress && !addrCheck.ok && (
                  <p className="text-xs text-red-400 font-mono mt-1 flex items-center gap-1">
                    <AlertCircle size={10} /> {addrCheck.error}
                  </p>
                )}
                {addrCheck.ok && (
                  <p className="text-xs text-brand-green font-mono mt-1 flex items-center gap-1">
                    <CheckCircle2 size={10} /> Address format valid
                  </p>
                )}
              </div>

              {/* Amount */}
              <div className="glass-card p-4 rounded-xl mb-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs text-text-muted font-mono">Amount</label>
                  <div className="text-xs text-text-muted font-mono">
                    Available: <span className="text-text-primary">{selectedWallet.balance.toFixed(4)} {selectedWallet.tokenSymbol}</span>
                  </div>
                </div>
                <input
                  type="number"
                  min={minAmount}
                  step="0.0001"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`w-full px-3 py-2 bg-bg-elevated border rounded font-mono text-lg text-text-primary focus:outline-none ${
                    amount && !amountCheck.ok
                      ? 'border-red-500/50'
                      : amountCheck.ok
                      ? 'border-brand-green/40'
                      : 'border-border-default focus:border-brand-green'
                  }`}
                  placeholder={`Min ${minAmount} ${selectedWallet.tokenSymbol}`}
                />
                {amount && !amountCheck.ok && (
                  <p className="text-xs text-red-400 font-mono mt-1 flex items-center gap-1">
                    <AlertCircle size={10} /> {amountCheck.error}
                  </p>
                )}
                {amountCheck.ok && fxRates && (
                  <div className="mt-2 p-2 rounded bg-bg-elevated/50 border border-border-default/50">
                    <EquivalentAmounts
                      amount={amountNum}
                      rates={fxRates}
                      compact
                    />
                  </div>
                )}
              </div>

              {/* Memo (optional) */}
              <div className="glass-card p-4 rounded-xl mb-4">
                <label className="block text-xs text-text-muted font-mono mb-2">
                  Note (optional, visible to admin only)
                </label>
                <input
                  type="text"
                  placeholder="e.g., to my Ledger Nano X"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={200}
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                />
              </div>

              {/* Warning */}
              <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-2">
                <Lock size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-amber-300 text-xs font-mono">
                  <strong>Important:</strong> Withdrawals are reviewed by an admin and processed within 24 hours.
                  Sending to the wrong address <strong>cannot be reversed</strong>.
                  Double-check the destination network matches your wallet.
                </div>
              </div>

              {/* Submit */}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg btn-brand text-base font-mono disabled:opacity-30"
              >
                {submitting ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <ArrowRight size={18} />
                    Request withdrawal of {amount || '0'} {selectedWallet.tokenSymbol}
                  </>
                )}
              </button>
            </>
          )}
        </>
      )}

      {/* Help */}
      <div className="mt-6 p-3 rounded-lg bg-bg-elevated/50 border border-border-default/50 flex items-start gap-2">
        <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
        <div className="text-xs text-text-muted font-mono">
          Withdrawal limits: per-currency minimums apply (10 USDT/USDC, 0.01 ETH, 0.1 SOL, 100 TRX).
          Larger amounts may require KYC tier 2. Self-excluded users cannot withdraw.
        </div>
      </div>
    </main>
  );
}