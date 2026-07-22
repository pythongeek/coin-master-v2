import { PrismaClient } from '@prisma/client';
import { depositService } from '../services/deposit.service';
import { rateLockService } from '../services/rate-lock.service';
import { logger } from '../config/logger';
import { redis } from '../config/redis';

const prisma = new PrismaClient();

async function runDepositMonitor() {
  logger.info('Starting deposit monitor job...');

  try {
    const expiredLocks = await rateLockService.cleanupExpiredLocks();
    if (expiredLocks > 0) {
      logger.info(`Cleaned up ${expiredLocks} expired rate locks`);
    }

    const expiredDeposits = await depositService.expireOldDeposits();
    if (expiredDeposits > 0) {
      logger.info(`Expired ${expiredDeposits} old deposits`);
    }

    const stuckDeposits = await prisma.depositTransaction.findMany({
      where: {
        status: { in: ['payment_detected', 'confirming'] },
        detectedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
    });

    for (const deposit of stuckDeposits) {
      logger.error('Stuck deposit detected', {
        depositId: deposit.id,
        userId: deposit.userId,
        txId: deposit.blockchainTxId,
        status: deposit.status,
        detectedAt: deposit.detectedAt,
      });
    }

    const nearingExpiry = await prisma.depositTransaction.findMany({
      where: {
        status: { in: ['rate_locked', 'awaiting_payment'] },
        expiresAt: {
          gt: new Date(),
          lt: new Date(Date.now() + 5 * 60 * 1000),
        },
      },
    });

    for (const deposit of nearingExpiry) {
      logger.warn('Deposit nearing expiry', {
        depositId: deposit.id,
        userId: deposit.userId,
        expiresIn: Math.floor((deposit.expiresAt.getTime() - Date.now()) / 1000),
      });
    }

    logger.info('Deposit monitor job complete');
  } catch (error) {
    logger.error('Deposit monitor job failed', { error: (error as Error).message });
    process.exit(1);
  }
}

runDepositMonitor();
