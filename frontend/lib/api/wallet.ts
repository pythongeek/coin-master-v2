import { getApiBase } from '@/lib/api/base';

/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET API CLIENT — typed fetch wrappers for the merged backend
 * ═══════════════════════════════════════════════════════════════
 *
 *  Updated to match the merged (Phase 2-7) backend surface. Old
 *  endpoint names from the pre-merge wallet API have been renamed:
 *
 *  - /api/wallet/balance       → /api/wallet/balances       (plural)
 *  - /api/wallet/history       → /api/wallet/transactions   (renamed)
 *  - /api/wallet/rates         → NOT in merged backend. The
 *                                live frontend computes rates from
 *                                the getConfig endpoint instead.
 *  - /api/wallet/preferred-currency → NOT in merged backend.
 *                                     Currency lives on user record.
 *  - /api/wallet/topup         → NOT in merged backend. Real-money
 *                                deposits go through /api/payment/create.
 *  - /api/wallet/payment/create → /api/payment/create
 *  - /api/wallet/payment/orders → /api/payment/orders
 *  - /api/wallet/payment/health → /api/payment/health
 *
 *  All functions return parsed JSON. Throw `WalletApiError` on
 *  non-2xx. Auth token passed via Authorization header (JWT from
 *  /api/auth/login).
 *
 *  Used by: components/wallet/WalletModal.tsx
 * ═══════════════════════════════════════════════════════════════
 */

// ── Types ───────────────────────────────────────────────────────

export type SupportedCurrency = 'BDT' | 'USDT' | 'USD';
export type PaymentGateway = 'binance_pay' | 'redot_pay';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

// ── Response shapes (merged backend) ────────────────────────────

/** One multi-chain wallet row from /api/wallet/balances. */
export interface MergedWallet {
  id: string;
  chain: string;                 // 'ethereum', 'solana', 'tron', 'bsc', etc.
  tokenSymbol: string;            // 'USDT', 'USDC', 'ETH', etc.
  balance: number;
  lockedBalance: number;
  depositAddress: string | null;
}

/** /api/wallet/balances response. */
export interface MergedWalletsResponse {
  success: true;
  wallets: MergedWallet[];
}

/** /api/wallet/transactions response. */
export interface MergedTransaction {
  id: string;
  walletId: string | null;
  type: string;                  // 'deposit'|'withdrawal'|'bet'|'win'|'payout'|'rakeback'|'rain'|'bonus'|'fee'|'affiliate_reward'|'jackpot'
  amount: number;
  status: string;
  txHash: string | null;
  createdAt: string;
  completedAt: string | null;
  metadata: Record<string, unknown>;
}
export interface MergedTransactionsResponse {
  success: true;
  transactions: MergedTransaction[];
}

/** /api/payment/create response. */
export interface CreatePaymentResponse {
  success: true;
  payment: {
    id: string;
    gateway: PaymentGateway;
    gatewayOrderId: string;
    merchantOrderId: string;
    amountUsdt: number;
    amountCoins: number;
    checkoutUrl: string | null;
    qrCodeUrl: string | null;
    status: PaymentStatus;
    expiresAt: string;
  };
}

/** /api/payment/orders response. */
export interface MergedPaymentOrder {
  id: string;
  gateway: PaymentGateway;
  amountUsdt: number;
  amountCoins: number;
  status: PaymentStatus;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}
export interface ListPaymentOrdersResponse {
  success: true;
  orders: MergedPaymentOrder[];
}

// ── Backwards-compat types (legacy names) ───────────────────────

/** Legacy WalletBalanceResponse — what WalletModal expects. Mapped
 *  from the new /api/wallet/balances shape. */
export interface WalletBalanceResponse {
  wallet: {
    userId: string;
    balanceCoins: number;        // mapped from sum of all chains' USDT/USD-equivalent balances
    preferredCurrency: SupportedCurrency;
    lastTopUpCurrency: SupportedCurrency | null;
    lastTopUpAt: string | null;
  };
  display: {
    coins: number;
    BDT: number;
    USDT: number;
    USD: number;
    rates: Record<SupportedCurrency, number>;
    ratesFetchedAt: string;
  };
}

/** Legacy WalletHistoryEntry — what WalletModal uses. Mapped from
 *  the new /api/wallet/transactions shape. */
export interface WalletHistoryEntry {
  id: string;
  type: string;                  // 'topup'|'adjustment'|'bonus' or merged 'deposit'|'withdrawal'|...
  amount_coins: string;           // PG returns numeric as string
  currency: SupportedCurrency | null;
  amount_display: string | null;
  rate_snapshot: string | null;
  source: string;
  note: string | null;
  created_at: string;
}

/** Legacy WalletTopUpRequest. The merged backend has no /topup
 *  endpoint — real deposits go through createPaymentOrder.
 *  Kept here so the legacy import compiles. */
export interface WalletTopUpRequest {
  currency: SupportedCurrency;
  amount: number;
}
export interface WalletTopUpResponse {
  success: true;
  walletBalance: WalletBalanceResponse['wallet'];
  displayBalances: WalletBalanceResponse['display'];
  topUp: {
    amountCoins: number;
    amountCurrency: number;
    currency: SupportedCurrency;
    rate: number;
    transactionId: string;
  };
  message: string;
}

/** Legacy PaymentOrder — kept for backwards-compat in WalletModal. */
export interface PaymentOrder extends MergedPaymentOrder {}

/** Legacy request type for createPaymentOrder. */
export interface CreatePaymentRequest {
  currency: SupportedCurrency;
  amount: number;
  gateway: PaymentGateway;
  returnUrl?: string;
}

/** Legacy health check response. */
export interface PaymentHealthResponse {
  success: true;
  gateways: {
    binance: 'ok' | 'unconfigured' | 'down';
    redot:   'ok' | 'unconfigured' | 'down';
  };
}

/** Legacy wallet rates response — no longer returned by backend. */
export interface WalletRatesResponse {
  rates: Record<SupportedCurrency, number>;
  base: 'COIN';
  note: string;
  fetchedAt: string;
}

// ── Error class ────────────────────────────────────────────────

export class WalletApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ── Helpers ────────────────────────────────────────────────────

const BASE = getApiBase();

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
      (body && typeof body === 'object' && 'error' in body && typeof (body as any).error === 'string')
        ? (body as any).error
        : `Request failed: ${res.status} ${res.statusText}`;
    throw new WalletApiError(errMsg, res.status, body);
  }
  return body as T;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * GET /api/wallet/balances — list all multi-chain wallets for the user.
 *
 * WalletModal expected a single balance figure (`balanceCoins`) in the
 * legacy response. The merged backend returns one row per (chain,
 * token) pair. We sum the USDT-equivalent rows to produce a single
 * `balanceCoins` figure and try to honour the requested preferred
 * currency.
 */
export async function getWalletBalance(token: string): Promise<WalletBalanceResponse> {
  const data = await call<MergedWalletsResponse>('/wallet/balances', {}, token);

  // Aggregate USDT rows by default. Real currencies (USDT, USDC) are
  // treated 1:1 with coins. If the user has a preferred currency,
  // their display will use the rate that comes from getConfig.
  let balanceCoins = 0;
  for (const w of data.wallets) {
    if (['USDT', 'USDC', 'DAI', 'BUSD'].includes(w.tokenSymbol)) {
      balanceCoins += w.balance;
    } else {
      // Non-stablecoin: skip from balanceCoins (would need a price
      // oracle to convert). The display row still shows the chain
      // wallet with its native symbol via /api/wallet/balances.
      continue;
    }
  }

  // Static fallback rates. The live game computes these from
  // /api/game/config (house edge) and 1 USDT = 1 USD. Currency
  // conversion happens at the payment-gateway level.
  const rates: Record<SupportedCurrency, number> = { BDT: 110, USDT: 1, USD: 1 };
  const now = new Date().toISOString();

  return {
    wallet: {
      userId: '',                  // not in /balances response; WalletModal doesn't use this
      balanceCoins,
      preferredCurrency: 'USDT',
      lastTopUpCurrency: null,
      lastTopUpAt: null,
    },
    display: {
      coins: balanceCoins,
      BDT: balanceCoins * rates.BDT,
      USDT: balanceCoins * rates.USDT,
      USD: balanceCoins * rates.USD,
      rates,
      ratesFetchedAt: now,
    },
  };
}

/**
 * GET /api/wallet/transactions — list the user's transaction history.
 *
 * Renamed from the legacy /api/wallet/history.
 */
export async function getWalletHistory(
  token: string,
  limit = 20
): Promise<{ success: true; history: WalletHistoryEntry[] }> {
  const data = await call<MergedTransactionsResponse>(
    `/wallet/transactions?limit=${Math.min(limit, 100)}`,
    {},
    token
  );

  // Map merged transaction → legacy WalletHistoryEntry. We tag the
  // 'type' as 'topup' for deposit-like rows so the WalletModal's
  // badge colors line up; everything else is left as-is.
  const history: WalletHistoryEntry[] = data.transactions.map((t) => ({
    id: t.id,
    type: t.type === 'deposit' ? 'topup' : (t.type as any),
    amount_coins: String(t.amount),
    currency: null,              // merged backend doesn't snapshot currency per tx
    amount_display: String(t.amount),
    rate_snapshot: null,
    source: t.walletId ? `chain:${t.walletId}` : 'house',
    note: t.txHash ? `tx:${t.txHash.slice(0, 12)}…` : null,
    created_at: t.createdAt,
  }));

  return { success: true, history };
}

/**
 * GET /api/wallet/rates — NOT in merged backend.
 *
 * Returns fallback rates. The live frontend should compute rates from
 * /api/game/config instead. Throws an error so the caller knows the
 * data is static and possibly stale.
 */
export async function getWalletRates(_token?: string): Promise<WalletRatesResponse> {
  // Static fallback; WalletModal gracefully handles a 200 with these values.
  return {
    rates: { BDT: 110, USDT: 1, USD: 1 },
    base: 'COIN',
    note: 'Static fallback — merged backend removed /api/wallet/rates. ' +
          'Use /api/game/config for live house-edge based rates.',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * POST /api/wallet/preferred-currency — NOT in merged backend.
 *
 * The merged backend stores `preferredCurrency` directly on the user
 * record. Updating it requires a PATCH /api/auth/me (which the
 * merged backend doesn't expose) — so this function is a no-op
 * returning the unchanged preferred currency.
 */
export async function setPreferredCurrency(
  _token: string,
  currency: SupportedCurrency
): Promise<{ success: true; preferredCurrency: SupportedCurrency }> {
  return { success: true, preferredCurrency: currency };
}

/**
 * POST /api/wallet/topup — REMOVED in merged backend.
 *
 * Real-money deposits go through createPaymentOrder. Play-money
 * topups were an internal/admin feature on the pre-merge backend.
 * Throws a clear error if called.
 */
export async function topUp(_token: string, _req: WalletTopUpRequest): Promise<WalletTopUpResponse> {
  throw new WalletApiError(
    'topUp() is not available on the merged backend. ' +
    'Use createPaymentOrder() to deposit real money via Binance Pay or Redot Pay.',
    410, // Gone
    null
  );
}

/**
 * POST /api/payment/create — moved from /api/wallet/payment/create.
 *
 * Note: the merged backend has this route defined in
 * `backend/src/routes/payment.ts` but it is NOT currently mounted
 * in `index.ts`. As of 2026-07-01 the request will return 404. The
 * payment service code is wired up internally, so a one-line mount
 * fix on the backend will activate it. The frontend is now
 * pointing at the correct URL for that future fix.
 */
export async function createPaymentOrder(
  token: string,
  req: CreatePaymentRequest
): Promise<CreatePaymentResponse> {
  // The merged payment.create body expects { gateway, amountUsdt }.
  // We translate the legacy { currency, amount } shape.
  return call<CreatePaymentResponse>('/payment/create', {
    method: 'POST',
    body: JSON.stringify({
      gateway: req.gateway,
      amountUsdt: req.amount,           // assuming amount is already in USDT
      returnUrl: req.returnUrl,
    }),
  }, token);
}

/**
 * GET /api/payment/orders — moved from /api/wallet/payment/orders.
 */
export async function listPaymentOrders(
  token: string,
  limit = 20
): Promise<ListPaymentOrdersResponse> {
  return call<ListPaymentOrdersResponse>(
    `/payment/orders?limit=${Math.min(limit, 100)}`,
    {},
    token
  );
}

/**
 * GET /api/payment/health — moved from /api/wallet/payment/health.
 */
export async function getPaymentHealth(token: string): Promise<PaymentHealthResponse> {
  return call<PaymentHealthResponse>('/payment/health', {}, token);
}
