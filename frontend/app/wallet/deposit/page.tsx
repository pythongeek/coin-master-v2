'use client';

/**
 * =============================================================
 *  DEPOSIT PAGE — Binance Pay "Receive any crypto" QR flow
 * =============================================================
 *
 *  Flow:
 *    1. User enters amount (10–10000 USDT)
 *    2. POST /api/wallet/deposit/qr/initiate → returns QR + memo + 30-min expiry
 *    3. User scans QR with Binance app, enters amount, sends
 *    4. Backend polls /sapi/v1/capital/deposit/hisrec every 15s
 *    5. UI polls GET /api/wallet/deposit/qr/:orderId every 5s
 *    6. On 'paid' → show success and offer to play
 *
 *  Optional: user uploads receipt screenshot for additional verification.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  QrCode as QrCodeIcon,
  Upload,
  X,
  AlertTriangle,
} from 'lucide-react';
import {
  initiateQrDeposit,
  getQrOrderStatus,
  getActiveQrDeposit,
  cancelQrDeposit,
  uploadQrReceipt,
  type InitiateQrDepositResponse,
  type QrOrderStatus,
} from '@/lib/api/wallet';
import { usePaymentUpdates } from '@/lib/usePaymentUpdates';
import ChainSelector from '@/components/wallet/ChainSelector';
import EquivalentAmounts from '@/components/wallet/EquivalentAmounts';
import { getFxRates, type FxRatesResponse } from '@/lib/api/wallet';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
}

export default function DepositPage() {
  const router = useRouter();
  const [amount, setAmount] = useState<string>('50');
  const [chainKey, setChainKey] = useState<string>('BSC');
  const [fxRates, setFxRates] = useState<FxRatesResponse | null>(null);
  const [order, setOrder] = useState<InitiateQrDepositResponse | null>(null);
  const [status, setStatus] = useState<QrOrderStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kycError, setKycError] = useState<{
    code: string;
    blockedBy: string;
    tier: number;
    requiredTier: number;
    userMessage: { en: string; bn: string };
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [receiptOk, setReceiptOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Countdown tick (1s) ─────────────────────────────────────
  useEffect(() => {
    if (!order) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [order]);

  // Load FX rates on mount + refresh every 60s
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await getFxRates();
        if (!cancelled) setFxRates(r);
      } catch (_) { /* keep stale rates on error */ }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // ── Status poll (5s while awaiting) ─────────────────────────
  useEffect(() => {
    if (!order) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await getQrOrderStatus(getToken(), order.orderId);
        if (!cancelled && res.order) setStatus(res.order.status);
      } catch {
        // ignore poll errors
      }
    };
    const id = setInterval(poll, 5000);
    poll(); // immediate
    return () => { cancelled = true; clearInterval(id); };
  }, [order]);

  // C3 fix: rehydrate any in-progress QR order on mount
  // (so reload / back-tab doesn't lose the order)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getActiveQrDeposit(getToken());
        if (!cancelled && res.order) {
          setOrder(res.order);
          setStatus('awaiting_payment');
        }
      } catch (_) { /* silent - no active order is fine */ }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Socket push - instant updates when backend detects credits/rejects
  usePaymentUpdates(
    null, // userId - not available client-side; we filter by orderId below
    (event) => {
      if (order && event.orderId === order.orderId) {
        setStatus(event.status);
      }
    },
    order?.orderId
  );

  // ── Submit ──────────────────────────────────────────────────
  async function handleInitiate() {
    setError(null);
    const n = parseFloat(amount);
    if (!isFinite(n) || n < 10 || n > 10000) {
      setError('Enter an amount between $10 and $10,000');
      return;
    }
    if (!getToken()) {
      router.push('/login?next=/wallet/deposit');
      return;
    }
    setSubmitting(true);
    try {
      const res = await initiateQrDeposit(getToken(), n, chainKey);
      setOrder(res);
      setStatus('awaiting_payment');
      setReceiptOk(false);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: Record<string, unknown> };
      if (e.code?.startsWith('KYC_') && e.details) {
        setKycError({
          code: e.code,
          blockedBy: String(e.details.blockedBy || ''),
          tier: Number(e.details.tier ?? 0),
          requiredTier: Number(e.details.requiredTier ?? 0),
          userMessage: (e.details.userMessage as { en: string; bn: string }) || { en: e.message || '', bn: '' },
        });
      } else {
        setError(e.message || 'Failed to create deposit');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setOrder(null);
    setStatus(null);
    setError(null);
    setReceiptOk(false);
  }

  // Cancel the in-progress order on the server too (so it stops counting
  // toward the daily cap and frees the memo for reuse).
  const [cancelling, setCancelling] = useState(false);
  async function handleCancel() {
    if (!order) return;
    if (!confirm('Cancel this deposit? Your QR code will stop working.')) return;
    setCancelling(true);
    try {
      await cancelQrDeposit(getToken(), order.orderId);
    } catch (_) {
      // Even if the server cancel fails (e.g. already expired), we still
      // clear the local state so the user isn't stuck.
    }
    setOrder(null);
    setStatus(null);
    setReceiptOk(false);
    setCancelling(false);
  }

  function handleCopy(label: string, text: string) {
    copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      }
    });
  }

  async function handleReceiptFile(file: File) {
    if (!order) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Receipt must be under 5MB');
      return;
    }
    setReceiptUploading(true);
    setError(null);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      await uploadQrReceipt(getToken(), order.orderId, dataUrl, file.name, file.type);
      setReceiptOk(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Receipt upload failed');
    } finally {
      setReceiptUploading(false);
    }
  }

  // ── Derived UI state ────────────────────────────────────────
  const expiresAtMs = order ? new Date(order.expiresAt).getTime() : 0;
  const remainingSec = order ? Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)) : 0;
  const expired = order && remainingSec === 0 && status !== 'paid';

  // ── Render ──────────────────────────────────────────────────
  return (
    <main className="min-h-screen p-4 md:p-8 max-w-2xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <QrCodeIcon size={24} className="text-brand-green" />
          Deposit USDT
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Pay with Binance app — scan QR, enter the amount, include the memo.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}
      {kycError && (
        <div className="mb-4 glass-card p-5 rounded-xl border border-amber-500/40">
          <div className="flex items-start gap-3 mb-3">
            <AlertTriangle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-text-primary font-bold mb-1">Verification required</h2>
              <p className="text-text-muted text-sm">
                {kycError.blockedBy === 'self_exclusion' && 'Your account is currently self-excluded from deposits.'}
                {kycError.blockedBy === 'sanctions' && 'Deposits are not available in your country.'}
                {kycError.blockedBy === 'age' && 'You must be at least 18 years old to deposit.'}
                {kycError.blockedBy === 'tier' && `Your Tier ${kycError.tier} limit is below the ${kycError.requiredTier} needed for this amount.`}
                {kycError.blockedBy === 'kyc_expired' && 'Your KYC verification has expired and needs to be renewed.'}
                {!kycError.blockedBy && kycError.userMessage?.en}
              </p>
              <p className="text-text-secondary text-xs mt-2 font-mono">
                {kycError.userMessage?.bn}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setKycError(null)}
              className="text-text-muted hover:text-text-primary text-sm"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {kycError.blockedBy === 'tier' && (
              <a href="/kyc" className="px-4 py-2 rounded-lg bg-brand-green/20 text-brand-green font-mono text-sm hover:bg-brand-green/30">
                Start verification →
              </a>
            )}
            {kycError.blockedBy === 'kyc_expired' && (
              <a href="/kyc" className="px-4 py-2 rounded-lg bg-brand-green/20 text-brand-green font-mono text-sm hover:bg-brand-green/30">
                Re-verify →
              </a>
            )}
            {kycError.blockedBy === 'sanctions' && (
              <a href="/support" className="px-4 py-2 rounded-lg bg-bg-elevated text-text-primary font-mono text-sm hover:bg-bg-elevated/70">
                Contact support
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                setKycError(null);
                const newAmt = parseFloat(amount) / 2;
                setAmount(String(newAmt));
              }}
              className="px-4 py-2 rounded-lg bg-bg-elevated text-text-primary font-mono text-sm hover:bg-bg-elevated/70"
            >
              Lower amount
            </button>
          </div>
        </div>
      )}


      {!order ? (
        <>
          <div className="glass-card p-6 rounded-xl mb-4">
            <label className="block text-sm font-mono text-text-muted mb-3">Choose network</label>
            <ChainSelector
              token={getToken()}
              selected={chainKey}
              onChange={setChainKey}
            />
          </div>
          <div className="glass-card p-6 rounded-xl">
            <label className="block text-sm font-mono text-text-muted mb-2">Amount (USDT)</label>
          <div className="flex gap-2 mb-4">
            {[20, 50, 100, 500].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                className={`px-4 py-2 rounded-lg font-mono text-sm border transition ${
                  amount === String(preset)
                    ? 'bg-brand-green/20 border-brand-green text-brand-green'
                    : 'border-border-default text-text-muted hover:border-brand-green/50'
                }`}
              >
                ${preset}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={10}
            max={10000}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full px-4 py-3 bg-bg-elevated border border-border-default rounded-lg font-mono text-lg text-text-primary focus:outline-none focus:border-brand-green"
            placeholder="Enter USDT amount"
          />
          {parseFloat(amount) > 0 && fxRates && (
            <div className="mt-2 p-2 rounded bg-bg-elevated/50 border border-border-default/50">
              <EquivalentAmounts
                amount={parseFloat(amount)}
                rates={fxRates.rates}
                compact
                freshLabel
                rateAgeSec={fxRates.freshness.ageSec ?? undefined}
              />
            </div>
          )}
          <p className="text-xs text-text-muted mt-2 font-mono">
            Min $10 · Max $10,000 · Daily cap $10,000
          </p>
          <button
            type="button"
            onClick={handleInitiate}
            disabled={submitting}
            className="mt-4 w-full btn-brand py-3 rounded-lg font-mono text-base flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Generating QR...
              </>
            ) : (
              <>Generate QR</>
            )}
          </button>
          </div>
        </>
      ) : (
        // ── Step 2: show QR + status ─────────────────────────
        <div className="space-y-4">
          {/* QR card */}
          <div className="glass-card p-6 rounded-xl text-center">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-mono text-text-muted">
                Order: <span className="text-text-primary">{order.orderId.slice(0, 16)}...</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling || status === 'paid'}
                  className="text-xs px-3 py-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 font-mono disabled:opacity-30"
                  title="Cancel this deposit and free the memo"
                >
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-text-muted hover:text-text-primary p-1"
                  aria-label="Start new deposit"
                  title="Start a new deposit"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="bg-white p-4 rounded-lg inline-block mb-4">
              <img src={order.qrPngDataUrl} alt="Binance Pay QR" width={240} height={240} />
            </div>

            <div className="mb-2">
              <EquivalentAmounts
                amount={order.amountUsdt}
                rates={fxRates?.rates}
                compact={false}
                freshLabel
                rateAgeSec={fxRates?.freshness.ageSec ?? undefined}
              />
            </div>
            <div className="text-xs text-text-muted font-mono">on {order.chain} ({order.token}){order.memoSupported ? " — include memo" : " — no memo needed"}</div>
          </div>

          {/* Address + memo */}
          <div className="glass-card p-4 rounded-xl space-y-3">
            <div>
              <div className="text-xs text-text-muted font-mono mb-1">Send to this address</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-bg-elevated rounded font-mono text-xs text-text-primary break-all">
                  {order.depositAddress}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy('address', order.depositAddress)}
                  className="p-2 rounded hover:bg-bg-elevated"
                  aria-label="Copy address"
                >
                  <Copy size={16} className={copied === 'address' ? 'text-brand-green' : 'text-text-muted'} />
                </button>
              </div>
            </div>
            {order.memoSupported ? (
              <div>
                <div className="text-xs text-text-muted font-mono mb-1">
                  Memo (required - must be included in the transfer)
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-bg-elevated rounded font-mono text-base text-brand-green font-bold tracking-wider">
                    {order.memo}
                  </code>
                  <button
                    type="button"
                    onClick={() => order.memo && handleCopy('memo', order.memo)}
                    className="p-2 rounded hover:bg-bg-elevated"
                    aria-label="Copy memo"
                  >
                    <Copy size={16} className={copied === 'memo' ? 'text-brand-green' : 'text-text-muted'} />
                  </button>
                </div>
                <p className="text-xs text-yellow-400/80 mt-1 font-mono">
                  Send the EXACT amount <strong className="text-text-primary">${'{'}order.amountUsdt.toFixed(2){'}'}</strong> with this memo. Network fee ~${'{'}order.avgFeeUsdt?.toFixed(2) || '0.50'{'}'}.
                </p>
              </div>
            ) : (
              <div>
                <div className="text-xs text-text-muted font-mono mb-1">
                  Important - EXACT amount required (no memo on this chain)
                </div>
                <p className="text-xs text-yellow-400/80 font-mono">
                  Send EXACTLY <strong className="text-text-primary text-base">${'{'}order.amountUsdt.toFixed(2){'}'} USDT</strong> to the address above.
                  This chain does not support memo tags - we will match by amount. Sending a different amount
                  will not be credited. Network fee ~${'{'}order.avgFeeUsdt?.toFixed(2) || '1.00'{'}'}.
                </p>
              </div>
            )}
          </div>

          {/* Countdown + status */}
          <div className="glass-card p-4 rounded-xl">
            {!expired && status !== 'paid' && status !== 'failed' && (
              <div className="flex items-center gap-2 text-text-muted font-mono text-sm">
                <Clock size={16} />
                QR expires in <span className="text-text-primary">{formatCountdown(remainingSec)}</span>
              </div>
            )}
            {status === 'awaiting_payment' && !expired && (
              <p className="text-sm text-text-muted mt-2">
                Waiting for your payment. After you send, we&apos;ll detect it automatically within ~15 seconds.
              </p>
            )}
            {status === 'detected' && (
              <div className="mt-2 flex items-center gap-2 text-yellow-400 text-sm font-mono">
                <Loader2 size={16} className="animate-spin" />
                Payment detected — verifying...
              </div>
            )}
            {status === 'verifying' && (
              <div className="mt-2 flex items-center gap-2 text-yellow-400 text-sm font-mono">
                <Clock size={16} />
                Under review. We&apos;ll credit your wallet shortly.
              </div>
            )}
            {status === 'paid' && (
              <div className="mt-2 flex items-center gap-2 text-brand-green text-base font-mono">
                <CheckCircle2 size={20} />
                Credited! Your balance has been updated.
              </div>
            )}
            {expired && (
              <div className="mt-2 flex items-center gap-2 text-red-400 text-sm font-mono">
                <AlertCircle size={16} />
                QR expired. Click below to generate a new one.
              </div>
            )}
            {status === 'failed' && (
              <div className="mt-2 flex items-center gap-2 text-red-400 text-sm font-mono">
                <AlertCircle size={16} />
                Payment rejected. Contact support if this is unexpected.
              </div>
            )}
          </div>

          {/* Receipt upload (optional) */}
          {status !== 'paid' && status !== 'failed' && !expired && (
            <div className="glass-card p-4 rounded-xl">
              <div className="text-sm font-mono text-text-muted mb-2">
                Optional: upload payment receipt screenshot
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleReceiptFile(f);
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={receiptUploading || receiptOk}
                className="w-full py-2 rounded-lg border border-border-default hover:border-brand-green/50 font-mono text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {receiptUploading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Uploading...
                  </>
                ) : receiptOk ? (
                  <>
                    <CheckCircle2 size={16} className="text-brand-green" />
                    Receipt uploaded
                  </>
                ) : (
                  <>
                    <Upload size={16} />
                    Choose image (PNG/JPG, max 5MB)
                  </>
                )}
              </button>
            </div>
          )}

          {status === 'paid' && (
            <button
              type="button"
              onClick={() => router.push('/game')}
              className="w-full btn-brand py-3 rounded-lg font-mono text-base"
            >
              Play now
            </button>
          )}
        </div>
      )}
    </main>
  );
}
