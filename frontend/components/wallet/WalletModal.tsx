'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET MODAL — Deposit / History / Settings (Phase B.1)
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState, useCallback } from 'react';
import { X, CreditCard, History, Settings, Loader2 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import {
  createPaymentOrder,
  listPaymentOrders,
  getWalletHistory,
  topUp as topUpPlayMoney,
  type SupportedCurrency,
  WalletApiError,
  type WalletTopUpResponse,
} from '@/lib/api/wallet';

const GATEWAYS = [
  { key: 'binance_pay', label: 'Binance Pay', icon: '🟡' },
  { key: 'redot_pay', label: 'Redot Pay', icon: '🔴' },
];

function fmt(currency: SupportedCurrency, amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount);
}

function fmtCoins(coins: number | string) {
  const n = typeof coins === 'string' ? parseFloat(coins) : coins;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function cls(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

interface WalletModalProps {
  open: boolean;
  onClose: () => void;
  token: string | null;
  onBalanceChange?: (balance: number) => void;
}

export default function WalletModal({ open, onClose, token, onBalanceChange }: WalletModalProps) {
  const user = useGameStore((s) => s.user);

  const [tab, setTab] = useState<'deposit' | 'history' | 'settings'>('deposit');
  const [gateway, setGateway] = useState<string>('binance_pay');
  const [amount, setAmount] = useState('10');
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [walletHist, setWalletHist] = useState<any[]>([]);
  const [paymentHist, setPaymentHist] = useState<any[]>([]);

  const onDepositComplete = useCallback(() => {
    if (onBalanceChange && user) {
      onBalanceChange(user.balance + (parseFloat(amount) || 0));
    }
  }, [onBalanceChange, user, amount]);

  useEffect(() => {
    if (!open || tab !== 'history' || !token) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [w, p] = await Promise.all([
          getWalletHistory(token, 20),
          listPaymentOrders(token, 20),
        ]);
        if (cancelled) return;
        setWalletHist(w.history || []);
        setPaymentHist(p.orders || []);
      } catch (e) {
        if (!cancelled) setErrMsg(e instanceof WalletApiError ? e.message : 'Failed to load history.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, tab, open]);

  if (!open) return null;

  const handleDeposit = async () => {
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) {
      setErrMsg('USDT amount must be a positive number.');
      return;
    }
    if (!token) {
      setErrMsg('Please log in first.');
      return;
    }
    setSubmitting(true);
    setErrMsg(null);
    try {
      const resp = await createPaymentOrder(token, {
        gateway: gateway as any,
        currency: 'USDT' as any,
        amount: num,
        returnUrl: typeof window !== 'undefined' ? `${window.location.origin}/wallet/return` : undefined,
      });
      if (typeof window !== 'undefined' && resp.payment?.checkoutUrl) {
        const url = resp.payment.checkoutUrl as string;
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      onDepositComplete();
    } catch (e) {
      setErrMsg(e instanceof WalletApiError ? e.message : 'Failed to create order.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePlayMoneyTopUp = async () => {
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) {
      setErrMsg('Amount must be a positive number.');
      return;
    }
    if (!token) {
      setErrMsg('Please log in first.');
      return;
    }
    setSubmitting(true);
    setErrMsg(null);
    try {
      const resp = await topUpPlayMoney(token, { currency: 'USDT', amount: num }) as any;
      setSuccessMsg(`Play-money topup successful: +${resp.balance} coins`);
      if (onBalanceChange) onBalanceChange(resp.balance);
    } catch (e) {
      setErrMsg(e instanceof WalletApiError ? e.message : 'Top-up failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-md bg-bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-text-tertiary hover:text-text-primary p-1 rounded-lg hover:bg-white/5"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="p-4 border-b border-white/10">
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <CreditCard size={18} className="text-brand-gold" />
            Wallet
          </h2>
          <p className="text-xs text-text-tertiary">
            Balance: {user ? <span className="text-brand-gold font-mono">{fmtCoins(user.balance)}</span> : '--'} coins
          </p>
        </div>

        <div className="flex border-b border-white/10">
          {[
            { id: 'deposit', label: 'Deposit', icon: CreditCard },
            { id: 'history', label: 'History', icon: History },
            { id: 'settings', label: 'Settings', icon: Settings },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id as any)}
              className={cls(
                'flex-1 flex items-center justify-center gap-2 py-3 text-xs font-medium transition-colors',
                tab === item.id ? 'bg-brand-gold/10 text-brand-gold border-b-2 border-brand-gold' : 'text-text-tertiary hover:text-text-primary'
              )}
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {errMsg && (
            <div className="mb-3 p-3 rounded-xl bg-brand-red/10 border border-brand-red/20 text-brand-red text-xs">
              ⚠️ {errMsg}
            </div>
          )}
          {successMsg && (
            <div className="mb-3 p-3 rounded-xl bg-brand-green/10 border border-brand-green/20 text-brand-green text-xs">
              ✅ {successMsg}
            </div>
          )}

          {tab === 'deposit' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-2">Payment Gateway</label>
                <div className="grid grid-cols-2 gap-2">
                  {GATEWAYS.map((g) => (
                    <button
                      key={g.key}
                      onClick={() => setGateway(g.key)}
                      className={cls(
                        'p-3 rounded-xl border text-sm flex items-center gap-2 transition-colors',
                        gateway === g.key
                          ? 'bg-brand-gold/10 border-brand-gold text-brand-gold'
                          : 'bg-bg-elevated border-white/10 text-text-primary hover:border-white/20'
                      )}
                    >
                      <span>{g.icon}</span>
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-2">USDT Amount</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-bg-elevated border border-white/10 rounded-xl px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-gold"
                  placeholder="10"
                />
              </div>

              <button
                onClick={handleDeposit}
                disabled={submitting}
                className="w-full py-2.5 rounded-xl bg-brand-gold text-bg-primary font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
                {submitting ? 'Processing...' : 'Deposit'}
              </button>

              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10" /></div>
                <div className="relative flex justify-center text-[10px] uppercase text-text-tertiary">
                  <span className="bg-bg-card px-2">or test with play money</span>
                </div>
              </div>

              <button
                onClick={handlePlayMoneyTopUp}
                disabled={submitting}
                className="w-full py-2.5 rounded-xl border border-white/10 text-text-primary font-medium text-sm hover:bg-white/5 disabled:opacity-50"
              >
                {submitting ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
                Play Money Top-up
              </button>
            </div>
          )}

          {tab === 'history' && (
            <div>
              {loading ? (
                <div className="text-center py-6 text-text-tertiary">
                  <Loader2 className="animate-spin inline mr-2" size={14} />
                  Loading…
                </div>
              ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  <div>
                    <h3 className="text-sm font-semibold text-text-secondary mb-2">Coin Transactions</h3>
                    {walletHist.length === 0 ? (
                      <div className="text-xs text-text-tertiary py-2">No transactions yet.</div>
                    ) : (
                      <div className="space-y-1">
                        {walletHist.map((h) => (
                          <div key={h.id} className="flex justify-between items-center p-2 rounded bg-bg-elevated border border-white/5">
                            <div>
                              <div className="text-sm text-text-primary">{h.type === 'topup' ? '➕ Topup' : h.type}</div>
                              <div className="text-xs text-text-tertiary">{h.source} · {new Date(h.createdAt).toLocaleString()}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-sm font-mono text-brand-gold">+{fmtCoins(h.amount)} Coin</div>
                              {h.currency && h.amountDisplay && (
                                <div className="text-xs text-text-tertiary">({fmt(h.currency as SupportedCurrency, parseFloat(h.amountDisplay))})</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-text-secondary mb-2">Gateway Orders</h3>
                    {paymentHist.length === 0 ? (
                      <div className="text-xs text-text-tertiary py-2">No payment orders yet.</div>
                    ) : (
                      <div className="space-y-1">
                        {paymentHist.map((o) => (
                          <div key={o.id} className="flex justify-between items-center p-2 rounded bg-bg-elevated border border-white/5">
                            <div>
                              <div className="text-sm text-text-primary">{o.gateway === 'binance_pay' ? '🟡 Binance Pay' : '🔴 Redot Pay'}</div>
                              <div className="text-xs text-text-tertiary">{new Date(o.createdAt).toLocaleString()} · {o.merchantOrderId?.slice(0, 16)}…</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={cls(
                                'px-2 py-0.5 rounded text-[10px] font-medium uppercase',
                                o.status === 'paid' ? 'bg-brand-green/10 text-brand-green' :
                                o.status === 'pending' ? 'bg-brand-gold/10 text-brand-gold' :
                                o.status === 'expired' || o.status === 'failed' ? 'bg-brand-red/10 text-brand-red' :
                                'bg-brand-blue/10 text-brand-blue'
                              )}>
                                {o.status}
                              </span>
                              <div className="text-right">
                                <div className="text-sm font-mono text-text-primary">{fmtCoins(o.amountUsdt)} USDT</div>
                                <div className="text-xs text-text-tertiary">{fmtCoins(o.amountCoins)} coins</div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="text-sm text-text-secondary py-4">
              <p>Wallet display settings coming soon.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
