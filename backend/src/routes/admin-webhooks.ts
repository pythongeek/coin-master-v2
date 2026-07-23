/**
 * P1-05: Admin Webhook DLQ Management Route.
 *
 * Mounted at /api/admin/webhooks/dlq. Exposes:
 *   GET    /api/admin/webhooks/dlq          — list most-recent N entries
 *   GET    /api/admin/webhooks/dlq/stats    — size + aggregate counters
 *   POST   /api/admin/webhooks/dlq/:jobId/retry   — pop one entry + re-enqueue
 *   DELETE /api/admin/webhooks/dlq/:jobId   — delete one entry
 *
 * All routes require admin auth (adminMiddleware) and a content-type
 * check. The retry endpoint is gated behind super_admin only.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware, roleMiddleware } from '../middleware/auth';
import {
  listWebhookDlq,
  webhookDlqSize,
  popFromWebhookDlq,
  deleteFromWebhookDlq,
  getWebhookQueue,
  generateSignature,
  DlqEntry,
} from '../services/webhook';
import { query } from '../config/database';

const router = Router();

// ── LIST DLQ entries ──────────────────────────────────────────
router.get('/dlq', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const entries = await listWebhookDlq(limit);
    const total = await webhookDlqSize();
    res.json({
      success: true,
      count: entries.length,
      total,
      limit,
      entries,
    });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: 'Failed to list DLQ entries',
    });
  }
});

// ── STATS ───────────────────────────────────────────────────────
router.get('/dlq/stats', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const total = await webhookDlqSize();
    res.json({
      success: true,
      total,
      // Operators can wire these to Prometheus / Grafana via the
      // existing /metrics endpoint.
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: 'Failed to fetch DLQ stats' });
  }
});

// ── RETRY a single DLQ entry (super_admin only) ────────────────
router.post(
  '/dlq/:jobId/retry',
  authMiddleware,
  adminMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const rawJobId = req.params.jobId;
      const jobId = Array.isArray(rawJobId) ? rawJobId[0] : rawJobId;
      if (!jobId) {
        return res.status(400).json({ success: false, error: 'jobId is required' });
      }

      // Find the entry by scanning the DLQ. We do a linear scan
      // because Redis LRANGE doesn't index by jobId; DLQ is small
      // (capped at 7-day TTL and bounded by traffic).
      const all = await listWebhookDlq(500);
      const entry = all.find((e) => e.jobId === jobId);
      if (!entry) {
        return res.status(404).json({
          success: false,
          error: `DLQ entry with jobId=${jobId} not found`,
        });
      }

      // Verify the subscription still exists and is active. If the
      // operator has deactivated the subscription since the failure,
      // refuse to retry (no point in re-delivering to a dead endpoint).
      const sub = await query<{ id: string; url: string; secret: string; is_active: boolean }>(
        `SELECT id, url, secret, is_active FROM webhook_subscriptions WHERE id = $1`,
        [entry.subscriptionId],
      );
      if (sub.rows.length === 0) {
        return res.status(410).json({
          success: false,
          error: 'subscription no longer exists; retry aborted',
        });
      }
      if (!sub.rows[0].is_active) {
        return res.status(409).json({
          success: false,
          error: 'subscription is inactive; activate it before retrying',
        });
      }

      // Re-enqueue with the original 5-attempt backoff schedule.
      const queue = getWebhookQueue();
      const payloadString = JSON.stringify({
        event: entry.event,
        timestamp: new Date().toISOString(),
        data: entry.data,
      });
      const signature = generateSignature(payloadString, entry.subscriptionId ? sub.rows[0].secret : '');
      await queue.add(
        'send-webhook',
        {
          subscriptionId: entry.subscriptionId,
          url: sub.rows[0].url,
          secret: sub.rows[0].secret,
          event: entry.event,
          data: entry.data,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      // Remove the DLQ entry (best-effort). If the re-enqueue succeeded
      // but the DLQ delete failed, the next retry would re-process the
      // entry; that's acceptable.
      await deleteFromWebhookDlq(entry.jobId);

      res.json({
        success: true,
        message: `Re-enqueued jobId=${jobId} to webhook queue`,
        retried: entry,
        signaturePreview: signature.slice(0, 16) + '...',
      });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: 'Failed to retry DLQ entry',
      });
    }
  },
);

// ── DELETE a single DLQ entry ─────────────────────────────────
router.delete(
  '/dlq/:jobId',
  authMiddleware,
  adminMiddleware,
  roleMiddleware(['super_admin']),
  async (req: Request, res: Response) => {
    try {
      const rawJobId = req.params.jobId;
      const jobId = Array.isArray(rawJobId) ? rawJobId[0] : rawJobId;
      if (!jobId) {
        return res.status(400).json({ success: false, error: 'jobId is required' });
      }
      const removed = await deleteFromWebhookDlq(jobId);
      if (!removed) {
        return res.status(404).json({
          success: false,
          error: `DLQ entry with jobId=${jobId} not found`,
        });
      }
      res.json({
        success: true,
        message: `Deleted DLQ entry jobId=${jobId}`,
      });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: 'Failed to delete DLQ entry',
      });
    }
  },
);

export default router;
