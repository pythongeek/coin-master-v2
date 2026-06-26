import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import { redisConfig } from '../config/redis';
import { query } from '../config/database';

// Initialize BullMQ Webhook Queue
export const webhookQueue = new Queue('webhooks', {
  connection: redisConfig
});

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

    for (const sub of result.rows) {
      await webhookQueue.add(
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
let worker: Worker | null = null;

export function startWebhookWorker(): void {
  if (worker) return;

  worker = new Worker(
    'webhooks',
    async (job: Job) => {
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

  worker.on('failed', (job, err) => {
    console.warn(`⚠️ Webhook job ${job?.id} failed:`, err.message);
  });

  worker.on('completed', (job) => {
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
