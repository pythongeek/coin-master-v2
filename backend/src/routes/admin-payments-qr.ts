/**
 * =============================================================
 *  ADMIN QR DEPOSIT ROUTES - review queue + LLM stats
 * =============================================================
 *
 *  Endpoints (all require auth + admin role):
 *    GET  /api/admin/payments/qr-orders           - list QR orders (filter by status/gateway)
 *    GET  /api/admin/payments/qr-orders/:orderId  - full order detail with evidence
 *    POST /api/admin/payments/qr-orders/:orderId/release
 *    POST /api/admin/payments/qr-orders/:orderId/reject
 *    POST /api/admin/payments/qr-orders/:orderId/hold
 *    GET  /api/admin/payments/review-queue         - all verifying orders
 *    GET  /api/admin/payments/llm-stats            - verdict distribution + false-AUTO counter
 *
 *  Every admin decision writes to payment_review_decisions for the
 *  weekly retraining feedback loop.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { authMiddleware, AuthPayload, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { query, withTransaction } from '../config/database';
import { handlePaymentWebhook } from '../services/payment';

const router = Router();

// Schema for admin hold/release/reject decisions
const decisionSchema = z.object({
  decisionNote: z.string().max(1000).optional(),
});

// Helpers
function getAdminId(req: Request): string {
  return ((req as Request & { user: AuthPayload }).user?.userId) || '';
}

// =============================================================
//  GET /api/admin/payments/qr-orders
//  List QR deposit orders, filterable by status/gateway/user
// =============================================================
router.get(
  '/qr-orders',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const gateway = typeof req.query.gateway === 'string' ? req.query.gateway : 'binance_pay_qr';
      const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
      const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
      const offset = parseInt((req.query.offset as string) || '0', 10);

      const params: unknown[] = [];
      const conditions: string[] = ['po.gateway = $1'];
      params.push(gateway);
      if (status) {
        params.push(status);
        conditions.push(`po.status = $${params.length}`);
      }
      if (userId) {
        params.push(userId);
        conditions.push(`po.user_id = $${params.length}`);
      }
      params.push(limit);
      params.push(offset);
      const where = conditions.join(' AND ');

      const r = await query(
        `SELECT po.id, po.merchant_order_id, po.user_id, u.username,
                po.amount_crypto::float8 AS amount_usdt,
                po.amount_coins::float8 AS amount_coins,
                po.status, po.qr_memo, po.chain, po.receive_address,
                po.detected_tx_hash, po.detected_at, po.confirmed_at,
                po.created_at, po.expires_at,
                po.llm_verdict, po.llm_confidence::float8 AS llm_confidence,
                po.llm_reason, po.llm_model_version,
                po.rule_verdict, po.rule_disagreement,
                po.admin_hold_reason, po.admin_decided_at,
                po.receipt_url IS NOT NULL AS receipt_uploaded
         FROM payment_orders po
         LEFT JOIN users u ON po.user_id = u.id
         WHERE ${where}
         ORDER BY po.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const countR = await query(
        `SELECT COUNT(*)::int AS total FROM payment_orders po WHERE ${where}`,
        params.slice(0, params.length - 2)
      );

      res.json({
        success: true,
        orders: r.rows,
        total: countR.rows[0]?.total || 0,
        limit,
        offset,
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  GET /api/admin/payments/qr-orders/:orderId
//  Full detail with raw ledger entry, receipt path, LLM evidence
// =============================================================
router.get(
  '/qr-orders/:orderId',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const orderId = String(req.params.orderId || '');
      const r = await query(
        `SELECT po.*, u.username, u.email, u.kyc_tier,
                po.amount_crypto::float8 AS amount_usdt,
                po.amount_coins::float8 AS amount_coins,
                po.llm_confidence::float8 AS llm_confidence_raw,
                po.receipt_url IS NOT NULL AS receipt_uploaded
         FROM payment_orders po
         LEFT JOIN users u ON po.user_id = u.id
         WHERE po.merchant_order_id = $1`,
        [orderId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      const order = r.rows[0];

      // Past admin decisions for this order (for audit trail)
      const decisions = await query(
        `SELECT prd.decision, prd.decision_note, prd.original_verdict,
                prd.original_confidence::float8 AS original_confidence,
                prd.original_reason, prd.created_at,
                u.username AS admin_username
         FROM payment_review_decisions prd
         LEFT JOIN users u ON prd.admin_id = u.id
         WHERE prd.order_id = $1
         ORDER BY prd.created_at DESC`,
        [order.id]
      );

      // Receipt files (for inline preview + OCR text)
      const receipts = await query(
        `SELECT id, original_name, mime_type, size_bytes, sha256,
                uploaded_at, ocr_result
         FROM deposit_receipt_files
         WHERE order_id = $1
         ORDER BY uploaded_at DESC`,
        [order.id]
      );

      // LLM prompt version that scored this order (if recorded)
      let llmPrompt: { version: number; few_shot_count: number; notes: string | null } | null = null;
      if (order.llm_model_version && /^v\d+$/.test(String(order.llm_model_version))) {
        const vNum = parseInt(String(order.llm_model_version).slice(1), 10);
        const pR = await query(
          `SELECT version, few_shot_count, notes FROM llm_prompt_versions
           WHERE prompt_type = 'deposit_scorer' AND version = $1`,
          [vNum]
        );
        if (pR.rows.length > 0) llmPrompt = pR.rows[0] as any;
      }

      res.json({
        success: true,
        order,
        decisions: decisions.rows,
        receipts: receipts.rows,
        llmPrompt,
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  POST /api/admin/payments/qr-orders/:orderId/release
//  Admin confirms a held order - credits the user's wallet
// =============================================================
router.post(
  '/qr-orders/:orderId/release',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  async (req: Request, res: Response) => {
    try {
      const adminId = getAdminId(req);
      const orderId = String(req.params.orderId || '');
      const note = typeof req.body?.decisionNote === 'string' ? req.body.decisionNote : null;

      const r = await query(
        `SELECT id, user_id, amount_coins::float8 AS amount_coins,
                llm_verdict, llm_confidence::float8 AS llm_confidence, llm_reason
         FROM payment_orders
         WHERE merchant_order_id = $1 AND status = 'verifying'
         FOR UPDATE`,
        [orderId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Order not found or not in verifying state' });
      }
      const order = r.rows[0];

      const credited = await withTransaction(async (txQuery) => {
        // Credit via the same code path the verifier uses
        await txQuery(
          `UPDATE users
           SET wallet_balance_coins = wallet_balance_coins + $1,
               balance = balance + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [order.amount_coins, order.user_id]
        );
        await txQuery(
          `INSERT INTO wallet_transactions
            (user_id, type, amount_coins, currency, source, note, metadata)
           VALUES ($1, 'topup', $2, 'COIN', 'binance_pay_qr',
                   $3, $4::jsonb)`,
          [order.user_id, order.amount_coins, 'Admin-released QR deposit',
           JSON.stringify({ orderId, adminId, note })]
        );
        await txQuery(
          `UPDATE payment_orders
           SET status = 'paid',
               confirmed_at = NOW(),
               admin_decided_by = $1,
               admin_decided_at = NOW(),
               updated_at = NOW()
           WHERE id = $2`,
          [adminId, order.id]
        );
        await txQuery(
          `INSERT INTO audit_log (user_id, category, action, severity, details)
           VALUES ($1, 'admin', 'payment.released', 'warning', $2)`,
          [order.user_id, JSON.stringify({ orderId, adminId, amountCoins: order.amount_coins, note })]
        );
        return true;
      });

      // Feedback loop: record the decision for weekly retraining
      await query(
        `INSERT INTO payment_review_decisions
          (order_id, admin_id, decision, decision_note,
           original_verdict, original_confidence, original_reason)
         VALUES ($1, $2, 'release', $3, $4, $5, $6)`,
        [order.id, adminId, note,
         order.llm_verdict, order.llm_confidence, order.llm_reason]
      );

      res.json({ success: credited, message: 'Order released, wallet credited' });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  POST /api/admin/payments/qr-orders/:orderId/reject
//  Admin rejects a held order - marks failed, no credit
// =============================================================
router.post(
  '/qr-orders/:orderId/reject',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  async (req: Request, res: Response) => {
    try {
      const adminId = getAdminId(req);
      const orderId = String(req.params.orderId || '');
      const note = typeof req.body?.decisionNote === 'string' ? req.body.decisionNote : null;

      const r = await query(
        `SELECT id, user_id, amount_coins::float8 AS amount_coins,
                llm_verdict, llm_confidence::float8 AS llm_confidence, llm_reason
         FROM payment_orders
         WHERE merchant_order_id = $1 AND status IN ('verifying', 'detected', 'awaiting_payment')
         FOR UPDATE`,
        [orderId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Order not found or already terminal' });
      }
      const order = r.rows[0];

      await withTransaction(async (txQuery) => {
        await txQuery(
          `UPDATE payment_orders
           SET status = 'failed',
               status_message = $1,
               admin_decided_by = $2,
               admin_decided_at = NOW(),
               updated_at = NOW()
           WHERE id = $3`,
          [note || 'Admin rejected', adminId, order.id]
        );
        await txQuery(
          `INSERT INTO audit_log (user_id, category, action, severity, details)
           VALUES ($1, 'admin', 'payment.rejected', 'warning', $2)`,
          [order.user_id, JSON.stringify({ orderId, adminId, note })]
        );
      });

      await query(
        `INSERT INTO payment_review_decisions
          (order_id, admin_id, decision, decision_note,
           original_verdict, original_confidence, original_reason)
         VALUES ($1, $2, 'reject', $3, $4, $5, $6)`,
        [order.id, adminId, note,
         order.llm_verdict, order.llm_confidence, order.llm_reason]
      );

      res.json({ success: true, message: 'Order rejected' });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  POST /api/admin/payments/qr-orders/:orderId/hold
//  Force-hold a non-terminal order (e.g. detector flagged it but
//  you want a human to look before AUTO_CREDIT kicks in)
// =============================================================
router.post(
  '/qr-orders/:orderId/hold',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  async (req: Request, res: Response) => {
    try {
      const adminId = getAdminId(req);
      const orderId = String(req.params.orderId || '');
      const note = typeof req.body?.decisionNote === 'string' ? req.body.decisionNote : 'Admin force-hold';

      const r = await query(
        `UPDATE payment_orders
         SET status = 'verifying',
             admin_hold_reason = $1,
             admin_decided_by = $2,
             admin_decided_at = NOW(),
             updated_at = NOW()
         WHERE merchant_order_id = $3 AND status IN ('awaiting_payment', 'detected')
         RETURNING id`,
        [note, adminId, orderId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Order not found or already terminal' });
      }
      res.json({ success: true, message: 'Order moved to verifying' });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  GET /api/admin/payments/review-queue
//  All orders currently in 'verifying' state (held for review)
// =============================================================
router.get(
  '/review-queue',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (_req: Request, res: Response) => {
    try {
      const r = await query(
        `SELECT po.id, po.merchant_order_id, po.user_id, u.username,
                po.amount_crypto::float8 AS amount_usdt,
                po.amount_coins::float8 AS amount_coins,
                po.qr_memo, po.chain, po.receive_address,
                po.detected_tx_hash, po.detected_at,
                po.created_at, po.expires_at,
                po.llm_verdict, po.llm_confidence::float8 AS llm_confidence,
                po.llm_reason, po.llm_model_version,
                po.rule_verdict, po.rule_disagreement,
                po.admin_hold_reason,
                po.receipt_url IS NOT NULL AS receipt_uploaded,
                EXTRACT(EPOCH FROM (NOW() - po.detected_at))::int AS review_age_sec
         FROM payment_orders po
         LEFT JOIN users u ON po.user_id = u.id
         WHERE po.gateway = 'binance_pay_qr'
           AND po.status = 'verifying'
         ORDER BY po.detected_at ASC NULLS LAST
         LIMIT 100`
      );
      res.json({ success: true, queue: r.rows, total: r.rowCount || 0 });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  GET /api/admin/payments/llm-stats
//  Verdict distribution, confidence histogram, false-AUTO counter
// =============================================================
router.get(
  '/llm-stats',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (_req: Request, res: Response) => {
    try {
      // Verdict distribution over last 7 days
      const verdictDist = await query(
        `SELECT llm_verdict, COUNT(*)::int AS count
         FROM payment_orders
         WHERE gateway = 'binance_pay_qr'
           AND llm_verdict IS NOT NULL
           AND llm_scored_at > NOW() - INTERVAL '7 days'
         GROUP BY llm_verdict`
      );

      // Confidence histogram (10 buckets)
      const confidenceHist = await query(
        `SELECT
           (FLOOR(llm_confidence * 10) / 10)::numeric(4,1) AS bucket,
           COUNT(*)::int AS count
         FROM payment_orders
         WHERE gateway = 'binance_pay_qr'
           AND llm_confidence IS NOT NULL
           AND llm_scored_at > NOW() - INTERVAL '7 days'
         GROUP BY bucket
         ORDER BY bucket`
      );

      // False-AUTO-CREDIT counter: orders that AUTO_CREDIT'd but admin later released a hold for same tx (duplicate detection across orders)
      const falseAuto = await query(
        `SELECT COUNT(*)::int AS count
         FROM payment_review_decisions prd
         JOIN payment_orders po ON prd.order_id = po.id
         WHERE prd.original_verdict = 'AUTO_CREDIT'
           AND prd.decision = 'reject'`
      );

      // LLM-rule disagreement rate
      const disagreement = await query(
        `SELECT
           SUM(CASE WHEN rule_disagreement THEN 1 ELSE 0 END)::int AS disagree_count,
           COUNT(*) FILTER (WHERE rule_disagreement IS NOT NULL)::int AS total_scored
         FROM payment_orders
         WHERE gateway = 'binance_pay_qr'
           AND llm_scored_at > NOW() - INTERVAL '7 days'`
      );

      // Status counts (overall)
      const statusCounts = await query(
        `SELECT status, COUNT(*)::int AS count
         FROM payment_orders
         WHERE gateway = 'binance_pay_qr'
         GROUP BY status`
      );

      res.json({
        success: true,
        stats: {
          verdictDistribution: verdictDist.rows,
          confidenceHistogram: confidenceHist.rows,
          falseAutoCount: falseAuto.rows[0]?.count || 0,
          disagreementRate: {
            disagree: disagreement.rows[0]?.disagree_count || 0,
            totalScored: disagreement.rows[0]?.total_scored || 0,
          },
          statusCounts: statusCounts.rows,
          windowDays: 7,
        },
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);



// =============================================================
//  GET /api/admin/payments/qr-orders/:orderId/receipt/:receiptId
//  Serves the actual receipt image bytes (for inline preview)
//  Admin-only. Streams the file with the correct content-type.
// =============================================================
router.get(
  '/qr-orders/:orderId/receipt/:receiptId',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const receiptId = String(req.params.receiptId || '');
      const r = await query(
        `SELECT file_path, mime_type, size_bytes, order_id
         FROM deposit_receipt_files WHERE id = $1`,
        [receiptId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Receipt not found' });
      }
      const row = r.rows[0];

      // Verify the receipt belongs to the requested order
      const oR = await query(
        `SELECT merchant_order_id FROM payment_orders WHERE id = $1`,
        [row.order_id]
      );
      if (oR.rows.length === 0 || oR.rows[0].merchant_order_id !== String(req.params.orderId || '')) {
        return res.status(404).json({ success: false, error: 'Receipt does not belong to this order' });
      }

      // Stream the file with proper content-type
      const absPath = path.resolve(row.file_path);
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ success: false, error: 'Receipt file missing on disk' });
      }
      res.setHeader('Content-Type', row.mime_type || 'image/png');
      res.setHeader('Content-Length', String(row.size_bytes || 0));
      res.setHeader('Cache-Control', 'private, max-age=300');
      fs.createReadStream(absPath).pipe(res);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  GET /api/admin/payments/llm-prompt-versions
//  List all prompt versions + their meta
// =============================================================
router.get(
  '/llm-prompt-versions',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (_req: Request, res: Response) => {
    try {
      const { listPromptVersions } = await import('../services/llm-feedback-loop.service');
      const versions = await listPromptVersions(50);
      res.json({ success: true, versions });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  POST /api/admin/payments/llm-prompt-rebuild
//  Manually trigger a feedback-loop rebuild
// =============================================================
router.post(
  '/llm-prompt-rebuild',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance']),
  async (_req: Request, res: Response) => {
    try {
      const { triggerManualRebuild } = await import('../services/llm-feedback-loop.service');
      const result = await triggerManualRebuild();
      res.json({ success: true, result });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);


// =============================================================
//  GET /api/admin/payments/chains
//  List enabled deposit chains (for /wallet/deposit UI)
// =============================================================
router.get(
  '/chains',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (_req: Request, res: Response) => {
    try {
      const { loadChainConfigs } = await import('../services/chain-config.service');
      const chains = await loadChainConfigs();
      res.json({ success: true, chains });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

// =============================================================
//  POST /api/admin/payments/chains/:chainKey/toggle
//  Enable/disable a deposit chain (admin only)
// =============================================================
router.post(
  '/chains/:chainKey/toggle',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const chainKey = String(req.params.chainKey || '').toUpperCase();
      const isEnabled = !!req.body?.isEnabled;
      const r = await query(
        `UPDATE deposit_chain_config SET is_enabled = $1, updated_at = NOW()
         WHERE chain_key = $2 RETURNING chain_key, is_enabled`,
        [isEnabled, chainKey]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Chain not found' });
      }
      const { invalidateChainCache } = await import('../services/chain-config.service');
      invalidateChainCache();
      res.json({ success: true, chainKey, isEnabled });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);


// =============================================================
//  POST /api/admin/payments/chains/:chainKey/config
//  Update chain config: address, fees, confirmations, enabled
// =============================================================
const updateChainConfigSchema = {
  // Build minimal zod-like validator inline to avoid schema-file churn
  is_enabled: 'boolean',
  deposit_address: 'string',
  display_name: 'string',
  network_code: 'string',
  token_symbol: 'string',
  memo_supported: 'boolean',
  min_confirmations: 'number',
  estimated_seconds: 'number',
  avg_fee_usdt: 'number',
  display_order: 'number',
  notes: 'string',
};

router.post(
  '/chains/:chainKey/config',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const chainKey = String(req.params.chainKey || '').toUpperCase();
      const body = req.body || {};
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      for (const [key, validatorType] of Object.entries(updateChainConfigSchema)) {
        if (!(key in body)) continue;
        const v = body[key];
        // Validate
        if (validatorType === 'boolean' && typeof v !== 'boolean') {
          return res.status(400).json({ success: false, error: `${key} must be boolean` });
        }
        if (validatorType === 'number' && typeof v !== 'number') {
          return res.status(400).json({ success: false, error: `${key} must be number` });
        }
        if (validatorType === 'string' && typeof v !== 'string') {
          return res.status(400).json({ success: false, error: `${key} must be string` });
        }
        sets.push(`${key} = $${i++}`);
        vals.push(v);
      }
      if (sets.length === 0) {
        return res.status(400).json({ success: false, error: 'no fields to update' });
      }
      vals.push(chainKey);
      const sql = `UPDATE deposit_chain_config SET ${sets.join(', ')}, updated_at = NOW()
                   WHERE chain_key = $${i} RETURNING *`;
      const r = await query(sql, vals);
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Chain not found' });
      }
      // Invalidate cache so next read sees the new config
      const { invalidateChainCache } = await import('../services/chain-config.service');
      invalidateChainCache();
      res.json({ success: true, chain: r.rows[0] });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: m });
    }
  }
);

export default router;
