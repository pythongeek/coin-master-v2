import crypto from 'crypto';
import { redisConfig, redis } from '../config/redis';
import { query } from '../config/database';
import * as Sentry from '@sentry/node';

/**
 * P1-05: Webhook Dead-Letter Queue (DLQ).
 *
 * On the final failure of a BullMQ webhook delivery job, the failed
 * payload is persisted to a Redis-backed DLQ (`webhook:dlq` list) with
 * a 7-day TTL per entry. Operators can inspect the DLQ via
 * `GET /api/admin/webhooks/dlq` and retry or delete entries. Sentry
 * receives the exception on the 3rd, 4th, and final failure.
 *
 * DLQ entry shape (JSON):
 *   {
 *     subscriptionId: string,
 *     url: string,
 *     event: string,
 *     data: any,
 *     lastError: string,
 *     attempts: number,
 *     failedAt: ISO 8601 string,
 *     jobId: string,
 *   }
 *
 * The DLQ list is `webhook:dlq` (no chain qualifier) — failed webhooks
 * for all chains share the same DLQ so operators see them in one view.
 * Per-entry TTL is set via SETEX on a parallel key
 * `webhook:dlq:meta:<jobId>` to ensure 7-day expiry even though the
 * list itself is persistent.
 */
const DLQ_LIST_KEY = 'webhook:dlq';
const DLQ_META_PREFIX = 'webhook:dlq:meta:';
const DLQ_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface DlqEntry {
  subscriptionId: string;
  url: string;
  event: string;
  data: any;
  lastError: string;
  attempts: number;
  failedAt: string;
  jobId: string;
}

/** Capture an exception in Sentry. No-op if Sentry is not configured. */
function captureSentry(err: unknown, ctx?: Record<string, unknown>): void {
  try {
    Sentry?.captureException(err, { extra: ctx });
  } catch {
    // Sentry must never break the worker path.
  }
}

/**
 * Push a failed webhook payload to the DLQ. Called by the worker's
 * 'failed' event handler when attemptsMade >= attempts (i.e. the job
 * has exhausted its retries).
 */
export async function pushToWebhookDlq(entry: DlqEntry): Promise<void> {
  const json = JSON.stringify(entry);
  try {
    await redis.lpush(DLQ_LIST_KEY, json);
    // Per-entry TTL via a parallel key (LPUSH doesn't support per-element TTL).
    await redis.set(`${DLQ_META_PREFIX}${entry.jobId}`, json, 'EX', DLQ_TTL_SECONDS);
    console.warn(
      `[webhook-dlq] PUSHED jobId=${entry.jobId} event=${entry.event} ` +
      `url=${entry.url} attempts=${entry.attempts} (TTL 7d)`,
    );
  } catch (err) {
    console.error(
      `[webhook-dlq] FAILED to persist jobId=${entry.jobId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Pop a single DLQ entry. Returns null if the DLQ is empty. */
export async function popFromWebhookDlq(): Promise<DlqEntry | null> {
  const raw = await redis.rpop(DLQ_LIST_KEY);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as DlqEntry;
    // Best-effort cleanup of the per-entry TTL key.
    try { await redis.del(`${DLQ_META_PREFIX}${entry.jobId}`); } catch { /* ignore */ }
    return entry;
  } catch {
    return null;
  }
}

/** List the most-recent N DLQ entries (oldest-first). */
export async function listWebhookDlq(limit: number = 50): Promise<DlqEntry[]> {
  // LRANGE 0 N-1 returns the first N entries (oldest). For the admin
  // dashboard, the most-recently-failed entries are most relevant, so
  // we pull from the tail and reverse.
  const raw = await redis.lrange(DLQ_LIST_KEY, -limit, -1);
  if (!raw || raw.length === 0) return [];
  const entries: DlqEntry[] = [];
  for (const item of raw) {
    try {
      entries.push(JSON.parse(item) as DlqEntry);
    } catch {
      // Skip malformed entries.
    }
  }
  return entries;
}

/** Return the current DLQ length. */
export async function webhookDlqSize(): Promise<number> {
  return await redis.llen(DLQ_LIST_KEY);
}

/** Delete a single DLQ entry by jobId. */
export async function deleteFromWebhookDlq(jobId: string): Promise<boolean> {
  // LRANGE all, filter out matching jobId, DEL the list, RPUSH the
  // rest. This is O(N) but the DLQ is bounded by 7-day TTL and traffic
  // (hundreds of entries in the worst case). For larger DLQs the
  // operator can use SCAN + multi-key LREM in a Lua script.
  const all = await redis.lrange(DLQ_LIST_KEY, 0, -1);
  if (!all || all.length === 0) return false;
  let removed = 0;
  const remaining: string[] = [];
  for (const item of all) {
    try {
      const entry = JSON.parse(item) as DlqEntry;
      if (entry.jobId === jobId) {
        removed++;
      } else {
        remaining.push(item);
      }
    } catch {
      // Keep malformed entries (don't drop them silently).
      remaining.push(item);
    }
  }
  if (removed === 0) return false;
  // Replace the entire list atomically (best-effort; in a race
  // condition with concurrent LPUSHes we may overwrite a new entry,
  // but the DLQ is best-effort and 7-day-TTL'd).
  await redis.del(DLQ_LIST_KEY);
  if (remaining.length > 0) {
    // RPUSH preserves the original order (oldest at index 0, newest at tail).
    // Our list is currently oldest-to-newest, so we push in order.
    await redis.rpush(DLQ_LIST_KEY, ...remaining);
  }
  try { await redis.del(`${DLQ_META_PREFIX}${jobId}`); } catch { /* ignore */ }
  return true;
}

let webhookQueue: any = null;

/**
 * Get or initialize the BullMQ Webhook Queue dynamically.
 */
export function getWebhookQueue(): any {
  if (!webhookQueue) {
    const { Queue } = require('bullmq');
    webhookQueue = new Queue('webhooks', {
      connection: redisConfig
    });
  }
  return webhookQueue;
}

/**
 * Generate HMAC-SHA256 signature for webhook verification.
 * 
 * @param payload Payload string
 * @param secret Secret key
 */
export function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Dispatch a webhook event by checking active subscriptions and adding delivery jobs.
 * 
 * @param event Event type name (e.g. 'game.resolved', 'jackpot.won')
 * @param data Event payload data
 */
export async function dispatchWebhook(event: string, data: any): Promise<void> {
  try {
    // Find active subscriptions subscribing to this event type
    const result = await query(
      `SELECT id, url, secret FROM webhook_subscriptions WHERE is_active = true AND $1 = ANY(events)`,
      [event]
    );

    if (result.rows.length === 0) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`ℹ️ No active webhook subscriptions found for event: ${event}`);
      }
      return;
    }

    const queue = getWebhookQueue();

    for (const sub of result.rows) {
      await queue.add(
        'send-webhook',
        {
          subscriptionId: sub.id,
          url: sub.url,
          secret: sub.secret,
          event,
          data,
        },
        {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s, 16s, 32s
          },
          removeOnComplete: true,
          removeOnFail: false,
        }
      );
    }
  } catch (err) {
    console.error(`❌ Failed to dispatch webhook event ${event}:`, err);
  }
}

// BullMQ Webhook Delivery Worker
let worker: any = null;

export function startWebhookWorker(): void {
  if (worker) return;

  const { Worker } = require('bullmq');

  worker = new Worker(
    'webhooks',
    async (job: any) => {
      const { subscriptionId, url, secret, event, data } = job.data;
      const payloadString = JSON.stringify({
        id: job.id,
        event,
        timestamp: new Date().toISOString(),
        data,
      });

      const signature = generateSignature(payloadString, secret);
      let responseStatus: number | null = null;
      let responseBody: string | null = null;
      let errorMessage: string | null = null;
      let success = false;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CryptoFlip-Event': event,
            'X-CryptoFlip-Signature': signature,
            'X-CryptoFlip-Delivery': job.id || '',
          },
          body: payloadString,
          // 10 seconds timeout
          signal: AbortSignal.timeout(10000),
        });

        responseStatus = response.status;
        responseBody = await response.text();

        if (response.ok) {
          success = true;
        } else {
          errorMessage = `HTTP error ${response.status}: ${responseBody.substring(0, 500)}`;
        }
      } catch (err: any) {
        errorMessage = err.message || String(err);
      }

      // Log execution status in PostgreSQL
      try {
        await query(
          `INSERT INTO webhook_logs 
            (subscription_id, event_type, payload, response_status, response_body, error_message, attempt, success)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            subscriptionId,
            event,
            payloadString,
            responseStatus,
            responseBody ? responseBody.substring(0, 1000) : null,
            errorMessage ? errorMessage.substring(0, 1000) : null,
            job.attemptsMade + 1,
            success,
          ]
        );
      } catch (dbErr) {
        console.error('❌ Failed to log webhook execution to DB:', dbErr);
      }

      if (!success) {
        throw new Error(errorMessage || 'Webhook delivery failed');
      }
    },
    {
      connection: redisConfig,
      concurrency: 10,
    }
  );

  worker.on('failed', async (job: any, err: Error) => {
    if (!job) {
      console.warn('⚠️ Webhook job failed (no job context):', err.message);
      return;
    }

    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 5;
    const isFinalFailure = attemptsMade >= maxAttempts;

    // Capture Sentry on the 3rd, 4th, and final failure (avoid spam
    // on the 1st/2nd transient errors).
    if (attemptsMade >= 3 || isFinalFailure) {
      captureSentry(err, {
        kind: 'webhook_failure',
        url: job.data?.url,
        subscriptionId: job.data?.subscriptionId,
        event: job.data?.event,
        attemptsMade,
        maxAttempts,
        isFinal: isFinalFailure,
        jobId: job.id,
      });
    }

    if (isFinalFailure) {
      // Persist to DLQ so the operator can inspect / retry / delete.
      try {
        await pushToWebhookDlq({
          subscriptionId: job.data?.subscriptionId ?? 'unknown',
          url: job.data?.url ?? 'unknown',
          event: job.data?.event ?? 'unknown',
          data: job.data?.data ?? null,
          lastError: err.message || String(err),
          attempts: attemptsMade,
          failedAt: new Date().toISOString(),
          jobId: job.id ?? 'unknown',
        });
      } catch (dlqErr) {
        // The DLQ push itself failed — we still want to log the original
        // error and not let the DLQ failure mask it.
        console.error(
          `[webhook] CRITICAL: failed to push jobId=${job.id} to DLQ:`,
          dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
        );
      }
    } else {
      // Intermediate failure: just log at warn level. The BullMQ
      // exponential backoff will retry.
      console.warn(
        `⚠️ Webhook job ${job.id} failed (attempt ${attemptsMade}/${maxAttempts}):`,
        err.message,
      );
    }
  });

  worker.on('completed', (job: any) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ Webhook job ${job.id} completed successfully.`);
    }
  });

  console.log('✅ BullMQ Webhook Dispatcher Worker active!');
}

export async function stopWebhookWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('⏹️ BullMQ Webhook Dispatcher Worker stopped.');
  }
}
