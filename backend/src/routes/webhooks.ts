/**
 * ═══════════════════════════════════════════════════════════════
 *  WEBHOOK ROUTES — /api/webhooks/*
 * ═══════════════════════════════════════════════════════════════
 *
 *  These are PUBLIC endpoints (no authMiddleware) — they're secured
 *  by HMAC signature verification instead. Mounted at /api/webhooks/
 *  (NOT under /api/wallet) so they don't get caught by wallet's
 *  global authMiddleware.
 *
 *  Endpoints:
 *    POST /api/webhooks/binance  — Binance Pay callback
 *    POST /api/webhooks/redot    — Redot Pay callback
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { getProvider } from '../services/payment-gateways';
import { PaymentGateway } from '../services/payment-gateways/types';
import { handlePaymentWebhook } from '../services/payment';

const router = Router();

// Read raw body for HMAC verification
function readRawBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleWebhook(req: Request, res: Response, gateway: PaymentGateway) {
  const provider = getProvider(gateway);
  if (!provider) {
    return res.status(404).json({ error: 'gateway not configured' });
  }
  // Use rawBody captured by the raw-body middleware (in index.ts)
  // Fall back to readRawBody if for some reason it's missing
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? await readRawBody(req);
  const reqShape = {
    rawBody,
    headers: req.headers as Record<string, string | string[] | undefined>,
    ip: req.ip,
  };

  if (!provider.verifyWebhook(reqShape)) {
    // Audit + fraud log on bad signature
    await query(
      `INSERT INTO fraud_signals (signal_type, severity, ip_address, status, metadata)
       VALUES ('webhook_bad_signature', 'high', $1, 'open', $2)`,
      [req.ip || 'unknown', JSON.stringify({ gateway, rawBody: rawBody.slice(0, 500) })],
    );
    await query(
      `INSERT INTO audit_log (category, action, severity, ip_address, details)
       VALUES ('security', 'webhook.bad_signature', 'warn', $1, $2)`,
      [req.ip || 'unknown', JSON.stringify({ gateway, bodyLen: rawBody.length })],
    );
    return res.status(401).json({ error: 'invalid signature' });
  }
  const payload = provider.parseWebhook(reqShape);
  const result = await handlePaymentWebhook(gateway, payload, new Date(), req.ip);
  return res.json({ success: result.processed, ...result });
}

router.post('/binance', async (req, res) => { await handleWebhook(req, res, 'binance_pay'); });
router.post('/redot',   async (req, res) => { await handleWebhook(req, res, 'redot_pay'); });

export default router;