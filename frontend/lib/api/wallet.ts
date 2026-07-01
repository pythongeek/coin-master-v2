/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET API CLIENT — typed fetch wrappers for /api/wallet/* + payment/*
 * ═══════════════════════════════════════════════════════════════
 *
 *  All functions return parsed JSON. Throw on non-2xx.
 *  Auth token passed via Authorization header (JWT from /api/auth/login).
 *
 *  Used by:
 *    - components/wallet/WalletModal.tsx (deposit, history, settings tabs)
 *    - any future widget that needs wallet state
 *
 *  No external deps — pure fetch + types. Keeps the bundle small.
 * ═══════════════════════════════════════════════════════════════
 */

// ── Types ──────────────────────────────────────────────────────

export type SupportedCurrency = 'BDT' | 'USDT' | 'USD';
export type PaymentGateway = 'binance_pay' | 'redot_pay';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface DisplayBalances {
  coins: number;
  BDT: number;
  USDT: number;
  USD: number;
  rates: Record<SupportedCurrency, number>;
  ratesFetchedAt: string;
}

export interface WalletBalanceResponse {
  wallet: {
    userId: string;
    balanceCoins: number;
    preferredCurrency: SupportedCurrency;
    lastTopUpCurrency: SupportedCurrency | null;
    lastTopUpAt: string | null;
  };
  display: DisplayBalances;
}

export interface WalletRatesResponse {
  rates: Record<SupportedCurrency, number>;
  base: 'COIN';
  note: string;
  fetchedAt: string;
}

export interface WalletTopUpRequest {
  currency: SupportedCurrency;
  amount: number;
}
export interface WalletTopUpResponse {
  success: true;
  walletBalance: WalletBalanceResponse['wallet'];
  displayBalances: DisplayBalances;
  topUp: {
    amountCoins: number;
    amountCurrency: number;
    currency: SupportedCurrency;
    rate: number;
    transactionId: string;
  };
  message: string;
}

export interface PaymentOrder {
  id: string;
  gateway: PaymentGateway;
  gateway_order_id: string;
  merchant_order_id: string;
  amount_crypto: number;
  amount_coins: number;
  status: PaymentStatus;
  status_message: string | null;
  checkout_url: string;
  expires_at: string;
  confirmed_at: string | null;
  created_at: string;
}

export interface CreatePaymentRequest {
  gateway: PaymentGateway;
  amountUsdt: number;
  returnUrl?: string;
}
export interface CreatePaymentResponse {
  success: true;
  payment: {
    orderId: string;
    gatewayOrderId: string;
    checkoutUrl: string;
    qrCodeUrl?: string;
    expiresAt: string;
    amountCoins: number;
    gateway: PaymentGateway;
  };
}

export interface PaymentHealthResponse {
  providers: Array<{
    gateway: PaymentGateway;
    environment: 'sandbox' | 'live';
    healthy: boolean;
    error?: string;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

class WalletApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const errMsg =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string')
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new WalletApiError(errMsg, res.status, body);
  }
  return body as T;
}

// ── Public API ────────────────────────────────────────────────

export function getWalletBalance(token: string): Promise<WalletBalanceResponse> {
  return call('/api/wallet/balance', {}, token);
}

export function getWalletRates(token?: string): Promise<WalletRatesResponse> {
  return call('/api/wallet/rates', {}, token);
}

export function getWalletHistory(token: string, limit = 20): Promise<{ success: true; history: WalletHistoryEntry[] }> {
  return call(`/api/wallet/history?limit=${limit}`, {}, token);
}

export interface WalletHistoryEntry {
  id: string;
  type: 'topup' | 'adjustment' | 'bonus';
  amount_coins: string;       // PG returns numeric as string
  currency: SupportedCurrency | null;
  amount_display: string | null;
  rate_snapshot: string | null;
  source: string;
  note: string | null;
  created_at: string;
}

export function setPreferredCurrency(token: string, currency: SupportedCurrency): Promise<{ success: true; preferredCurrency: SupportedCurrency }> {
  return call('/api/wallet/preferred-currency', {
    method: 'POST',
    body: JSON.stringify({ currency }),
  }, token);
}

/** Play-money topup (Phase 2.4 fallback — only useful when no gateway is configured) */
export function topUp(token: string, req: WalletTopUpRequest): Promise<WalletTopUpResponse> {
  return call('/api/wallet/topup', {
    method: 'POST',
    body: JSON.stringify(req),
  }, token);
}

// ── Payment gateway endpoints (Phase B.1) ──────────────────────

export function createPaymentOrder(token: string, req: CreatePaymentRequest): Promise<CreatePaymentResponse> {
  return call('/api/wallet/payment/create', {
    method: 'POST',
    body: JSON.stringify(req),
  }, token);
}

export function listPaymentOrders(token: string, limit = 20): Promise<{ success: true; orders: PaymentOrder[] }> {
  return call(`/api/wallet/payment/orders?limit=${limit}`, {}, token);
}

export function getPaymentHealth(token: string): Promise<PaymentHealthResponse> {
  return call('/api/wallet/payment/health', {}, token);
}

export { WalletApiError };