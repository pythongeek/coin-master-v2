/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYOUT RECONCILIATION CRON — S1-W11
 * ═══════════════════════════════════════════════════════════════
 *
 *  Catches payout workflow failures that slip past the in-process
 *  BullMQ worker:
 *
 *  1. status='confirmed' (admin approved, BullMQ dispatched) but
 *     tx_hash IS NULL AND created_at > 30 min ago — the BullMQ job
 *     was eaten (Redis blip, worker crash, queue reset).
 *     Action: flip to 'payout_stuck' (S1-W3) so the admin resolve-stuck
 *     endpoint can take over.
 *
 *  2. status='pending' AND created_at > 48 hours — admin never
 *     approved/rejected. Action: log + alert admin. (Auto-refund is
 *     tracked separately as S1-W16 per the audit; not in this sprint.)
 *
 *  Schedule: every 5 minutes via setInterval (started in index.ts).
 *  Manual trigger: POST /api/admin/withdrawals/cron/payout-reconcile
 *  (NOT added in this PR — only the in-process + manual helpers).
 *
 *  Safety:
 *    - LIMIT 100 per run (long backlog doesn't lock the loop)
 *    - Errors per-row don't fail the whole batch
 *    - Default-off in tests (manual trigger only)
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';
import { logger } from '../config/logger';
import { queueAdminEmail } from './notification.service';

const STUCK_CONFIRMED_AGE_MS = 30 * 60 * 1000;  // 30 min
const STUCK_PENDING_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_ROWS_PER_RUN = 100;
const TICK_MS = 5 * 60 * 1000; // 5 minutes

export interface PayoutReconciliationResult {
  runAt: Date;
  durationMs: number;
  stuckConfirmed: number;     // flipped to payout_stuck
  stuckPending: number;       // just logged + alerted (auto-refund is W16)
  errors: Array<{ txId: string; error: string }>;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startPayoutReconciliationCron(): void {
  if (intervalHandle) return; // idempotent
  intervalHandle = setInterval(() => {
    runPayoutReconciliation().catch((err) => {
      logger.error('payout reconciliation cron crashed', { error: String(err) });
    });
  }, TICK_MS);
  logger.info('payout reconciliation cron started', { tickMs: TICK_MS });
}

export function stopPayoutReconciliationCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function runPayoutReconciliation(): Promise<PayoutReconciliationResult> {
  const runAt = new Date();
  const start = Date.now();
  const errors: PayoutReconciliationResult['errors'] = [];
  let stuckConfirmed = 0;
  let stuckPending = 0;

  // 1. Stuck 'confirmed' rows (admin approved but BullMQ didn't run).
  const stuckBefore = new Date(Date.now() - STUCK_CONFIRMED_AGE_MS);
  const confirmedRes = await query(
    `SELECT id, user_id, amount, created_at
       FROM transactions
       WHERE status = 'confirmed'
         AND tx_hash IS NULL
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT $2`,
    [stuckBefore, MAX_ROWS_PER_RUN],
  );

  for (const row of confirmedRes.rows) {
    try {
      await query(
        `UPDATE transactions
            SET status = 'payout_stuck',
                metadata = metadata || jsonb_build_object(
                  'payout_stuck_at', NOW()::text,
                  'payout_stuck_reason', 'reconciliation_no_tx_hash',
                  'payout_stuck_age_seconds', EXTRACT(EPOCH FROM (NOW() - $1::timestamptz))::int
                )
          WHERE id = $2 AND status = 'confirmed'`,
        [row.created_at, row.id],
      );
      stuckConfirmed++;

      await queueAdminEmail({
        event_type: 'withdrawal.payout_stuck_reconciliation',
        user_id: row.user_id,
        context: {
          withdrawal_id: row.id,
          amount: row.amount,
          age_seconds: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
          reason: 'reconciliation_no_tx_hash',
          resolve_endpoint: `/api/admin/withdrawals/${row.id}/resolve-stuck`,
        },
      }).catch((err) => {
        logger.error('payout reconciliation: failed to queue admin email', { txId: row.id, error: String(err) });
      });

      logger.warn('payout reconciliation: confirmed row missing tx_hash', {
        txId: row.id, ageSeconds: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
      });
    } catch (err) {
      errors.push({ txId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Stuck 'pending' rows (admin never approved). Just log + alert.
  //    Auto-refund is tracked separately as S1-W16.
  const pendingBefore = new Date(Date.now() - STUCK_PENDING_AGE_MS);
  const pendingRes = await query(
    `SELECT id, user_id, amount, created_at
       FROM transactions
       WHERE status = 'pending'
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT $2`,
    [pendingBefore, MAX_ROWS_PER_RUN],
  );

  for (const row of pendingRes.rows) {
    try {
      // Log only — do NOT mutate status. The S1-W16 auto-refund
      // will flip these to 'rejected' with a balance restore.
      logger.warn('payout reconciliation: pending withdrawal older than 48h', {
        txId: row.id,
        userId: row.user_id,
        amount: row.amount,
        ageSeconds: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
      });

      await queueAdminEmail({
        event_type: 'withdrawal.pending_stuck',
        user_id: row.user_id,
        context: {
          withdrawal_id: row.id,
          amount: row.amount,
          age_seconds: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
          note: 'Auto-refund pending S1-W16. Operator must manually approve/reject via admin panel.',
        },
      }).catch((err) => {
        logger.error('payout reconciliation: failed to queue pending-stuck email', { txId: row.id, error: String(err) });
      });

      stuckPending++;
    } catch (err) {
      errors.push({ txId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const result: PayoutReconciliationResult = {
    runAt,
    durationMs: Date.now() - start,
    stuckConfirmed,
    stuckPending,
    errors,
  };

  if (stuckConfirmed > 0 || stuckPending > 0 || errors.length > 0) {
    logger.info('payout reconciliation run complete', result);
  }

  return result;
}
