/**
 * ═══════════════════════════════════════════════════════════════
 *  BINANCE PAY — payment provider implementation
 * ═══════════════════════════════════════════════════════════════
 *
 *  Auth: HMAC-SHA512(apiKey + timestamp + body, apiSecret)
 *  Timestamp window: 5 minutes (Binance-recommended)
 *  Webhook signature: HMAC-SHA512 with secret, in `binancepay-signature` header
 *
 *  Sandbox:
 *    https://bpay-sandbox.binanceapi.com  (test endpoint)
 *    https://bpay-sandbox.binance.com/pay  (user-facing checkout)
 *    Sandbox API key: https://testnet.binancefuture.com → Settings → API Management
 *
 *  Live:
 *    https://bpay.binanceapi.com  (API endpoint)
 *    https://pay.binance.com  (user-facing checkout)
 *
 *  Env vars:
 *    BINANCE_PAY_API_KEY      - 64-char hex key
 *    BINANCE_PAY_API_SECRET   - 64-char hex secret
 *    BINANCE_PAY_ENV          - 'sandbox' (default) or 'live'
 *
 *  SETUP TODO (when you get credentials):
 *    1. Register at https://merchant.binance.com (sandbox first)
 *    2. Get API key + secret
 *    3. Add to /root/coin-master/.env
 *    4. Set BINANCE_PAY_ENV=sandbox (or live)
 *    5. Configure webhook URL in dashboard:
 *       https://<your-public-host>/api/wallet/payment/binance/webhook
 *    6. Restart backend
 *
 *  API reference:
 *    https://developers.binance.com/docs/binance-pay/api-reference
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import {
  PaymentProvider, PaymentGateway, PaymentStatus,
  CreateOrderRequest, CreateOrderResponse,
  GetStatusResponse, WebhookPayload, WebhookRequest,
} from './types';

function _env(n: string) { return process.env[n] || ''; }
const _K = _env('BINANCE_PAY_API_KEY');
const _S = _env('BINANCE_PAY_API_SECRET');

// ── Config ─────────────────────────────────────────────────────
const API_KEY = process.env.BINANCE_PAY_API_KEY || '';
const API_SECRET = process.env.BINANCE_PAY_API_SECRET || '';
const ENV = (process.env.BINANCE_PAY_ENV === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live';

// Binance sandbox vs live endpoints
const BASE_URL = ENV === 'live'
  ? 'https://bpay.binanceapi.com'
  : 'https://bpay-sandbox.binanceapi.com';
const CHECKOUT_HOST = ENV === 'live'
  ? 'https://pay.binance.com'
  : 'https://testnet.binance.com/pay';

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes per Binance spec

// ── HMAC helpers ──────────────────────────────────────────────

/**
 * Sign a request per Binance Pay spec:
 *   timestamp + "\n" + apiKey + "\n" + body
 *   → HMAC-SHA512 → hex
 * Sent in `binancepay-timestamp` + `binancepay-signature` headers
 */
function signRequest(body: string, timestamp: number): string {
  const payload = `${timestamp}\n${API_KEY}\n${body}`;
  return crypto.createHmac('sha512', API_SECRET).update(payload).digest('hex');
}

/**
 * Verify a webhook signature:
 *   - timestamp in binancepay-timestamp header
 *   - signature in binancepay-signature header
 *   - HMAC-SHA512(timestamp + "\n" + body, secret) must equal signature
 *   - timestamp must be within window (replay protection)
 */
function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean {
  if (!API_SECRET) return false;
  if (!timestamp || !signature) return false;

  // Replay protection: timestamp must be within window
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Date.now();
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) return false;

  // Verify signature
  const expected = crypto
    .createHmac('sha512', API_SECRET)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────

async function binanceFetch<T>(
  path: string,
  body: Record<string, unknown>,
  timeout = 10000,
): Promise<T> {
  if (!API_KEY || !API_SECRET) {
    throw new Error('BINANCE_PAY_API_KEY / BINANCE_PAY_API_SECRET not configured');
  }
  const bodyStr = JSON.stringify(body);
  const timestamp = Date.now();
  const signature = signRequest(bodyStr, timestamp);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': String(timestamp),
        'BinancePay-Signature': signature,
        'X-BinancePay-Certificate-SN': API_KEY,
      },
      body: bodyStr,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance Pay HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ── Implementation ────────────────────────────────────────────

class BinancePayProvider implements PaymentProvider {
  readonly gateway: PaymentGateway = 'binance_pay';
  readonly environment = ENV;

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    const body = {
      env: { terminalType: 'WEB' },
      merchantTradeNo: req.merchantOrderId,
      orderAmount: req.amountUsdt,
      currency: 'USDT',
      goods: {
        goodsType: '01',  // 01 = digital goods
        goodsCategory: 'D000',  // "Others"
        referenceGoodsId: req.merchantOrderId,
        goodsName: req.description || `CryptoFlip deposit ${req.merchantOrderId}`,
      },
      returnUrl: req.returnUrl,
      cancelUrl: req.returnUrl,
      webhookUrl: process.env.WEBHOOK_BASE_URL
        ? `${process.env.WEBHOOK_BASE_URL}/api/webhooks/binance`
        : undefined,
    };

    const resp = await binanceFetch<{
      status: string;
      code: string;
      data?: { prepayId: string; expireTime: number; checkoutUrl?: string; qrCodeUrl?: string };
      errorMessage?: string;
    }>('/binancepay/openapi/v2/order', body);

    if (resp.status !== 'SUCCESS' || !resp.data) {
      throw new Error(`Binance Pay order creation failed: ${resp.errorMessage ?? resp.code}`);
    }

    // Binance Pay doesn't always return a hosted checkout URL — if missing,
    // construct one from prepayId (user opens Binance app or web to confirm).
    const checkoutUrl = resp.data.checkoutUrl
      ?? `${CHECKOUT_HOST}/checkouts/${resp.data.prepayId}`;

    return {
      gatewayOrderId: resp.data.prepayId,
      checkoutUrl,
      qrCodeUrl: resp.data.qrCodeUrl,
      expiresAt: new Date(resp.data.expireTime),
      rawResponse: resp,
    };
  }

  async getStatus(merchantOrderId: string): Promise<GetStatusResponse> {
    const body = { merchantTradeNo: merchantOrderId };
    const resp = await binanceFetch<{
      status: string;
      code: string;
      data?: {
        prepayId: string;
        merchantTradeNo: string;
        transactionId?: string;
        status: 'PAYING' | 'PAID' | 'FAILED' | 'EXPIRED';
        orderAmount: string;
        currency: string;
        openTime: number;
        closeTime?: number;
      };
      errorMessage?: string;
    }>('/binancepay/openapi/v2/order/query', body);

    if (resp.status !== 'SUCCESS' || !resp.data) {
      throw new Error(`Binance Pay status query failed: ${resp.errorMessage ?? resp.code}`);
    }

    // Map Binance status to our internal status
    const statusMap: Record<string, PaymentStatus> = {
      PAYING: 'pending',
      PAID: 'paid',
      FAILED: 'failed',
      EXPIRED: 'expired',
    };

    return {
      gatewayOrderId: resp.data.prepayId,
      merchantOrderId: resp.data.merchantTradeNo,
      status: statusMap[resp.data.status] ?? 'pending',
      amountUsdt: parseFloat(resp.data.orderAmount),
      paidAt: resp.data.closeTime ? new Date(resp.data.closeTime) : undefined,
      rawResponse: resp,
    };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    const tsHeader = req.headers['binancepay-timestamp'];
    const sigHeader = req.headers['binancepay-signature'];
    const ts = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!ts || !sig) return false;
    return verifyWebhookSignature(req.rawBody, ts, sig);
  }

  parseWebhook(req: WebhookRequest): WebhookPayload {
    const body = JSON.parse(req.rawBody);
    // Binance webhook format:
    // { bizType: 'PAY', data: { prepayId, merchantTradeNo, status, transactionId, ... } }
    const statusMap: Record<string, PaymentStatus> = {
      PAYING: 'pending',
      PAID: 'paid',
      FAILED: 'failed',
      EXPIRED: 'expired',
    };
    const d = body.data || {};
    return {
      gatewayOrderId: d.prepayId,
      merchantOrderId: d.merchantTradeNo,
      status: statusMap[d.status] ?? 'pending',
      amountUsdt: d.orderAmount ? parseFloat(d.orderAmount) : undefined,
      paidAt: d.transactionTime ? new Date(d.transactionTime) : undefined,
      rawPayload: body,
    };
  }

  getWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/api/webhooks/binance`;
  }

  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    if (!API_KEY || !API_SECRET) {
      return { healthy: false, error: 'BINANCE_PAY_API_KEY / SECRET not configured' };
    }
    // Binance has no public healthcheck endpoint — just verify creds present
    // (real connectivity check would cost an API call; defer to first real call)
    return { healthy: true };
  }
}

export const binancePay = new BinancePayProvider();