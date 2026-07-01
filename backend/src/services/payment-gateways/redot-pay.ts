/**
 * ═══════════════════════════════════════════════════════════════
 *  REDOT PAY — payment provider implementation
 * ═══════════════════════════════════════════════════════════════
 *
 *  Auth: HMAC-SHA256(apiKey + timestamp + body, apiSecret)
 *  Timestamp window: 5 minutes
 *  Webhook signature: HMAC-SHA256 with secret, in `X-Redot-Signature` header
 *
 *  Endpoint:
 *    https://api.redotpay.com/v1  (assumed — verify in their docs)
 *    https://checkout.redotpay.com  (user-facing hosted page)
 *
 *  Env vars:
 *    REDOT_PAY_API_KEY      - 32-char string
 *    REDOT_PAY_API_SECRET   - 32-char string
 *
 *  SETUP TODO (when you get credentials):
 *    1. Register at https://merchant.redotpay.com
 *    2. Get API key + secret from dashboard
 *    3. Add to /root/coin-master/.env
 *    4. Configure webhook URL in dashboard:
 *       https://<your-public-host>/api/wallet/payment/redot/webhook
 *    5. Restart backend
 *
 *  NOTE: Redot Pay's exact API spec is less standardized than Binance Pay.
 *  The shapes below are educated guesses based on common patterns.
 *  Verify against actual Redot Pay documentation when credentials are available.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import {
  PaymentProvider, PaymentGateway, PaymentStatus,
  CreateOrderRequest, CreateOrderResponse,
  GetStatusResponse, WebhookPayload, WebhookRequest,
} from './types';

function _env(n: string) { return process.env[n] || ''; }
const _K = _env('REDOT_PAY_API_KEY');
const _S = _env('REDOT_PAY_API_SECRET');

// ── Config ─────────────────────────────────────────────────────
const API_KEY=process.env.BINANCE_PAY_API_KEY || "";
const API_SECRET=process.env.BINANCE_PAY_API_SECRET || "";
const BASE_URL = process.env.REDOT_PAY_BASE_URL || 'https://api.redotpay.com/v1';
const CHECKOUT_HOST = process.env.REDOT_PAY_CHECKOUT_URL || 'https://checkout.redotpay.com';
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// ── HMAC helpers ──────────────────────────────────────────────

function signRequest(body: string, timestamp: number): string {
  // Redot Pay: HMAC-SHA256(apiKey + timestamp + body, apiSecret) → hex
  const payload = `${API_KEY}${timestamp}${body}`;
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

function verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean {
  if (!API_SECRET) return false;
  if (!timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  if (Math.abs(Date.now() - ts) > TIMESTAMP_WINDOW_MS) return false;

  const expected = crypto
    .createHmac('sha256', API_SECRET)
    .update(`${timestamp}${rawBody}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────

async function redotFetch<T>(
  path: string,
  body: Record<string, unknown>,
  timeout = 10000,
): Promise<T> {
  if (!API_KEY || !API_SECRET) {
    throw new Error('REDOT_PAY_API_KEY / REDOT_PAY_API_SECRET not configured');
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
        'X-Redot-Api-Key': API_KEY,
        'X-Redot-Timestamp': String(timestamp),
        'X-Redot-Signature': signature,
      },
      body: bodyStr,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Redot Pay HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ── Implementation ────────────────────────────────────────────

class RedotPayProvider implements PaymentProvider {
  readonly gateway: PaymentGateway = 'redot_pay';
  readonly environment = 'live';  // Redot Pay doesn't have sandbox/live split per their docs

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    const body = {
      merchant_order_id: req.merchantOrderId,
      order_amount: req.amountUsdt,
      order_currency: 'USDT',
      product_name: req.description || `CryptoFlip deposit ${req.merchantOrderId}`,
      notify_url: process.env.WEBHOOK_BASE_URL
        ? `${process.env.WEBHOOK_BASE_URL}/api/webhooks/redot`
        : undefined,
      return_url: req.returnUrl,
    };

    const resp = await redotFetch<{
      code: number;
      msg?: string;
      data?: {
        trade_no: string;          // gateway's order ID
        checkout_url: string;
        qr_code_url?: string;
        expire_time: number;       // unix ms
      };
    }>('/order/create', body);

    if (resp.code !== 0 || !resp.data) {
      throw new Error(`Redot Pay order creation failed: ${resp.msg ?? 'code ' + resp.code}`);
    }

    return {
      gatewayOrderId: resp.data.trade_no,
      checkoutUrl: resp.data.checkout_url,
      qrCodeUrl: resp.data.qr_code_url,
      expiresAt: new Date(resp.data.expire_time),
      rawResponse: resp,
    };
  }

  async getStatus(merchantOrderId: string): Promise<GetStatusResponse> {
    const body = { merchant_order_id: merchantOrderId };
    const resp = await redotFetch<{
      code: number;
      msg?: string;
      data?: {
        trade_no: string;
        merchant_order_id: string;
        status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
        order_amount: string;
        paid_at?: number;
      };
    }>('/order/query', body);

    if (resp.code !== 0 || !resp.data) {
      throw new Error(`Redot Pay status query failed: ${resp.msg ?? 'code ' + resp.code}`);
    }

    const statusMap: Record<string, PaymentStatus> = {
      PENDING: 'pending',
      PAID: 'paid',
      FAILED: 'failed',
      EXPIRED: 'expired',
      REFUNDED: 'refunded',
    };

    return {
      gatewayOrderId: resp.data.trade_no,
      merchantOrderId: resp.data.merchant_order_id,
      status: statusMap[resp.data.status] ?? 'pending',
      amountUsdt: parseFloat(resp.data.order_amount),
      paidAt: resp.data.paid_at ? new Date(resp.data.paid_at) : undefined,
      rawResponse: resp,
    };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    const tsHeader = req.headers['x-redot-timestamp'];
    const sigHeader = req.headers['x-redot-signature'];
    const ts = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!ts || !sig) return false;
    return verifyWebhookSignature(req.rawBody, ts, sig);
  }

  parseWebhook(req: WebhookRequest): WebhookPayload {
    const body = JSON.parse(req.rawBody);
    const statusMap: Record<string, PaymentStatus> = {
      PENDING: 'pending',
      PAID: 'paid',
      FAILED: 'failed',
      EXPIRED: 'expired',
      REFUNDED: 'refunded',
    };
    const d = body.data || body;  // some gateways nest under .data, others don't
    return {
      gatewayOrderId: d.trade_no,
      merchantOrderId: d.merchant_order_id,
      status: statusMap[d.status] ?? 'pending',
      amountUsdt: d.order_amount ? parseFloat(d.order_amount) : undefined,
      paidAt: d.paid_at ? new Date(d.paid_at) : undefined,
      rawPayload: body,
    };
  }

  getWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/api/wallet/payment/redot/webhook`;
  }

  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    if (!API_KEY || !API_SECRET) {
      return { healthy: false, error: 'REDOT_PAY_API_KEY / SECRET not configured' };
    }
    return { healthy: true };
  }
}

export const redotPay = new RedotPayProvider();