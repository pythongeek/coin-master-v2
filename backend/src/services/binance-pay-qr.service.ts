/**
 * ═══════════════════════════════════════════════════════════════
 *  BINANCE PAY QR — "Receive in any cryptocurrency" flow
 * ═══════════════════════════════════════════════════════════════
 *
 *  No merchant account required. We use the personal Binance app's
 *  "Receive" QR, but generate a UNIQUE per-order QR that includes:
 *
 *    binance://pay?merchant=cryptoflip&crypto=USDT&network=BSC&address=0x...&memo=ABC12345
 *
 *  - `address` = our single shared BEP20 USDT deposit address (from env)
 *  - `memo`    = 8-char unique tag per order (idempotency key for ledger match)
 *  - `network` = BSC (BEP20 USDT — supports memo-tag, cheap fees)
 *
 *  When the user scans with Binance app, the app pre-fills the transfer:
 *    "Send 50 USDT on BSC to 0x... with memo ABC12345"
 *
 *  Detection happens in binance-pay-ledger-monitor.service.ts by polling
 *  /sapi/v1/capital/deposit/hisrec and matching addressTag == qr_memo.
 *
 *  ENV VARS REQUIRED (set in .env.production — NEVER commit):
 *    BINANCE_DEPOSIT_ADDRESS  - the BEP20 USDT receive address (0x...)
 *    BINANCE_DEPOSIT_NETWORK  - 'BSC' (default) — for future multi-chain support
 *    BINANCE_DEPOSIT_TOKEN    - 'USDT' (default)
 *    BINANCE_QR_EXPIRY_MIN    - minutes until QR expires (default 30)
 *
 *  SECURITY:
 *    - One shared receive address. Per-order matching via memo.
 *    - QR is generated server-side; user cannot tamper with address.
 *    - Memo is alphanumeric only, no special chars, max 32 chars.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import { emitPaymentUpdate } from './payment-socket.service';
import { coinsToCurrency } from './rate-fetcher';
import { getChainByKey, loadChainConfigs } from './chain-config.service';

// ── Config (read at boot, env-overridable) ─────────────────────
// Config (read at boot, env-overridable)
const QR_EXPIRY_MIN   = parseInt(process.env.BINANCE_QR_EXPIRY_MIN || "30", 10);
const MIN_DEPOSIT_USDT = 10;
const MAX_DEPOSIT_USDT = 10000;

// Multi-chain: per-chain config loaded via chain-config.service
// Legacy single-chain env vars (BINANCE_DEPOSIT_ADDRESS/NETWORK/TOKEN) are mapped to BSC fallback
const LEGACY_ADDRESS = (process.env.BINANCE_DEPOSIT_ADDRESS || '').trim();
const LEGACY_NETWORK = (process.env.BINANCE_DEPOSIT_NETWORK || 'BSC').trim();
const LEGACY_TOKEN   = (process.env.BINANCE_DEPOSIT_TOKEN   || 'USDT').trim();

// Alphanumeric memo (no 0/O/1/l confusion); 8 chars
const MEMO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateMemo(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += MEMO_ALPHABET[bytes[i] % MEMO_ALPHABET.length];
  }
  return out;
}

// ── Public types ───────────────────────────────────────────────
export interface InitiateQrDepositInput {
  userId: string;
  amountUsdt: number;
  chainKey?: string;            // defaults to BSC
  ip?: string;
  userAgent?: string;
}

export interface EquivalentAmounts {
  usdt: number;     // USDT amount (1:1 with coins)
  usd:  number;     // USD amount (market rate)
  bdt:  number;     // Bangladeshi Taka (market rate)
  rateTimestamp: string;  // ISO - when the rate was last refreshed
  rateAgeSec: number;     // seconds since rate fetched
}

export interface InitiateQrDepositResult {
  orderId: string;            // merchant_order_id (UUID prefixed with cf_)
  gatewayOrderId: string;     // same - we are our own gateway
  qrPayload: string;          // the binance:// URL the QR encodes
  qrPngDataUrl: string;       // base64 PNG for <img src=...>
  depositAddress: string;     // 0x... or T...
  chain: string;              // Binance network code: 'BSC', 'TRX', 'ETH'
  chainKey: string;           // our config key: 'BSC', 'TRC20', 'ERC20'
  token: string;              // 'USDT'
  memo: string | null;        // null for chains without memo support (TRC20)
  memoSupported: boolean;     // whether this chain supports memo-tag matching
  minConfirmations: number;   // for verifier + UI display
  estimatedSeconds: number;   // for UI: how long until detection
  avgFeeUsdt: number;         // for UI: customer's network fee
  amountUsdt: number;
  amountCoins: number;
  equivalent?: EquivalentAmounts;  // fiat equivalents at time of order
  expiresAt: Date;
  expiresInSec: number;
}

export interface QrOrderStatus {
  orderId: string;
  status: 'awaiting_payment' | 'detected' | 'verifying' | 'paid' | 'failed' | 'expired';
  amountUsdt: number;
  amountCoins: number;
  memo: string | null;        // null for chains without memo support (TRC20)
  depositAddress: string;
  expiresAt: Date;
  detectedAt?: Date;
  paidAt?: Date;
  llmVerdict?: string;
  llmConfidence?: number;
  llmReason?: string;
  binanceLedgerEntry?: unknown;
  receiptUploaded?: boolean;
}

// ── Initiate QR deposit ────────────────────────────────────────
export async function initiateQrDeposit(
  input: InitiateQrDepositInput
): Promise<InitiateQrDepositResult> {
  // 1) Resolve chain config (BSC default)
  const requestedKey = (input.chainKey || 'BSC').toUpperCase();
  const chain = await getChainByKey(requestedKey);
  if (!chain) {
    throw new Error(`Chain '${requestedKey}' is not enabled. Available chains: BSC, TRC20, ERC20 (contact admin to enable).`);
  }
  // 2) Validate address format per chain type
  const addr = chain.depositAddress;
  if (chain.networkCode === 'BSC' || chain.networkCode === 'ETH' || chain.networkCode === 'ARBITRUM') {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      throw new Error(`Chain ${chain.chainKey} address invalid: "${addr}". Must be 0x-prefixed 40-hex EVM address.`);
    }
  } else if (chain.networkCode === 'TRX') {
    if (!/^T[a-zA-Z0-9]{33}$/.test(addr)) {
      throw new Error(`Chain ${chain.chainKey} address invalid: "${addr}". Must be T-prefixed 34-char TRON address.`);
    }
  }
  // 3) Amount validation
  if (input.amountUsdt < MIN_DEPOSIT_USDT) {
    throw new Error(`Minimum deposit is $${MIN_DEPOSIT_USDT}`);
  }
  if (input.amountUsdt > MAX_DEPOSIT_USDT) {
    throw new Error(`Maximum deposit is $${MAX_DEPOSIT_USDT}`);
  }

  // Check daily cap (config-driven; admin can override via admin_settings
  // table with key 'deposit_daily_cap_usdt'). Default 10000 USDT.
  const { getRawSetting } = await import('./admin-config');
  const capSetting = await getRawSetting('deposit_daily_cap_usdt');
  const dailyCap = parseFloat(capSetting || '10000');
  const dailyTotal = await query(
    `SELECT COALESCE(SUM(amount_crypto), 0)::float8 AS total
     FROM payment_orders
     WHERE user_id = $1 AND gateway = 'binance_pay_qr'
       AND created_at > NOW() - INTERVAL '24 hours'
       AND status IN ('awaiting_payment', 'detected', 'verifying', 'paid')`,
    [input.userId]
  );
  const already = dailyTotal.rows[0]?.total || 0;
  if (already + input.amountUsdt > dailyCap) {
    throw new Error(`Daily deposit cap exceeded. Used ${already.toFixed(2)}/${dailyCap} USDT today.`);
  }

  // P3: Deposit-side KYC enforcement
  // Returns allowed=true if user meets all checks; blockedBy + reason if not.
  // In 'warn' enforcement_mode, hard blocks (self-exclusion, sanctions, age)
  // still apply; tier-required blocks are downgraded to warnings.
  const { checkDepositKyc } = await import('./kyc-enforcement.service');
  const kycCheck = await checkDepositKyc(input.userId, input.amountUsdt);
  if (!kycCheck.allowed) {
    // Re-throw with a structured error code so the frontend can show a nice panel
    const err = new Error(kycCheck.reason || 'Deposit blocked by KYC check') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    err.code = `KYC_${(kycCheck.blockedBy || 'UNKNOWN').toUpperCase()}`;
    err.details = {
      blockedBy: kycCheck.blockedBy,
      tier: kycCheck.tier,
      requiredTier: kycCheck.requiredTier,
      enforcementMode: kycCheck.enforcementMode,
      userMessage: kycCheck.userMessage,
    };
    throw err;
  }
  if (kycCheck.action === 'warn' && kycCheck.requiredTier > kycCheck.tier) {
    // Warn-only: deposit allowed but user should be nudged to upgrade
    console.log(`[deposit-kyc] WARN user=${input.userId} amount=${input.amountUsdt} tier=${kycCheck.tier} required=${kycCheck.requiredTier}`);
  }

  const merchantOrderId = `cf_${uuidv4().replace(/-/g, '')}`;
  const memo = generateMemo(8);
  const expiresAt = new Date(Date.now() + QR_EXPIRY_MIN * 60 * 1000);
  const fxRate = 1.0; // 1 USDT = 1 Coin (per Phase 2.4)
  const amountCoins = parseFloat((input.amountUsdt * fxRate).toFixed(8));

  // Build the QR payload — Binance app recognizes this scheme
  // (also works as https://app.binance.com/en/payment/send?... for non-app fallback)
  // Build Binance Pay URL. For chains WITHOUT memo support (TRC20), omit &memo param.
  const qrPayload =
    `binance://pay?merchant=cryptoflip` +
    `&crypto=${encodeURIComponent(chain.tokenSymbol)}` +
    `&network=${encodeURIComponent(chain.networkCode)}` +
    `&address=${encodeURIComponent(chain.depositAddress)}` +
    (chain.memoSupported ? `&memo=${encodeURIComponent(memo)}` : '') +
    `&amount=${encodeURIComponent(input.amountUsdt.toFixed(2))}` +
    // Embed orderId so support can find it in ledger (no-memo chains only)
    (chain.memoSupported ? '' : `&note=${encodeURIComponent('OrderID:' + merchantOrderId)}`);

  // Render QR PNG as data URL (no external request)
  const qrPngDataUrl = await QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#0b0e11', light: '#FFFFFF' },
  });

  // Insert the payment_orders row in status='awaiting_payment'
  await withTransaction(async (txQuery) => {
    await txQuery(
      `INSERT INTO payment_orders
        (user_id, gateway, gateway_order_id, merchant_order_id,
         crypto_currency, amount_crypto, fx_rate_snapshot, amount_coins,
         checkout_url, qr_code_url, qr_payload, qr_memo, qr_png_data_url,
         receive_address, chain, expires_at, status,
         memo_supported, match_strategy,
         ip_address, user_agent, metadata)
       VALUES ($1, 'binance_pay_qr', $2, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11,
               $12, $13, $14, 'awaiting_payment',
               $17, $18,
               $15::inet, $16, '{}'::jsonb)`,
      [
        input.userId, merchantOrderId,
        chain.tokenSymbol, input.amountUsdt, fxRate, amountCoins,
        qrPayload, qrPngDataUrl, qrPayload, memo, qrPngDataUrl,
        chain.depositAddress, chain.networkCode, expiresAt,
        input.ip || null, (input.userAgent || '').slice(0, 500),
        chain.memoSupported,
        chain.memoSupported ? 'memo' : 'amount',
      ]
    );
  });

  // Audit log
  await query(
    `INSERT INTO audit_log (user_id, category, action, severity, details)
     VALUES ($1, 'system', 'payment.qr_initiated', 'info', $2)`,
    [
      input.userId,
      JSON.stringify({
        orderId: merchantOrderId,
        amountUsdt: input.amountUsdt,
        memo,
        expiresAt: expiresAt.toISOString(),
        chain: chain.networkCode,
        chainKey: chain.chainKey,
        memoSupported: chain.memoSupported,
      }),
    ]
  );

  emitPaymentUpdate(input.userId, {
    orderId: merchantOrderId,
    userId: input.userId,
    status: 'awaiting_payment',
    amountUsdt: input.amountUsdt,
    amountCoins,
    reason: 'qr_initiated',
  });

  // Compute fiat equivalents using current market rates
  // (1 Coin = 1 USDT internally; convert via current Binance P2P rates)
  const usdEq = await coinsToCurrency(input.amountUsdt, 'USD');
  const bdtEq = await coinsToCurrency(input.amountUsdt, 'BDT');
  const cacheRow = await query(
    `SELECT fetched_at FROM rate_cache
     WHERE quote = 'BDT' AND expires_at > NOW() - INTERVAL '1 hour'
     ORDER BY fetched_at DESC LIMIT 1`
  );
  const rateTimestamp = cacheRow.rows.length > 0
    ? new Date(cacheRow.rows[0].fetched_at).toISOString()
    : new Date().toISOString();
  const rateAgeSec = cacheRow.rows.length > 0
    ? Math.floor((Date.now() - new Date(cacheRow.rows[0].fetched_at).getTime()) / 1000)
    : 0;

  return {
    orderId: merchantOrderId,
    gatewayOrderId: merchantOrderId,
    qrPayload,
    qrPngDataUrl,
    depositAddress: chain.depositAddress,
    chain: chain.networkCode,
    chainKey: chain.chainKey,
    token: chain.tokenSymbol,
    memo: chain.memoSupported ? memo : null,
    memoSupported: chain.memoSupported,
    minConfirmations: chain.minConfirmations,
    estimatedSeconds: chain.estimatedSeconds,
    avgFeeUsdt: chain.avgFeeUsdt,
    amountUsdt: input.amountUsdt,
    amountCoins,
    equivalent: {
      usdt: parseFloat(input.amountUsdt.toFixed(8)),
      usd: parseFloat(usdEq.toFixed(8)),
      bdt: parseFloat(bdtEq.toFixed(2)),
      rateTimestamp,
      rateAgeSec,
    },
    expiresAt,
    expiresInSec: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  };
}

// ── Get QR order status ────────────────────────────────────────
export async function getQrOrderStatus(
  orderId: string,
  userId: string
): Promise<QrOrderStatus | null> {
  const r = await query(
    `SELECT merchant_order_id, status, amount_crypto::float8 AS amount_usdt,
            amount_coins::float8 AS amount_coins, qr_memo, receive_address,
            expires_at, detected_at, confirmed_at,
            llm_verdict, llm_confidence::float8 AS llm_confidence, llm_reason,
            binance_ledger_entry, receipt_url
     FROM payment_orders
     WHERE merchant_order_id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (r.rows.length === 0) return null;

  const row = r.rows[0];

  // Auto-expire if past expiry and still pending
  if (
    row.status === 'awaiting_payment' &&
    new Date(row.expires_at).getTime() < Date.now()
  ) {
    await query(
      `UPDATE payment_orders SET status = 'expired', status_message = '30-minute QR timer elapsed',
              updated_at = NOW()
       WHERE merchant_order_id = $1 AND status = 'awaiting_payment'`,
      [orderId]
    );
    row.status = 'expired';
  }

  return {
    orderId: row.merchant_order_id,
    status: row.status,
    amountUsdt: row.amount_usdt,
    amountCoins: row.amount_coins,
    memo: row.qr_memo,
    depositAddress: row.receive_address,
    expiresAt: new Date(row.expires_at),
    detectedAt: row.detected_at ? new Date(row.detected_at) : undefined,
    paidAt: row.confirmed_at ? new Date(row.confirmed_at) : undefined,
    llmVerdict: row.llm_verdict,
    llmConfidence: row.llm_confidence,
    llmReason: row.llm_reason,
    binanceLedgerEntry: row.binance_ledger_entry,
    receiptUploaded: !!row.receipt_url,
  };
}

// ── Receipt upload (record path + sha256; actual file write handled in route) ──
export async function attachReceipt(
  orderId: string,
  userId: string,
  receipt: {
    filePath: string;
    originalName?: string;
    mimeType?: string;
    sizeBytes: number;
    sha256: string;
    ocrResult?: Record<string, unknown>;
  }
): Promise<void> {
  const orderCheck = await query(
    `SELECT id, status FROM payment_orders
     WHERE merchant_order_id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (orderCheck.rows.length === 0) {
    throw new Error('Order not found');
  }
  if (orderCheck.rows[0].status === 'paid') {
    throw new Error('Order already credited — receipt not needed');
  }
  if (orderCheck.rows[0].status === 'expired' || orderCheck.rows[0].status === 'failed') {
    throw new Error(`Order is ${orderCheck.rows[0].status} — receipt not accepted`);
  }

  await withTransaction(async (txQuery) => {
    await txQuery(
      `INSERT INTO deposit_receipt_files
        (order_id, user_id, file_path, original_name, mime_type, size_bytes, sha256, ocr_result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orderCheck.rows[0].id, userId,
        receipt.filePath, receipt.originalName || null,
        receipt.mimeType || null, receipt.sizeBytes, receipt.sha256,
        receipt.ocrResult ? JSON.stringify(receipt.ocrResult) : null,
      ]
    );
    await txQuery(
      `UPDATE payment_orders
       SET receipt_url = $1, receipt_sha256 = $2,
           receipt_ocr = $3::jsonb, receipt_uploaded_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [
        receipt.filePath, receipt.sha256,
        receipt.ocrResult ? JSON.stringify(receipt.ocrResult) : null,
        orderCheck.rows[0].id,
      ]
    );
  });

  await query(
    `INSERT INTO audit_log (user_id, category, action, severity, details)
     VALUES ($1, 'system', 'payment.receipt_uploaded', 'info', $2)`,
    [userId, JSON.stringify({ orderId, sha256: receipt.sha256, sizeBytes: receipt.sizeBytes })]
  );
}

// ── Expire stale orders (called by cron) ───────────────────────
export async function expireStaleQrOrders(): Promise<number> {
  const r = await query(
    `UPDATE payment_orders
     SET status = 'expired', status_message = 'QR expired without payment',
         updated_at = NOW()
     WHERE gateway = 'binance_pay_qr'
       AND status = 'awaiting_payment'
       AND expires_at < NOW()
     RETURNING merchant_order_id`
  );
  return r.rowCount || 0;
}


// --- Standalone expiration loop (runs independently of ledger monitor) ---
//
// Why separate from ledger-monitor loop?
// - The ledger-monitor is gated on a real Binance API key. When the key is
//   missing (dev, or the secret was rotated), the monitor never starts and
//   expired QR orders pile up forever, eating users' daily deposit caps.
// - This loop is unconditional: it ticks every 60s and expires anything
//   past expires_at. Cheap (single indexed UPDATE).
// - Keeps daily cap arithmetic honest.
//
// Idempotent: re-running on already-expired rows is a no-op (status != awaiting_payment).
let expirationStarted = false;
let expirationTimer: NodeJS.Timeout | null = null;

export function startQrExpirationLoop(intervalMs: number = 60_000): void {
  if (expirationStarted) return;
  expirationStarted = true;
  console.log(`[qr-expiration] loop started (interval=${intervalMs}ms)`);
  const tick = async () => {
    try {
      const n = await expireStaleQrOrders();
      if (n > 0) console.log(`[qr-expiration] expired ${n} stale order(s)`);
    } catch (err) {
      console.error('[qr-expiration] tick error:', err instanceof Error ? err.message : err);
    } finally {
      expirationTimer = setTimeout(tick, intervalMs);
    }
  };
  // Fire after 5s grace period (let DB connect first)
  expirationTimer = setTimeout(tick, 5_000);
}


// ── User-initiated cancel (delete) for an in-progress QR order ───
//
// Only valid for orders the user owns in status awaiting_payment.
// Marks the order as cancelled so it stops counting toward the daily cap
// and frees the memo for reuse. Does NOT affect the user's balance (none
// was credited yet).
export async function cancelQrOrder(
  merchantOrderId: string,
  userId: string,
): Promise<{ cancelled: boolean; reason?: string }> {
  const r = await query(
    `UPDATE payment_orders
     SET status = 'cancelled',
         status_message = 'Cancelled by user',
         updated_at = NOW()
     WHERE merchant_order_id = $1
       AND user_id = $2
       AND gateway = 'binance_pay_qr'
       AND status = 'awaiting_payment'
     RETURNING merchant_order_id`,
    [merchantOrderId, userId]
  );
  if (r.rowCount === 0) {
    return { cancelled: false, reason: 'Order not found, not awaiting payment, or not yours' };
  }
  return { cancelled: true };
}
