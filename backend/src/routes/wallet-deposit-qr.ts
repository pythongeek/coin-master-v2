/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET DEPOSIT QR ROUTES — /api/wallet/deposit/qr/*
 * ═══════════════════════════════════════════════════════════════
 *
 *  User-facing deposit flow using Binance Pay "Receive in any crypto" QR.
 *
 *  POST /api/wallet/deposit/qr/initiate   — generate QR for a deposit amount
 *  GET  /api/wallet/deposit/qr/:orderId    — poll current status
 *  POST /api/wallet/deposit/qr/receipt     — upload payment receipt screenshot
 *
 *  All routes require auth. Receipt upload accepts JSON with base64 image
 *  (avoids the need for multipart parsing in the main app).
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../config/database';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { apiLimiter } from '../middleware/rate-limiter';
import { validateBody } from '../middleware/validation';
import { initiateQrDepositSchema, qrReceiptUploadSchema } from '../schemas';
import {
  initiateQrDeposit,
  getQrOrderStatus,
  attachReceipt,
} from '../services/binance-pay-qr.service';

const router = Router();

// ── POST /initiate ──────────────────────────────────────────────
router.post(
  '/initiate',
  apiLimiter,
  authMiddleware,
  validateBody(initiateQrDepositSchema),
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;

      // Idempotency-Key support (P2-C): if the client sends the same key
      // within 24h, return the cached response instead of creating a new order.
      const idemKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
      if (idemKey) {
        const { getIdempotentResponse, setIdempotentResponse } = await import('../utils/idempotency');
        const cached = await getIdempotentResponse<unknown>('qr_initiate', user.userId, idemKey);
        if (cached) {
          res.setHeader('Idempotency-Replay', 'true');
          return res.status(cached.status).json(cached.body);
        }
      }

      const { amountUsdt, chainKey } = req.body;
      const result = await initiateQrDeposit({
        userId: user.userId,
        amountUsdt: Number(amountUsdt),
        chainKey,
        ip: req.ip,
        userAgent: ((req.headers['user-agent'] as string) || ''),
      });
      const body = { success: true, ...result };

      // Cache successful response for 24h so the same key returns it.
      if (idemKey) {
        const { setIdempotentResponse } = await import('../utils/idempotency');
        await setIdempotentResponse('qr_initiate', user.userId, idemKey, 200, body);
      }

      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ success: false, error: message });
    }
  }
);

// GET /list - user's QR deposit history
router.get(
  '/list',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
      const r = await query(
        `SELECT merchant_order_id, status, amount_crypto::float8 AS amount_usdt,
                amount_coins::float8 AS amount_coins, qr_memo, chain, expires_at,
                detected_at, confirmed_at, created_at,
                llm_verdict, llm_confidence::float8 AS llm_confidence,
                receipt_url IS NOT NULL AS receipt_uploaded
         FROM payment_orders
         WHERE user_id = $1 AND gateway = 'binance_pay_qr'
         ORDER BY created_at DESC
         LIMIT $2`,
        [user.userId, limit]
      );
      res.json({ success: true, orders: r.rows });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// Accepts base64 image. Stores under backend/uploads/deposit-receipts/<orderId>/<sha256>.<ext>
const UPLOAD_DIR = path.resolve(
  process.env.RECEIPT_UPLOAD_DIR || path.join(__dirname, '../../uploads/deposit-receipts')
);

// GET /active - returns the user's current open QR deposit order (if any)
//   Returns { success: true, order: <full InitiateQrDepositResult> } or { success: true, order: null }
//   Lets the frontend rehydrate state on page reload.
router.get(
  '/active',
  apiLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      // Note: we don't include equivalent_usd / equivalent_bdt columns here
      // because they don't exist on payment_orders. The frontend fetches
      // current rates via /api/public/fx-rates and computes them client-side.
      const r = await query(
        `SELECT merchant_order_id, status, amount_crypto::float8 AS amount_usdt,
                amount_coins::float8 AS amount_coins, qr_memo, qr_payload, qr_png_data_url,
                receive_address, chain, expires_at, created_at
         FROM payment_orders
         WHERE user_id = $1 AND gateway = 'binance_pay_qr'
           AND status IN ('awaiting_payment', 'detected', 'verifying')
         ORDER BY created_at DESC
         LIMIT 1`,
        [user.userId]
      );
      if (r.rows.length === 0) {
        return res.json({ success: true, order: null });
      }
      const row = r.rows[0];
      // Reshape to match InitiateQrDepositResult
      const order = {
        orderId: row.merchant_order_id,
        gatewayOrderId: row.merchant_order_id,
        qrPayload: row.qr_payload,
        qrPngDataUrl: row.qr_png_data_url,
        depositAddress: row.receive_address,
        chain: row.chain,
        chainKey: row.chain,
        token: 'USDT',
        memo: row.qr_memo,
        memoSupported: true,    // legacy field
        minConfirmations: 12,
        estimatedSeconds: 15,
        avgFeeUsdt: 0.5,
        amountUsdt: parseFloat(row.amount_usdt),
        amountCoins: parseFloat(row.amount_coins),
        equivalent: {
          // Frontend should fetch live rates via /api/public/fx-rates
          // and recompute usd/bdt. We return zeros here as a placeholder
          // so the response shape matches InitiateQrDepositResult.
          usdt: parseFloat(row.amount_usdt),
          usd: 0,
          bdt: 0,
          rateTimestamp: new Date().toISOString(),
          rateAgeSec: 0,
        },
        expiresAt: row.expires_at,
        expiresInSec: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
      };
      res.json({ success: true, order });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// ── GET /:orderId ───────────────────────────────────────────────
router.get(
  '/:orderId',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const orderId = String(req.params.orderId || '');
      const status = await getQrOrderStatus(orderId, user.userId);
      if (!status) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      res.json({ success: true, order: status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  }
);


// DELETE /:orderId - user cancels their in-progress QR order
router.delete(
  '/:orderId',
  apiLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const { cancelQrOrder } = await import('../services/binance-pay-qr.service');
      const result = await cancelQrOrder(String(req.params.orderId), user.userId);
      if (!result.cancelled) {
        return res.status(400).json({ success: false, error: result.reason || 'Cancel failed' });
      }
      res.json({ success: true, orderId: String(req.params.orderId), status: 'cancelled' });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

router.post(
  '/receipt',
  apiLimiter,
  authMiddleware,
  validateBody(qrReceiptUploadSchema),
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const { orderId, imageBase64, originalName, mimeType } = req.body;

      // Strip data URL prefix if present (e.g., "data:image/png;base64,...")
      const base64Match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
      const cleanBase64 = base64Match ? base64Match[2] : imageBase64;
      const detectedMime = base64Match ? base64Match[1] : (mimeType || 'image/png');

      // Validate mime
      if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic'].includes(detectedMime)) {
        return res.status(400).json({ success: false, error: `Unsupported image type: ${detectedMime}` });
      }

      const buffer = Buffer.from(cleanBase64, 'base64');
      const sizeBytes = buffer.length;

      // 5 MB hard cap
      if (sizeBytes > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Receipt exceeds 5MB limit' });
      }
      if (sizeBytes < 1024) {
        return res.status(400).json({ success: false, error: 'Receipt too small (min 1KB)' });
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const ext = detectedMime.split('/')[1] === 'jpeg' ? 'jpg' : detectedMime.split('/')[1];
      const orderDir = path.join(UPLOAD_DIR, orderId);
      await fs.mkdir(orderDir, { recursive: true });
      const filePath = path.join(orderDir, `${sha256}.${ext}`);
      await fs.writeFile(filePath, buffer, { mode: 0o640 }); // owner RW, group R, world none

      // Optional: best-effort OCR via the existing kyc-ocr service (non-blocking)
      let ocrResult: Record<string, unknown> | undefined;
      try {
        const { runOcr } = await import('../services/kyc-ocr');
        const ocr = await runOcr(cleanBase64);
        if (ocr?.text) {
          ocrResult = { text: String(ocr.text).slice(0, 2000), confidence: ocr.confidence ?? null };
        }
      } catch {
        // OCR is best-effort; absence is OK
      }

      await attachReceipt(orderId, user.userId, {
        filePath,
        originalName,
        mimeType: detectedMime,
        sizeBytes,
        sha256,
        ocrResult,
      });

      res.json({
        success: true,
        receipt: {
          sha256,
          sizeBytes,
          mimeType: detectedMime,
          uploadedAt: new Date().toISOString(),
          ocrText: ocrResult && typeof ocrResult.text === 'string' ? ocrResult.text.slice(0, 500) : null,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('not found') ? 404
        : message.includes('not accepted') || message.includes('already credited') ? 400
        : 500;
      res.status(status).json({ success: false, error: message });
    }
  }
);

export default router;

// GET /receipts/:orderId - list the user's own receipts for an order
router.get(
  '/receipts/:orderId',
  apiLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const merchantOrderId = String(req.params.orderId || '');
      // merchant_order_id is TEXT ('cf_xxx'), but deposit_receipt_files.order_id is UUID.
      // Look up the UUID first.
      const orderRes = await query(
        `SELECT id, user_id FROM payment_orders WHERE merchant_order_id = $1`,
        [merchantOrderId]
      );
      if (!orderRes.rows.length || orderRes.rows[0].user_id !== user.userId) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      const orderUuid = orderRes.rows[0].id;
      const r = await query(
        `SELECT id, sha256, size_bytes, mime_type, uploaded_at
         FROM deposit_receipt_files
         WHERE order_id = $1
         ORDER BY uploaded_at DESC`,
        [orderUuid]
      );
      res.json({
        success: true,
        orderId: merchantOrderId,
        receipts: r.rows.map(row => ({
          id: row.id,
          sha256: row.sha256,
          fileSize: row.size_bytes,
          mimeType: row.mime_type,
          uploadedAt: row.uploaded_at,
          downloadUrl: `/api/wallet/deposit/qr/receipts/${merchantOrderId}/${row.id}`,
        })),
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// GET /receipts/:orderId/:receiptId - stream the actual receipt file bytes
router.get(
  '/receipts/:orderId/:receiptId',
  apiLimiter,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user: AuthPayload }).user;
      const merchantOrderId = String(req.params.orderId || '');
      const receiptId = String(req.params.receiptId || '');
      // Look up the order UUID first so we can match receipt_files.order_id (UUID type).
      const orderRes = await query(
        `SELECT id, user_id FROM payment_orders WHERE merchant_order_id = $1`,
        [merchantOrderId]
      );
      if (!orderRes.rows.length || orderRes.rows[0].user_id !== user.userId) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      const orderUuid = orderRes.rows[0].id;
      const r = await query(
        `SELECT file_path, mime_type, size_bytes
         FROM deposit_receipt_files
         WHERE id = $1 AND order_id = $2`,
        [receiptId, orderUuid]
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: 'Receipt not found' });
      }
      const filePath = r.rows[0].file_path;
      if (!existsSync(filePath)) {
        return res.status(410).json({ success: false, error: 'Receipt file no longer on disk' });
      }
      res.setHeader('Content-Type', r.rows[0].mime_type);
      res.setHeader('Content-Length', String(r.rows[0].size_bytes));
      const ext = r.rows[0].mime_type.split('/')[1] || 'bin';
      res.setHeader('Content-Disposition', `inline; filename="receipt-${receiptId}.${ext}"`);
      createReadStream(filePath).pipe(res);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);
