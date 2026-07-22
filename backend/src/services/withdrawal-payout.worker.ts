import { Queue, Worker, Job } from 'bullmq';
import { redisConfig } from '../config/redis';
import { payoutTronWithdrawal } from './withdrawal-payout';
import { logger } from '../config/logger';

export const withdrawalPayoutQueue = new Queue('withdrawal-payout', { connection: redisConfig });

export const withdrawalPayoutWorker = new Worker('withdrawal-payout', async (job: Job) => {
  const { txId } = job.data;
  logger.info('Processing withdrawal payout', { txId, jobId: job.id });
  const result = await payoutTronWithdrawal(txId);
  if (!result.success) {
    throw new Error(result.error || 'Payout failed');
  }
  return { success: true, txHash: result.txHash };
}, {
  connection: redisConfig,
  autorun: true,
  concurrency: 1, // Sequential payouts to avoid nonce/UTXO conflicts and keep within rate limits
});
