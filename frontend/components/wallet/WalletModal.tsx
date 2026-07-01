'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET MODAL — Deposit / History / Settings (Phase B.1)
 * ═══════════════════════════════════════════════════════════════
 *
 *  3 tabs:
 *    1. Deposit — pick a gateway (Binance Pay / Redot Pay), enter USDT amount,
 *                 redirect to gateway's hosted checkout page.
 *                 Play-money topup is also available (Phase 2.4 fallback)
 *    2. History — list of recent topups + payment_orders
 *    3. Settings — preferred display currency toggle
 *
 *  Self-contained modal (builds its own backdrop, like LoginModal does).
 *  Uses Tailwind utility classes + design-system tokens for color/spacing.
 *
 *  WEBHOOK FLOW:
 *    User → gateway checkout → gateway sends webhook to
 *    https://<WEBHOOK_BASE_URL>/api/webhooks/{binance,redot}
 *    → backend credits wallet automatically
 *    → user refreshes the modal to see updated balance
 *
 *  RECONCILIATION:
 *    If the webhook misses (URL rotation, network glitch), the backend's
 *    reconciliation job (Phase B.2 — TODO) will poll the gateway every 5 min
 *    and credit missed payments.
 *
 *  USAGE:
 *    <WalletModal open={open} onClose={...} token={...} onBalanceChange={...} />
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useState, useCallback } from 'react';
import { X, Loader2 } from 'lucide-react';
import { Button } from '@/design-system/components/Button';
import { Input } from '@/design-system/components/Input';
import { Badge } from '@/design-system/components/Badge';
import { cn } from '@/design-system/components/utils';
import {
  getWalletBalance, getWalletHistory, setPreferredCurrency,
  createPaymentOrder, listPaymentOrders, topUp as topUpPlayMoney,
  WalletApiError,
  type SupportedCurrency, type PaymentGateway, type PaymentOrder,
  type WalletHistoryEntry, type WalletBalanceResponse,
} from '@/lib/api/wallet';

// ── Props ──────────────────────────────────────────────────────
export interface WalletModalProps {
  open: boolean;
  onClose: () => void;
  token: string;
  onBalanceChange?: (newBalanceCoins: number) => void;
}

// ── Tab ids ────────────────────────────────────────────────────
type TabId = 'deposit' | 'history' | 'settings';

// ── Currency formatter ────────────────────────────────────────
const CURRENCY_FORMATTERS: Record<SupportedCurrency, Intl.NumberFormat> = {
  BDT: new Intl.NumberFormat('bn-BD', { style: 'currency', currency: 'BDT', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  USDT: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2, currencyDisplay: 'code' }),
  USD: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

function fmt(currency: SupportedCurrency, amount: number): string {
  return CURRENCY_FORMATTERS[currency].format(amount);
}

function fmtCoins(amount: number): string {
  return amount.toFixed(2);
}

// ── Main component ────────────────────────────────────────────
export function WalletModal({ open, onClose, token, onBalanceChange }: WalletModalProps) {
  const [tab, setTab] = useState<TabId>('deposit');
  const [balance, setBalance] = useState<WalletBalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Escape closes the modal
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bal = await getWalletBalance(token);
      setBalance(bal);
      onBalanceChange?.(bal.wallet.balanceCoins);
    } catch (e) {
      setError(e instanceof WalletApiError ? e.message : 'ব্যালেন্স লোড করতে ব্যর্থ।');
    } finally {
      setLoading(false);
    }
  }, [token, onBalanceChange]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      data-testid="wallet-modal"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-bg-surface border border-white/10 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-bg-surface">
          <h2 className="text-xl font-display font-semibold text-text-primary">💰 Wallet</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet"
            className="text-text-tertiary hover:text-text-primary transition-colors p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4">
          {/* Tab switcher (built inline — design-system Tabs uses items[] API, not compound) */}
          <div className="grid grid-cols-3 gap-1 mb-4 p-1 rounded-lg bg-surface2 border border-white/5">
            {(['deposit', 'history', 'settings'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                  tab === id
                    ? 'bg-brand-gold/20 text-brand-gold'
                    : 'text-text-tertiary hover:text-text-primary',
                )}
              >
                {id === 'deposit' ? 'ডিপোজিট' : id === 'history' ? 'ইতিহাস' : 'সেটিংস'}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              ⚠️ {error}
            </div>
          )}

          {tab === 'deposit' && (
            <DepositTab
              token={token}
              balance={balance}
              loading={loading}
              onDepositComplete={() => {
                void refresh();
                setTab('history');
              }}
            />
          )}
          {tab === 'history' && <HistoryTab token={token} />}
          {tab === 'settings' && (
            <SettingsTab
              token={token}
              balance={balance}
              onUpdate={() => void refresh()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Deposit Tab ───────────────────────────────────────────────
interface DepositTabProps {
  token: string;
  balance: WalletBalanceResponse | null;
  loading: boolean;
  onDepositComplete: () => void;
}

function DepositTab({ token, balance, loading, onDepositComplete }: DepositTabProps) {
  const [gateway, setGateway] = useState<PaymentGateway>('binance_pay');
  const [amountUsdt, setAmountUsdt] = useState<string>('10');
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const handleDeposit = async () => {
    const num = parseFloat(amountUsdt);
    if (isNaN(num) || num <= 0) {
      setErrMsg('USDT amount ধনাত্মক সংখ্যা হতে হবে।');
      return;
    }
    setSubmitting(true);
    setErrMsg(null);
    try {
      const resp = await createPaymentOrder(token, {
        gateway,
        amountUsdt: num,
        returnUrl: typeof window !== 'undefined' ? `${window.location.origin}/wallet/return` : undefined,
      });
      // Open gateway checkout in a new tab
      if (typeof window !== 'undefined') {
        window.open(resp.payment.checkoutUrl, '_blank', 'noopener,noreferrer');
      }
      onDepositComplete();
    } catch (e) {
      setErrMsg(e instanceof WalletApiError ? e.message : 'অর্ডার তৈরি করতে ব্যর্থ।');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Balance summary */}
      <div className="p-4 rounded-lg bg-bg-elevated border border-white/5">
        <div className="text-xs text-text-tertiary mb-1">বর্তমান ব্যালেন্স</div>
        <div className="text-3xl font-bold text-brand-gold">
          {loading ? <Loader2 className="animate-spin inline" size={24} /> : fmtCoins(balance?.wallet.balanceCoins ?? 0)}
          {!loading && <span className="text-base text-text-tertiary"> Coin</span>}
        </div>
        {balance && (
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-text-secondary">
            <div>৳ {fmt('BDT', balance.display.BDT)}</div>
            <div>₮ {fmt('USDT', balance.display.USDT)}</div>
            <div>$ {fmt('USD', balance.display.USD)}</div>
          </div>
        )}
      </div>

      {/* Gateway picker */}
      <div>
        <label className="block text-sm text-text-secondary mb-2">পেমেন্ট গেটওয়ে</label>
        <div className="grid grid-cols-2 gap-2">
          <GatewayButton
            active={gateway === 'binance_pay'}
            onClick={() => setGateway('binance_pay')}
            label="Binance Pay"
            sublabel="USDT (sandbox)"
            icon="🟡"
          />
          <GatewayButton
            active={gateway === 'redot_pay'}
            onClick={() => setGateway('redot_pay')}
            label="Redot Pay"
            sublabel="USDT"
            icon="🔴"
          />
        </div>
      </div>

      {/* Amount input */}
      <div>
        <label className="block text-sm text-text-secondary mb-2">USDT পরিমাণ</label>
        <Input
          type="number"
          step="0.01"
          min="1"
          max="10000"
          value={amountUsdt}
          onChange={(e) => setAmountUsdt(e.target.value)}
          placeholder="10.00"
          size="lg"
        />
        <div className="mt-1 text-xs text-text-tertiary">
          ≈ {fmtCoins(parseFloat(amountUsdt) || 0)} Coin (1 Coin = 1 USDT)
        </div>
      </div>

      {/* Error */}
      {errMsg && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          ⚠️ {errMsg}
        </div>
      )}

      {/* Submit */}
      <Button
        variant="primary"
        size="lg"
        onClick={handleDeposit}
        disabled={submitting}
        className="w-full"
      >
        {submitting ? '⏳ প্রসেসিং…' : `${gateway === 'binance_pay' ? 'Binance Pay' : 'Redot Pay'}-এ পেমেন্ট করুন`}
      </Button>

      {/* Play-money fallback */}
      <div className="pt-4 border-t border-white/5">
        <div className="text-xs text-text-tertiary mb-2">
          💡 গেটওয়ে কনফিগার না হলে প্লে-মানি টপ-আপ ব্যবহার করুন:
        </div>
        <PlayMoneyTopup
          token={token}
          onComplete={onDepositComplete}
          preferredCurrency={balance?.wallet.preferredCurrency ?? 'USD'}
        />
      </div>
    </div>
  );
}

// ── GatewayButton (helper) ────────────────────────────────────
interface GatewayButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  sublabel: string;
  icon: string;
}
function GatewayButton({ active, onClick, label, sublabel, icon }: GatewayButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'p-3 rounded-lg border text-left transition-all',
        active
          ? 'border-brand-gold bg-brand-gold/10 ring-1 ring-brand-gold'
          : 'border-white/10 bg-bg-elevated hover:border-white/20',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className="text-xl">{icon}</span>
        <div>
          <div className="text-sm font-semibold text-text-primary">{label}</div>
          <div className="text-xs text-text-tertiary">{sublabel}</div>
        </div>
      </div>
    </button>
  );
}

// ── PlayMoneyTopup (Phase 2.4 fallback when no gateway configured) ──
interface PlayMoneyTopupProps {
  token: string;
  preferredCurrency: SupportedCurrency;
  onComplete: () => void;
}
function PlayMoneyTopup({ token, preferredCurrency, onComplete }: PlayMoneyTopupProps) {
  const [currency, setCurrency] = useState<SupportedCurrency>(preferredCurrency);
  const [amount, setAmount] = useState('10');
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const handle = async () => {
    setSubmitting(true);
    setErrMsg(null);
    try {
      await topUpPlayMoney(token, { currency, amount: parseFloat(amount) });
      onComplete();
    } catch (e) {
      setErrMsg(e instanceof WalletApiError ? e.message : 'টপ-আপ ব্যর্থ।');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value as SupportedCurrency)}
          className="px-2 py-1 rounded bg-bg-base border border-white/10 text-sm text-text-primary"
        >
          <option value="USD">USD ($)</option>
          <option value="USDT">USDT (₮)</option>
          <option value="BDT">BDT (৳)</option>
        </select>
        <Input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          size="sm"
        />
        <Button variant="secondary" size="sm" onClick={handle} disabled={submitting}>
          + Coin যোগ করুন
        </Button>
      </div>
      {errMsg && <div className="text-xs text-red-400">⚠️ {errMsg}</div>}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────
function HistoryTab({ token }: { token: string }) {
  const [walletHist, setWalletHist] = useState<WalletHistoryEntry[]>([]);
  const [paymentHist, setPaymentHist] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, p] = await Promise.all([
          getWalletHistory(token, 20),
          listPaymentOrders(token, 20),
        ]);
        if (cancelled) return;
        setWalletHist(w.history);
        setPaymentHist(p.orders);
      } catch (e) {
        if (!cancelled) setErrMsg(e instanceof WalletApiError ? e.message : 'ইতিহাস লোড ব্যর্থ।');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (loading) return <div className="text-center py-6 text-text-tertiary"><Loader2 className="animate-spin inline mr-2" size={14} />লোড হচ্ছে…</div>;
  if (errMsg) return <div className="text-red-400 text-sm">⚠️ {errMsg}</div>;

  return (
    <div className="space-y-4 max-h-96 overflow-y-auto">
      {/* Wallet topups */}
      <div>
        <h3 className="text-sm font-semibold text-text-secondary mb-2">কয়েন লেনদেন</h3>
        {walletHist.length === 0 ? (
          <div className="text-xs text-text-tertiary py-2">কোনো লেনদেন নেই।</div>
        ) : (
          <div className="space-y-1">
            {walletHist.map((h) => (
              <div key={h.id} className="flex justify-between items-center p-2 rounded bg-bg-elevated border border-white/5">
                <div>
                  <div className="text-sm text-text-primary">
                    {h.type === 'topup' ? '➕ Topup' : h.type}
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {h.source} · {new Date(h.created_at).toLocaleString('bn-BD')}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono text-brand-gold">
                    +{fmtCoins(parseFloat(h.amount_coins))} Coin
                  </div>
                  {h.currency && h.amount_display && (
                    <div className="text-xs text-text-tertiary">
                      ({fmt(h.currency as SupportedCurrency, parseFloat(h.amount_display))})
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Gateway payment orders */}
      <div>
        <h3 className="text-sm font-semibold text-text-secondary mb-2">গেটওয়ে অর্ডার</h3>
        {paymentHist.length === 0 ? (
          <div className="text-xs text-text-tertiary py-2">কোনো পেমেন্ট অর্ডার নেই।</div>
        ) : (
          <div className="space-y-1">
            {paymentHist.map((o) => (
              <div key={o.id} className="flex justify-between items-center p-2 rounded bg-bg-elevated border border-white/5">
                <div>
                  <div className="text-sm text-text-primary">
                    {o.gateway === 'binance_pay' ? '🟡 Binance Pay' : '🔴 Redot Pay'}
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {new Date(o.created_at).toLocaleString('bn-BD')} · {o.merchant_order_id.slice(0, 16)}…
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={
                    o.status === 'paid' ? 'success' :
                    o.status === 'pending' ? 'warning' :
                    o.status === 'expired' || o.status === 'failed' ? 'danger' :
                    'info'
                  }>
                    {o.status}
                  </Badge>
                  <div className="text-right">
                    <div className="text-sm font-mono text-text-primary">
                      {fmtCoins(o.amount_crypto)} USDT
                    </div>
                    <div className="text-xs text-text-tertiary">
                      ≈ {fmtCoins(o.amount_coins)} Coin
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Settings Tab ───────────────────────────────────────────────
interface SettingsTabProps {
  token: string;
  balance: WalletBalanceResponse | null;
  onUpdate: () => void;
}

function SettingsTab({ token, balance, onUpdate }: SettingsTabProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSet = async (currency: SupportedCurrency) => {
    setSaving(true);
    setSaved(false);
    try {
      await setPreferredCurrency(token, currency);
      setSaved(true);
      onUpdate();
      setTimeout(() => setSaved(false), 1500);
    } catch {
      /* error surfaced via balance fetch on parent */
    } finally {
      setSaving(false);
    }
  };

  const current = balance?.wallet.preferredCurrency ?? 'USD';

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm text-text-secondary mb-2">
          পছন্দের প্রদর্শন কারেন্সি
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(['USD', 'USDT', 'BDT'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => void handleSet(c)}
              disabled={saving}
              className={[
                'p-3 rounded-lg border text-sm transition-all',
                current === c
                  ? 'border-brand-gold bg-brand-gold/10 text-brand-gold font-semibold'
                  : 'border-white/10 bg-bg-elevated text-text-primary hover:border-white/20',
              ].join(' ')}
            >
              {c === 'USD' ? '$ USD' : c === 'USDT' ? '₮ USDT' : '৳ BDT'}
            </button>
          ))}
        </div>
        {saved && <div className="mt-2 text-xs text-green-400">✅ সংরক্ষিত</div>}
      </div>

      <div className="pt-4 border-t border-white/5 text-xs text-text-tertiary space-y-1">
        <div>গেটওয়ে ওয়েবহুক URL (মার্চেন্ট ড্যাশবোর্ডে সেট করুন):</div>
        <div className="font-mono bg-bg-base p-2 rounded border border-white/5 break-all">
          {`${process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ?? '<your-public-url>'}/api/webhooks/binance`}
        </div>
        <div className="font-mono bg-bg-base p-2 rounded border border-white/5 break-all">
          {`${process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ?? '<your-public-url>'}/api/webhooks/redot`}
        </div>
      </div>
    </div>
  );
}

// ── Default export + barrel ───────────────────────────────────
export default WalletModal;