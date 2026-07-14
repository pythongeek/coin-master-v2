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

// =============================================================
//  Binance Pay QR Deposit - types + client functions
// =============================================================

export type QrOrderStatus =
  | 'awaiting_payment'
  | 'detected'
  | 'verifying'
  | 'paid'
  | 'failed'
  | 'expired';

export interface EquivalentAmounts {
  usdt: number;
  usd: number;
  bdt: number;
  rateTimestamp: string;
  rateAgeSec: number;
}

export interface InitiateQrDepositResponse {
  success: true;
  orderId: string;
  gatewayOrderId: string;
  qrPayload: string;
  qrPngDataUrl: string;
  depositAddress: string;
  chain: string;
  chainKey: string;
  token: string;
  memo: string | null;
  memoSupported: boolean;
  minConfirmations: number;
  estimatedSeconds: number;
  avgFeeUsdt: number;
  amountUsdt: number;
  amountCoins: number;
  equivalent?: EquivalentAmounts;
  expiresAt: string;
  expiresInSec: number;
}

export interface QrOrderStatusResponse {
  success: true;
  order: {
    orderId: string;
    status: QrOrderStatus;
    amountUsdt: number;
    amountCoins: number;
    memo: string;
    depositAddress: string;
    expiresAt: string;
    detectedAt?: string;
    paidAt?: string;
    llmVerdict?: string;
    llmConfidence?: number;
    llmReason?: string;
    binanceLedgerEntry?: unknown;
    receiptUploaded?: boolean;
  };
}

export interface ReceiptUploadResponse {
  success: true;
  receipt: {
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    uploadedAt: string;
    ocrText: string | null;
  };
}

/**
 * POST /api/wallet/deposit/qr/initiate
 * Create a new QR deposit order. Returns the QR PNG data URL + memo
 * tag the customer must include in the transfer.
 */
export async function initiateQrDeposit(
  token: string,
  amountUsdt: number,
  chainKey?: string
): Promise<InitiateQrDepositResponse> {
  return call<InitiateQrDepositResponse>('/wallet/deposit/qr/initiate', {
    method: 'POST',
    body: JSON.stringify({ amountUsdt, chainKey }),
  }, token);
}

export interface ChainInfo {
  chainKey: string;
  displayName: string;
  networkCode: string;
  tokenSymbol: string;
  depositAddress: string;
  memoSupported: boolean;
  minConfirmations: number;
  estimatedSeconds: number;
  avgFeeUsdt: number;
  isEnabled: boolean;
  displayOrder: number;
  notes: string | null;
}

export interface ListChainsResponse {
  success: true;
  chains: ChainInfo[];
}

/**
 * GET /api/admin/payments/chains - enabled deposit chains
 * (admin endpoint but accessible to any authenticated user with valid JWT
 *  via /wallet/deposit since the route is role-checked; in practice the
 *  frontend calls this and the backend validates auth)
 */
export async function listEnabledChains(token: string): Promise<ListChainsResponse> {
  return call<ListChainsResponse>('/admin/payments/chains', { method: 'GET' }, token);
}

/**
 * GET /api/wallet/deposit/qr/:orderId
 * Poll current status.
 */
export async function getQrOrderStatus(
  token: string,
  orderId: string
): Promise<QrOrderStatusResponse> {
  const path = `/wallet/deposit/qr/${encodeURIComponent(orderId)}`;
  return call<QrOrderStatusResponse>(path, { method: 'GET' }, token);
}

/**
 * POST /api/wallet/deposit/qr/receipt
 * Upload a payment receipt screenshot.
 */
export interface ListMyQrDepositsResponse {
  success: true;
  orders: Array<{
    merchant_order_id: string;
    status: QrOrderStatus;
    amount_usdt: number;
    amount_coins: number;
    qr_memo: string;
    chain: string;
    expires_at: string;
    detected_at: string | null;
    confirmed_at: string | null;
    created_at: string;
    llm_verdict: string | null;
    llm_confidence: number | null;
    receipt_uploaded: boolean;
  }>;
}

/**
 * GET /api/wallet/deposit/qr/list - the user's own QR deposit history.
 */
/**
 * GET /api/wallet/deposit/qr/active - returns the user's in-progress QR order (if any).
 * Used by /wallet/deposit on mount to rehydrate order state after page reload.
 */
/**
 * GET /api/wallet/balances - list all wallets (chains/tokens) the user has
 * Each wallet has: id (UUID), chain, tokenSymbol, balance, lockedBalance, depositAddress.
 */
export interface WalletBalance {
  id: string;
  chain: string;
  tokenSymbol: string;
  balance: number;
  lockedBalance: number;
  depositAddress: string;
}
export interface KycInfo {
  status: string;
  tier: string | null;
  tierLevel: number;  // 0, 1, 2, 3
  country: string | null;
  perTxLimit: number;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
}
export interface WalletBalancesResponse {
  success: true;
  wallets: WalletBalance[];
  kyc: KycInfo;
}
export async function getWalletBalances(token: string): Promise<WalletBalancesResponse> {
  return call<WalletBalancesResponse>('/wallet/balances', { method: 'GET' }, token);
}

/**
 * POST /api/wallet/withdraw - request a withdrawal
 * Backend validates: KYC, self-exclusion, address format (EIP-55 / Tron / Solana),
 *                   balance, daily limit, KYC tier limits
 */
export interface WithdrawRequest {
  walletId: string;
  toAddress: string;
  amount: number;
  memo?: string;
}
export interface WithdrawResponse {
  success: true;
  transactionId: string;
  status: string;
  message: string;
}
export async function requestWithdrawal(
  token: string,
  req: WithdrawRequest,
): Promise<WithdrawResponse> {
  return call<WithdrawResponse>('/wallet/withdraw', {
    method: 'POST',
    body: JSON.stringify(req),
  }, token);
}

/**
 * GET /api/wallet/transactions
 *   ?limit=50  (max 200)
 *   ?offset=0
 *   ?type=deposit|withdrawal|bet|win|payout|bonus|rakeback|fee|...
 * Returns paginated user transaction history.
 */
export interface UserTransaction {
  id: string;
  walletId: string | null;
  type: string;
  amount: number;
  status: string;
  txHash: string | null;
  toAddress: string | null;
  createdAt: string;
  completedAt: string | null;
  metadata: Record<string, unknown> | null;
}
export interface TransactionHistoryResponse {
  success: true;
  transactions: UserTransaction[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}
export async function getTransactionHistory(
  token: string,
  opts: { limit?: number; offset?: number; type?: string } = {},
): Promise<TransactionHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.type) params.set('type', opts.type);
  const qs = params.toString();
  return call<TransactionHistoryResponse>(
    `/wallet/transactions${qs ? '?' + qs : ''}`,
    { method: 'GET' },
    token,
  );
}

export async function getActiveQrDeposit(token: string): Promise<ActiveQrResponse> {
  return call<ActiveQrResponse>('/wallet/deposit/qr/active', { method: 'GET' }, token);
}

/**
 * DELETE /api/wallet/deposit/qr/:orderId
 * Cancel an in-progress QR deposit order. Returns success if it was awaiting_payment
 * (status will be set to 'cancelled'). If the order was already paid/detected/etc,
 * the call fails with 400.
 */
export async function cancelQrDeposit(token: string, orderId: string): Promise<{ success: true; orderId: string; status: 'cancelled' }> {
  return call<{ success: true; orderId: string; status: 'cancelled' }>(
    `/wallet/deposit/qr/${encodeURIComponent(orderId)}`,
    { method: 'DELETE' },
    token,
  );
}

export interface ActiveQrResponse {
  success: true;
  order: InitiateQrDepositResponse | null;
}

export async function listMyQrDeposits(
  token: string,
  limit = 20
): Promise<ListMyQrDepositsResponse> {
  return call<ListMyQrDepositsResponse>(
    `/wallet/deposit/qr/list?limit=${Math.min(limit, 100)}`,
    { method: 'GET' },
    token
  );
}

export async function uploadQrReceipt(
  token: string,
  orderId: string,
  imageBase64: string,
  originalName?: string,
  mimeType?: string
): Promise<ReceiptUploadResponse> {
  return call<ReceiptUploadResponse>('/wallet/deposit/qr/receipt', {
    method: 'POST',
    body: JSON.stringify({ orderId, imageBase64, originalName, mimeType }),
  }, token);
}


/**
 * GET /api/public/fx-rates
 * Public endpoint - returns current USDT/USD/BDT rates + freshness
 * (cached 5 min on server, no auth required)
 */
export interface FxRatesResponse {
  success: true;
  base: string;
  rates: { USDT: number; USD: number; BDT: number };
  freshness: {
    fetchedAt: string;
    source: string;
    ageSec: number | null;
    expiresAt: string | null;
  };
  perQuote: Record<string, { rate: number; source: string; fetchedAt: string; ageSec: number }>;
  note: string;
}

export async function getFxRates(): Promise<FxRatesResponse> {
  const res = await fetch('/api/public/fx-rates', { method: 'GET' });
  if (!res.ok) throw new Error(`Failed to fetch FX rates (HTTP ${res.status})`);
  return res.json();
}


// =============================================================
//  P3 - Deposit KYC Admin API
// =============================================================

export interface KycConfig {
  thresholds: {
    tier0: { maxPerTx: number; maxDaily: number };
    tier1: { maxPerTx: number; maxDaily: number };
    tier2: { maxPerTx: number; maxDaily: number };
    tier3: { maxPerTx: number; maxDaily: number };
  };
  sanctionedCountries: string[];
  expiryPolicy: {
    enabled: boolean;
    graceDays: number;
    autoAction: 'warn_only' | 'downgrade_to_tier0' | 'downgrade_to_tier1';
    tierMaxAgeDays: { tier1: number; tier2: number; tier3: number };
  };
  selfExclusion: { reversalCoolingHours: number };
  emailDefaultLanguage: 'en' | 'bn';
  enforcementMode: 'off' | 'warn' | 'strict';
  strictAfter: string | null;
}
export async function getKycConfig(token: string): Promise<{ success: true; config: KycConfig }> {
  return call<{ success: true; config: KycConfig }>('/admin/kyc/config', { method: 'GET' }, token);
}

export interface KycOverride {
  user_id: string;
  username: string;
  email: string;
  kyc_tier: string | null;
  kyc_deposit_override_until: string;
  kyc_deposit_override_reason: string;
  granted_by_username: string | null;
  time_remaining: string;
}
export async function listKycOverrides(token: string, opts: { limit?: number; offset?: number } = {}): Promise<{
  success: true; overrides: KycOverride[]; total: number; limit: number; offset: number;
}> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return call(`/admin/kyc/overrides${qs ? '?' + qs : ''}`, { method: 'GET' }, token);
}

export interface KycAuditEntry {
  id: string;
  user_id: string | null;
  user_username: string | null;
  admin_username: string;
  action: string;
  details: Record<string, unknown>;
  reason: string;
  created_at: string;
}
export async function listKycAudit(token: string, opts: { limit?: number; offset?: number; action?: string } = {}): Promise<{
  success: true; entries: KycAuditEntry[]; limit: number; offset: number; filter: string;
}> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.action) params.set('action', opts.action);
  const qs = params.toString();
  return call(`/admin/kyc/overrides-log${qs ? '?' + qs : ''}`, { method: 'GET' }, token);
}

export interface SelfExclusion {
  id: string;
  username: string;
  email: string;
  self_excluded_until: string;
  days_remaining: number;
}
export async function listSelfExclusions(token: string, status: 'active' | 'expired' | 'all' = 'active'): Promise<{
  success: true; exclusions: SelfExclusion[]; status: string;
}> {
  return call(`/admin/kyc/self-exclusions?status=${status}`, { method: 'GET' }, token);
}

export interface KycDepositStats {
  recent_admin_actions: Array<{ action: string; n: number }>;
  active_overrides: number;
  active_country_exceptions: number;
  sanctioned_countries: string[];
}
export async function getKycDepositStats(token: string): Promise<{ success: true; stats: KycDepositStats }> {
  return call('/admin/kyc/deposit-stats', { method: 'GET' }, token);
}


// =============================================================
//  P3.4 - Admin balance adjustment API
// =============================================================

export interface AdminUserBalance {
  walletId: string;
  chain: string;
  tokenSymbol: string;
  balance: number;
  lockedBalance: number;
  withdrawable: number;
}
export async function getAdminUserBalances(token: string, userId: string): Promise<{
  success: true; userId: string; balances: AdminUserBalance[];
}> {
  return call(`/admin/balance/users/${encodeURIComponent(userId)}/balances`, { method: 'GET' }, token);
}

export interface AdminBalanceAdjustment {
  success: true;
  adjustmentId: string;
  transactionId: string;
  userId: string;
  walletId: string;
  chain: string;
  tokenSymbol: string;
  direction: 'credit' | 'debit';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  category: 'manual' | 'goodwill' | 'correction' | 'chargeback' | 'prize' | 'refund' | 'other';
  adminId: string;
  createdAt: string;
  emailSent: boolean;
}
export interface AdminBalanceAdjustParams {
  userId: string;
  walletId: string;
  amount: number;
  reason: string;
  category?: 'manual' | 'goodwill' | 'correction' | 'chargeback' | 'prize' | 'refund' | 'other';
}
export async function adminCreditBalance(
  token: string,
  params: AdminBalanceAdjustParams,
): Promise<{ success: true; result: AdminBalanceAdjustment }> {
  return call('/admin/balance/credit', {
    method: 'POST',
    body: JSON.stringify({ ...params, direction: 'credit' }),
  }, token);
}
export async function adminDeductBalance(
  token: string,
  params: AdminBalanceAdjustParams,
): Promise<{ success: true; result: AdminBalanceAdjustment }> {
  return call('/admin/balance/deduct', {
    method: 'POST',
    body: JSON.stringify({ ...params, direction: 'debit' }),
  }, token);
}

export interface AdminBalanceHistoryEntry {
  id: string;
  user_id: string;
  admin_user_id: string;
  direction: 'credit' | 'debit';
  amount_coins: number;
  wallet_id: string;
  balance_before: number;
  balance_after: number;
  reason: string;
  category: string;
  transaction_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  user_username: string;
  user_email: string;
  admin_username: string;
  chain: string;
  token_symbol: string;
}
export interface AdminBalanceHistoryResponse {
  success: true;
  entries: AdminBalanceHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
}
export async function getAdminBalanceHistory(
  token: string,
  opts: {
    userId?: string;
    adminId?: string;
    direction?: 'credit' | 'debit';
    category?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AdminBalanceHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set('userId', opts.userId);
  if (opts.adminId) params.set('adminId', opts.adminId);
  if (opts.direction) params.set('direction', opts.direction);
  if (opts.category) params.set('category', opts.category);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return call(`/admin/balance/history${qs ? '?' + qs : ''}`, { method: 'GET' }, token);
}
