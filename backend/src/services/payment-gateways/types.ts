/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYMENT PROVIDER INTERFACE — common contract for all gateways
 * ═══════════════════════════════════════════════════════════════
 *
 *  Every payment gateway (Binance Pay, Redot Pay, etc.) implements
 *  this interface. The rest of the app talks ONLY to this interface —
 *  no gateway-specific code leaks into routes/services.
 *
 *  Lifecycle:
 *    1. Client calls POST /api/wallet/payment/create → provider.createOrder()
 *    2. Gateway returns checkout URL/QR → client redirects user
 *    3. User pays on gateway's hosted page
 *    4. Gateway sends webhook → /api/wallet/payment/{gateway}/webhook
 *       → provider.verifyWebhook() (HMAC check)
 *       → provider.parseWebhook() (extract status)
 *    5. (Backup) Reconciliation job polls provider.getStatus()
 *       for orders stuck in 'pending' state
 *
 *  IDEMPOTENCY:
 *    Every method uses `merchantOrderId` as the idempotency key.
 *    - createOrder: same merchantOrderId returns same order (no duplicate orders)
 *    - getStatus: stateless lookup
 *    - verifyWebhook + parseWebhook: stateless verification
 *
 *  SECURITY:
 *    - verifyWebhook MUST verify HMAC signature with provider's secret
 *    - Bad signature → return false (call site returns 401)
 *    - Replay window: 5min (configurable via REPLAY_WINDOW_SECS env)
 * ═══════════════════════════════════════════════════════════════
 */

// ── Common types ──────────────────────────────────────────────

export type PaymentGateway = 'binance_pay' | 'redot_pay';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface CreateOrderRequest {
  merchantOrderId: string;       // OUR unique ID (we generate this)
  userId: string;                // internal user UUID
  amountUsdt: number;            // amount in USDT (e.g. 10.50)
  description?: string;
  returnUrl?: string;            // URL to redirect after gateway checkout
}

export interface CreateOrderResponse {
  gatewayOrderId: string;        // gateway's order ID (Binance prepayId, Redot tradeNo)
  checkoutUrl: string;           // URL to redirect user to (hosted payment page)
  qrCodeUrl?: string;            // optional QR code image URL
  expiresAt: Date;               // when this payment expires (gateway-imposed)
  rawResponse?: unknown;         // full gateway response (for debugging/audit)
}

export interface GetStatusResponse {
  gatewayOrderId: string;
  merchantOrderId: string;
  status: PaymentStatus;
  amountUsdt: number;
  paidAt?: Date;
  rawResponse?: unknown;
}

export interface WebhookPayload {
  gatewayOrderId: string;
  merchantOrderId: string;
  status: PaymentStatus;
  amountUsdt?: number;
  paidAt?: Date;
  rawPayload: unknown;           // the original webhook body (for audit_log)
}

/** HTTP request shape passed to verifyWebhook */
export interface WebhookRequest {
  rawBody: string;               // raw, unparsed body (CRITICAL: must be raw for HMAC)
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

// ── Provider interface ────────────────────────────────────────

export interface PaymentProvider {
  readonly gateway: PaymentGateway;
  readonly environment: 'sandbox' | 'live';

  /** Create a new payment order. Returns gateway-specific checkout URL. */
  createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse>;

  /** Poll for current payment status. Used by reconciliation job. */
  getStatus(merchantOrderId: string): Promise<GetStatusResponse>;

  /**
   * Verify the webhook signature. MUST be HMAC-verified with provider secret.
   * Returns true if signature is valid AND within replay window.
   */
  verifyWebhook(req: WebhookRequest): boolean;

  /**
   * Parse a verified webhook into a normalized WebhookPayload.
   * ASSUMES verifyWebhook() has already returned true.
   */
  parseWebhook(req: WebhookRequest): WebhookPayload;

  /** Get the public webhook URL (for gateway dashboard configuration) */
  getWebhookUrl(baseUrl: string): string;

  /** Health check — does the provider respond? */
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}