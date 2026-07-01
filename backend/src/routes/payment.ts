/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYMENT ROUTES — /api/wallet/payment/*
 * ═══════════════════════════════════════════════════════════════
 *
 *  Routes:
 *    POST /api/wallet/payment/create    — create new deposit order (auth)
 *    GET  /api/wallet/payment/orders    — list user's payment history (auth)
 *    POST /api/wallet/payment/binance/webhook  — Binance Pay callback (public)
 *    POST /api/wallet/payment/redot/webhook    — Redot Pay callback (public)
 *    GET  /api/wallet/payment/health    — health check on all gateways (auth)
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { apiLimiter } from '../middleware/rate-limit';
import { listProviders } from '../services/payment-gateways';
import { PaymentGateway } from '../services/payment-gateways/types';
import { createPaymentOrder, listPaymentOrders } from '../services/payment';

const router = Router();

// ── POST /create (auth required) ────────────────────────────────
router.post('/create', apiLimiter, authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const { gateway, amountUsdt } = req.body;
    if (!gateway || !amountUsdt) {
      return res.status(400).json({ success: false, error: 'gateway ও amountUsdt দিতে হবে।' });
    }
    if (!['binance_pay', 'redot_pay'].includes(gateway)) {
      return res.status(400).json({ success: false, error: 'gateway binance_pay বা redot_pay হতে হবে।' });
    }
    const numAmount = parseFloat(amountUsdt);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: 'amountUsdt একটি ধনাত্মক সংখ্যা হতে হবে।' });
    }

    const result = await createPaymentOrder({
      userId: user.userId,
      gateway: gateway as PaymentGateway,
      amountUsdt: numAmount,
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string,
      returnUrl: req.body.returnUrl,
    });
    res.json({ success: true, payment: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// ── GET /orders (auth) ─────────────────────────────────────────
router.get('/orders', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthPayload }).user;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const orders = await listPaymentOrders(user.userId, limit);
    res.json({ success: true, orders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /health (auth — checks all configured providers) ────────
router.get('/health', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const providers = listProviders();
    const checks = await Promise.all(
      providers.map(async (p) => ({
        gateway: p.gateway,
        environment: p.environment,
        ...(await p.healthCheck()),
      })),
    );
    res.json({ success: true, providers: checks });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// WEBHOOK HANDLERS MOVED TO routes/webhooks.ts (canonical path: /api/webhooks/{binance,redot})
// The previous duplicate mount at /api/wallet/payment/{binance,redot}/webhook was broken:
//   - Wallet routes use authMiddleware which rejected the webhook
//   - express.json() consumed the request stream before the handler could read raw body
//   - HMAC verification therefore always failed
//   The canonical /api/webhooks/* path properly bypasses both and is already wired
//   to the body-parser skip in index.ts. Gateway dashboards should be configured
//   with: ${WEBHOOK_BASE_URL}/api/webhooks/binance  (or /redot)

export default router;