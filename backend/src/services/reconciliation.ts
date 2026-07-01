/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYMENT RECONCILIATION SERVICE (Phase B.2)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Recovers from missed webhooks (URL rotation, network glitches).
 *  Polls every pending payment_order older than 1 minute via the
 *  gateway's getStatus(), and runs the same handler as the webhook
 *  when the status changes.
 *
 *  Scheduling (one of):
 *    (a) Node setInterval inside the backend process (simple, dies with backend)
 *    (b) External cron (requires infra setup)
 *    (c) Manual trigger via /api/admin/payment/reconcile (admin-only)
 *
 *  This module supports ALL THREE. The setInterval loop starts in index.ts.
 *  The admin endpoint is wired in routes/admin.ts (already auth-protected).
 *
 *  SAFETY:
 *    - Only touches orders where status='pending' AND created_at > 1 min ago
 *    - Limits to 50 orders per run (so a long backlog doesn't lock the loop)
 *    - Logs every run to payment_reconciliation_log
 *    - Errors per-order don't fail the whole batch
 * ═══════════════════════════════════════════════════════════════
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { listProviders } from './payment-gateways';
import { handlePaymentWebhook } from './payment';
import { PaymentGateway } from './payment-gateways/types';

const MIN_ORDER_AGE_MS = 60 * 1000;          // 1 minute — don't race with webhooks
const MAX_ORDERS_PER_RUN = 50;                // batch limit
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ORDER_STUCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — auto-expire stuck orders

export interface ReconciliationResult {
  runId: string;
  runAt: Date;
  durationMs: number;
  checked: number;
  confirmed: number;
  failed: number;
  expired: number;
  errors: Array<{ merchantOrderId: string; gateway: PaymentGateway; error: string }>;
}

export async function reconcilePendingPayments(): Promise<ReconciliationResult> {
  const runId = uuidv4();
  const runAt = new Date();
  const start = Date.now();
  const errors: ReconciliationResult['errors'] = [];
  let confirmed = 0;
  let failed = 0;
  let expired = 0;

  // 1. Find pending orders older than 1 min
  const stuckBefore = new Date(Date.now() - ORDER_STUCK_TIMEOUT_MS);
  const eligibleResult = await query<{
    id: string; merchant_order_id: string; gateway: PaymentGateway;
    amount_crypto: string; amount_coins: string;
    created_at: Date; user_id: string;
  }>(
    `SELECT id, merchant_order_id, gateway, amount_crypto::text AS amount_crypto,
            amount_coins::text AS amount_coins, created_at, user_id
     FROM payment_orders
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '1 minute'
     ORDER BY created_at ASC
     LIMIT $1`,
    [MAX_ORDERS_PER_RUN],
  );

  const orders = eligibleResult.rows;
  const checked = orders.length;

  // 2. Process each eligible order
  for (const order of orders) {
    try {
      const provider = listProviders().find((p) => p.gateway === order.gateway);
      if (!provider) {
        errors.push({ merchantOrderId: order.merchant_order_id, gateway: order.gateway, error: 'provider not configured' });
        continue;
      }

      // 2a. Auto-expire orders stuck for > 30 min (likely abandoned by user)
      if (order.created_at < stuckBefore) {
        await query(
          `UPDATE payment_orders SET status = 'expired', status_message = $1, updated_at = NOW() WHERE id = $2`,
          ['Auto-expired by reconciliation job (stuck > 30 min)', order.id],
        );
        expired++;
        continue;
      }

      // 2b. Poll the gateway for current status
      const status = await provider.getStatus(order.merchant_order_id);

      // 2c. If still pending, skip — try next run
      if (status.status === 'pending') {
        continue;
      }

      // 2d. Status changed — run the same handler as the webhook
      await handlePaymentWebhook(
        order.gateway,
        {
          gatewayOrderId: status.gatewayOrderId,
          merchantOrderId: order.merchant_order_id,
          status: status.status,
          amountUsdt: status.amountUsdt,
          paidAt: status.paidAt,
          rawPayload: { source: 'reconciliation', originalResponse: status.rawResponse },
        },
        new Date(),
        'reconciliation-job',
      );

      if (status.status === 'paid') confirmed++;
      else failed++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({
        merchantOrderId: order.merchant_order_id,
        gateway: order.gateway,
        error: msg.slice(0, 200),
      });
    }
  }

  const durationMs = Date.now() - start;

  // 3. Log the run
  await query(
    `INSERT INTO payment_reconciliation_log
      (id, run_at, gateway, checked_count, confirmed_count, failed_count, expired_count, errors, duration_ms)
     VALUES ($1, $2, 'all', $3, $4, $5, $6, $7, $8)`,
    [
      runId,
      runAt,
      checked,
      confirmed,
      failed,
      expired,
      JSON.stringify(errors),
      durationMs,
    ],
  );

  return { runId, runAt, durationMs, checked, confirmed, failed, expired, errors };
}

// ── Background scheduler ──────────────────────────────────────
let intervalHandle: NodeJS.Timeout | null = null;

/** Start the reconciliation loop. Safe to call multiple times. */
export function startReconciliationLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void reconcilePendingPayments().catch((e) => {
      console.error('[reconciliation] scheduled run failed:', e);
    });
  }, RECONCILE_INTERVAL_MS);
  console.log(`[reconciliation] started — runs every ${RECONCILE_INTERVAL_MS / 1000}s`);
}

/** Stop the reconciliation loop. */
export function stopReconciliationLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[reconciliation] stopped');
  }
}