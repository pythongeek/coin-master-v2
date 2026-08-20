/**
 * ═══════════════════════════════════════════════════════════════
 *  DEPOSIT STATUS CONSTANTS — P2-11
 *  ─────────────────────────────────────────────────────────────
 *  Single source of truth for the `transactions` table status
 *  values (the on-chain deposit ledger — `transactions`, NOT
 *  `payment_orders` which has its own QR-flow status set).
 *
 *  The live DB CHECK constraint
 *    transactions_status_check
 *  enforces these exact 6 values:
 *    'pending', 'confirming', 'completed', 'failed',
 *    'cancelled', 'confirmed'
 *
 *  P2-11 fixes the drift where different services used slightly
 *  different string literals (notably `'completed'` vs `'confirmed'`
 *  in `reconciliation-engine.ts` — both are valid per the constraint
 *  but the inconsistency made status-flow code fragile).
 *
 *  Adding a new status here:
 *   1. Add the constant below.
 *   2. Update the live DB CHECK constraint (separate migration).
 *   3. Add the new value to any service that compares against it.
 *
 *  NOTE: `payment_orders.status` (the Binance Pay QR flow) has its
 *  own status set ('awaiting_payment', 'detected', 'verifying',
 *  'paid', 'failed', 'expired', 'cancelled'). It is a different
 *  table, a different lifecycle, and is intentionally NOT here —
 *  see `binance-pay-qr.service.ts` `QrOrderStatus` for that enum.
 */

export const DEPOSIT_STATUS = {
  /** Initial state — tx detected but not yet on the canonical chain */
  PENDING: 'pending',
  /** Tx seen on chain with N >= 1 confirmations but < required */
  CONFIRMING: 'confirming',
  /** Tx has required confirmations; balance credited */
  CONFIRMED: 'confirmed',
  /** Tx completed and the deposit was credited (post-confirm batch) */
  COMPLETED: 'completed',
  /** Tx failed (reorg, double-spend, validation error, etc.) */
  FAILED: 'failed',
  /** Tx was manually cancelled by operator */
  CANCELLED: 'cancelled',
} as const;

export type DepositStatus = typeof DEPOSIT_STATUS[keyof typeof DEPOSIT_STATUS];

/**
 * Set form for use in `WHERE status IN (...)` queries and array
 * membership checks. Pre-allocated so we don't allocate on every call.
 */
export const ALL_DEPOSIT_STATUSES: ReadonlyArray<DepositStatus> = Object.values(DEPOSIT_STATUS);

/**
 * P2-11 — QR-order status constants for the `payment_orders` table.
 *
 * Used by `binance-pay-qr.service.ts` for the Binance Pay QR deposit
 * flow. Different from `DEPOSIT_STATUS` because the QR flow is a
 * separate lifecycle: an order is created, the user scans the QR,
 * the ledger monitor detects the on-chain deposit, then the order
 * is reconciled to a `transactions` row (which uses DEPOSIT_STATUS).
 *
 * Schema reference: see migration `018_binance_pay_qr.sql` and the
 * live DB constraint `payment_orders_status_check`.
 */
export const QR_ORDER_STATUS = {
  /** Order created; user has not yet sent USDT */
  AWAITING_PAYMENT: 'awaiting_payment',
  /** Ledger monitor saw a matching on-chain deposit; amount verification pending */
  DETECTED: 'detected',
  /** LLM scorer is reviewing the deposit evidence (OCR, tx hash, etc.) */
  VERIFYING: 'verifying',
  /** LLM approved; user balance credited */
  PAID: 'paid',
  /** LLM rejected or manual review failed the order */
  FAILED: 'failed',
  /** 30-minute QR timer elapsed without payment */
  EXPIRED: 'expired',
  /** User manually cancelled the order via `cancelQrOrder` */
  CANCELLED: 'cancelled',
} as const;

export type QrOrderStatus = typeof QR_ORDER_STATUS[keyof typeof QR_ORDER_STATUS];

/**
 * Full QR-order record shape returned by `binance-pay-qr.service.ts`
 * `getQrOrderStatus`. Includes the `status: QrOrderStatus` union plus
 * the row metadata (orderId, amounts, memo, etc).
 */
export interface QrOrderStatusResponse {
  orderId: string;
  status: QrOrderStatus;
  amountUsdt: number;
  amountCoins: number;
  memo: string | null;
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

export const ALL_QR_ORDER_STATUSES: ReadonlyArray<QrOrderStatus> = Object.values(QR_ORDER_STATUS);
