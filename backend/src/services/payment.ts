/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYMENT SERVICE — orchestrates createOrder + webhook handling
 * ═══════════════════════════════════════════════════════════════
 *
 *  This is the only payment code that touches the DB. Provider classes
 *  (binance-pay.ts, redot-pay.ts) are stateless — they only talk to
 *  the gateway. This service ties gateways to our user + wallet tables.
 *
 *  LIFECYCLE OF A PAYMENT:
 *    1. Client → POST /api/wallet/payment/create {gateway, amountUsdt}
 *       → createPaymentOrder() → provider.createOrder()
 *       → returns checkout URL
 *       → stores row in payment_orders (status=pending)
 *
 *    2. User pays on gateway's hosted page
 *
 *    3. Gateway → POST /api/wallet/payment/{gateway}/webhook
 *       → webhook handler → provider.verifyWebhook()
 *       → if valid: provider.parseWebhook() → handlePaymentWebhook()
 *       → if PAID: credit user's wallet (atomic), mark order paid
 *       → if FAILED/EXPIRED: mark order, no credit
 *
 *    4. (Backup) Reconciliation job (every 5min)
 *       → for each pending order with created_at > 1min ago
 *       → call provider.getStatus()
 *       → if status changed: same as step 3
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import { getProvider, listProviders } from './payment-gateways';
import { PaymentGateway, PaymentStatus } from './payment-gateways/types';

const PROVIDER_NAMES: Record<PaymentGateway, string> = {
  binance_pay: 'Binance Pay',
  redot_pay: 'Redot Pay',
  binance_pay_qr: 'Binance Pay QR',
};

// ── Create payment order ──────────────────────────────────────

export interface CreatePaymentInput {
  userId: string;
  gateway: PaymentGateway;
  amountUsdt: number;
  ip?: string;
  userAgent?: string;
  returnUrl?: string;
}

export interface CreatePaymentResult {
  orderId: string;              // our merchantOrderId
  gatewayOrderId: string;       // gateway's order ID
  checkoutUrl: string;
  qrCodeUrl?: string;
  expiresAt: Date;
  amountCoins: number;
  gateway: PaymentGateway;
}

export async function createPaymentOrder(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  const provider = getProvider(input.gateway);
  if (!provider) {
    throw new Error(`Unknown payment gateway: ${input.gateway}`);
  }

  // 1. Fetch gateway config (caps, enabled)
  const cfg = await query(
    `SELECT is_enabled, daily_deposit_cap_usdt, min_deposit_usdt
     FROM payment_provider_config WHERE gateway = $1`,
    [input.gateway],
  );
  if (!cfg.rows.length || !cfg.rows[0].is_enabled) {
    throw new Error(`${PROVIDER_NAMES[input.gateway]} is currently disabled`);
  }
  const { daily_deposit_cap_usdt, min_deposit_usdt } = cfg.rows[0];

  if (input.amountUsdt < min_deposit_usdt) {
    throw new Error(`Minimum deposit is ${min_deposit_usdt} USDT`);
  }

  // 2. Check daily cap (sum of pending + paid orders in last 24h)
  const dailyTotal = await query(
    `SELECT COALESCE(SUM(amount_crypto), 0)::float8 AS total
     FROM payment_orders
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
       AND status IN ('pending', 'paid')`,
    [input.userId],
  );
  const already = dailyTotal.rows[0].total || 0;
  if (already + input.amountUsdt > daily_deposit_cap_usdt) {
    throw new Error(`Daily deposit cap exceeded. Used ${already.toFixed(2)}/${daily_deposit_cap_usdt} USDT today.`);
  }

  // 3. Generate merchant order ID + create gateway order
  const merchantOrderId = `cf_${uuidv4().replace(/-/g, '')}`;
  const gwResp = await provider.createOrder({
    merchantOrderId,
    userId: input.userId,
    amountUsdt: input.amountUsdt,
    description: `CryptoFlip deposit ${merchantOrderId}`,
    returnUrl: input.returnUrl,
  });

  // 4. Store in DB
  const fxRate = 1.0;  // USDT → Coin is 1:1
  const amountCoins = input.amountUsdt * fxRate;

  await query(
    `INSERT INTO payment_orders
      (user_id, gateway, gateway_order_id, merchant_order_id,
       crypto_currency, amount_crypto, fx_rate_snapshot, amount_coins,
       checkout_url, qr_code_url, expires_at, status,
       ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, 'USDT', $5, $6, $7, $8, $9, $10, 'pending',
             $11::inet, $12, '{}'::jsonb)`,
    [
      input.userId, input.gateway, gwResp.gatewayOrderId, merchantOrderId,
      input.amountUsdt, fxRate, amountCoins,
      gwResp.checkoutUrl, gwResp.qrCodeUrl || null, gwResp.expiresAt,
      input.ip || null, (input.userAgent || '').slice(0, 500),
    ],
  );

  return {
    orderId: merchantOrderId,
    gatewayOrderId: gwResp.gatewayOrderId,
    checkoutUrl: gwResp.checkoutUrl,
    qrCodeUrl: gwResp.qrCodeUrl,
    expiresAt: gwResp.expiresAt,
    amountCoins,
    gateway: input.gateway,
  };
}

// ── Webhook handler (called by routes after signature verified) ──

export interface WebhookResult {
  processed: boolean;
  status: PaymentStatus;
  message: string;
}

export async function handlePaymentWebhook(
  gateway: PaymentGateway,
  payload: {
    gatewayOrderId: string;
    merchantOrderId: string;
    status: PaymentStatus;
    amountUsdt?: number;
    paidAt?: Date;
    rawPayload: unknown;
  },
  webhookReceivedAt: Date,
  ip?: string,
): Promise<WebhookResult> {
  const provider = getProvider(gateway);
  if (!provider) {
    return { processed: false, status: 'failed', message: `Unknown gateway: ${gateway}` };
  }

  // Find the order
  const orderResult = await query(
    `SELECT id, user_id, amount_coins::float8 AS amount_coins, status, gateway_trade_id
     FROM payment_orders WHERE merchant_order_id = $1 FOR UPDATE`,
    [payload.merchantOrderId],
  );
  if (!orderResult.rows.length) {
    return { processed: false, status: 'failed', message: `Order not found: ${payload.merchantOrderId}` };
  }
  const order = orderResult.rows[0];

  // Idempotency: if already paid, skip (don't double-credit)
  if (order.status === 'paid') {
    return { processed: true, status: 'paid', message: 'Order already processed (idempotent)' };
  }

  // If status is terminal (failed/expired), just update the order
  if (payload.status === 'failed' || payload.status === 'expired' || payload.status === 'refunded') {
    await query(
      `UPDATE payment_orders
       SET status = $1, status_message = $2, webhook_payload = $3, webhook_received_at = $4,
           refunded_at = CASE WHEN $1 = 'refunded' THEN NOW() ELSE refunded_at END,
           updated_at = NOW()
       WHERE id = $5`,
      [payload.status, 'Gateway-reported terminal status', JSON.stringify(payload.rawPayload), webhookReceivedAt, order.id],
    );
    return { processed: true, status: payload.status, message: `Order marked ${payload.status}` };
  }

  // Status is PAID — credit user's wallet atomically
  if (payload.status === 'paid') {
    await withTransaction(async (txQuery) => {
      // 1. Credit withdrawable_balance_coins (trigger sync_user_balance
      //    derives users.balance = bonus_balance_coins + withdrawable_balance_coins).
      //    wallet_balance_coins is the legacy column; keeping it in sync for compat.
      await txQuery(
        `UPDATE users
         SET withdrawable_balance_coins = withdrawable_balance_coins + $1,
             wallet_balance_coins = wallet_balance_coins + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [order.amount_coins, order.user_id],
      );
      // 2. Insert wallet_transactions row
      await txQuery(
        `INSERT INTO wallet_transactions
          (user_id, type, amount_coins, currency, source, note, metadata)
         VALUES ($1, 'topup', $2, 'COIN', $3, $4, '{}'::jsonb)`,
        [order.user_id, order.amount_coins, gateway,
         `Auto-credited from ${PROVIDER_NAMES[gateway]} payment`],
      );
      // 3. Mark order paid
      await txQuery(
        `UPDATE payment_orders
         SET status = 'paid', confirmed_at = NOW(), gateway_trade_id = $1,
             webhook_payload = $2, webhook_received_at = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [payload.gatewayOrderId, JSON.stringify(payload.rawPayload), webhookReceivedAt, order.id],
      );
      // 4. Audit log
      await txQuery(
        `INSERT INTO audit_log (user_id, category, action, severity, details)
         VALUES ($1, 'system', 'payment.confirmed', 'info', $2)`,
        [order.user_id, JSON.stringify({
          orderId: payload.merchantOrderId, gateway, amountCoins: order.amount_coins,
        })],
      );
    });
    return { processed: true, status: 'paid', message: `Credited ${order.amount_coins} Coin to wallet` };
  }

  // Status is still 'pending' — just update the webhook payload for audit
  await query(
    `UPDATE payment_orders
     SET webhook_payload = $1, webhook_received_at = $2, updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(payload.rawPayload), webhookReceivedAt, order.id],
  );
  return { processed: true, status: 'pending', message: 'Webhook received; still pending' };
}

// ── List user's payment orders ─────────────────────────────────

export async function listPaymentOrders(userId: string, limit = 20) {
  const r = await query(
    `SELECT id, gateway, gateway_order_id, merchant_order_id,
            amount_crypto::float8 AS amount_crypto, amount_coins::float8 AS amount_coins,
            status, status_message, checkout_url, expires_at,
            confirmed_at, created_at
     FROM payment_orders
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}