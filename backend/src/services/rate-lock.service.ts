import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { priceFeedService } from './price-feed.service';
import { logger } from '../config/logger';
import { redis } from '../config/redis';
import { AppError, SecurityError } from '../utils/errors';
import { env } from '../config/env';

const prisma = new PrismaClient();
const RATE_LOCK_DURATION_MS = parseInt(env.RATE_LOCK_DURATION_MINUTES || '15') * 60 * 1000;
const MAX_ACTIVE_LOCKS_PER_USER = parseInt(env.MAX_ACTIVE_LOCKS_PER_USER || '3');

export class RateLockService {
  async createDepositLock(
    userId: string,
    pair: string,
    direction: 'buy' | 'sell',
    inputAmount: Decimal,
    ipAddress: string,
    deviceFingerprint: string
  ): Promise<{
    lockId: string;
    lockedRate: Decimal;
    inverseRate: Decimal;
    inputAmount: Decimal;
    outputAmount: Decimal;
    expiresAt: Date;
    source: string;
  }> {
    const activeLocks = await prisma.rateLock.count({
      where: {
        userId,
        status: 'active',
      },
    });

    if (activeLocks >= MAX_ACTIVE_LOCKS_PER_USER) {
      throw new SecurityError(`Maximum ${MAX_ACTIVE_LOCKS_PER_USER} active rate locks allowed. Complete or cancel existing deposits first.`);
    }

    const effectiveRate = await priceFeedService.getEffectiveRate(pair, direction);

    const rateAge = Date.now() - effectiveRate.fetchedAt.getTime();
    if (rateAge > 5 * 60 * 1000) {
      throw new AppError(503, 'RATE_STALE', 'Exchange rate is stale. Please try again in a moment.');
    }

    const outputAmount = inputAmount.times(effectiveRate.effectiveRate);

    const lock = await prisma.rateLock.create({
      data: {
        userId,
        currencyPair: pair,
        lockedRate: effectiveRate.effectiveRate,
        lockedInverseRate: effectiveRate.inverseRate,
        direction,
        inputAmount,
        outputAmount,
        exchangeRateId: effectiveRate.sourceId,
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + RATE_LOCK_DURATION_MS),
        status: 'active',
        ipAddress,
        deviceFingerprint,
      },
    });

    await redis.setex(
      `ratelock:${lock.id}`,
      Math.floor(RATE_LOCK_DURATION_MS / 1000),
      JSON.stringify({
        lockId: lock.id,
        userId,
        pair,
        lockedRate: effectiveRate.effectiveRate.toString(),
        outputAmount: outputAmount.toString(),
        expiresAt: lock.expiresAt.toISOString(),
      })
    );

    logger.info('Rate lock created', {
      lockId: lock.id,
      userId,
      pair,
      rate: effectiveRate.effectiveRate.toString(),
      outputAmount: outputAmount.toString(),
      expiresAt: lock.expiresAt,
    });

    return {
      lockId: lock.id,
      lockedRate: effectiveRate.effectiveRate,
      inverseRate: effectiveRate.inverseRate,
      inputAmount,
      outputAmount,
      expiresAt: lock.expiresAt,
      source: effectiveRate.source,
    };
  }

  async consumeLock(lockId: string, transactionId: string): Promise<{
    lockId: string;
    lockedRate: Decimal;
    outputAmount: Decimal;
    wasExpired: boolean;
  }> {
    const lock = await prisma.rateLock.findUnique({
      where: { id: lockId },
    });

    if (!lock) {
      throw new AppError(404, 'LOCK_NOT_FOUND', 'Rate lock not found');
    }

    if (lock.status === 'consumed') {
      throw new SecurityError('Rate lock already consumed');
    }

    if (lock.status === 'cancelled') {
      throw new SecurityError('Rate lock was cancelled');
    }

    const now = new Date();
    const wasExpired = lock.expiresAt < now;
    const gracePeriod = 5 * 60 * 1000;

    if (wasExpired && now.getTime() - lock.expiresAt.getTime() > gracePeriod) {
      await prisma.rateLock.update({
        where: { id: lockId },
        data: { status: 'expired' },
      });
      throw new AppError(410, 'LOCK_EXPIRED', 'Rate lock has expired. Please initiate a new deposit.');
    }

    await prisma.rateLock.update({
      where: { id: lockId },
      data: {
        status: 'consumed',
        consumedAt: now,
        consumedByTxId: transactionId,
      },
    });

    await redis.del(`ratelock:${lockId}`);

    return {
      lockId: lock.id,
      lockedRate: lock.lockedRate,
      outputAmount: lock.outputAmount,
      wasExpired: wasExpired && now.getTime() - lock.expiresAt.getTime() <= gracePeriod,
    };
  }

  async cancelLock(lockId: string, userId: string): Promise<void> {
    const lock = await prisma.rateLock.findFirst({
      where: { id: lockId, userId },
    });

    if (!lock) {
      throw new AppError(404, 'LOCK_NOT_FOUND', 'Rate lock not found');
    }

    if (lock.status !== 'active') {
      throw new AppError(400, 'LOCK_INVALID_STATE', `Rate lock is already ${lock.status}`);
    }

    await prisma.rateLock.update({
      where: { id: lockId },
      data: { status: 'cancelled' },
    });

    await redis.del(`ratelock:${lockId}`);
    logger.info('Rate lock cancelled', { lockId, userId });
  }

  async getActiveLock(userId: string, pair: string) {
    return prisma.rateLock.findFirst({
      where: {
        userId,
        currencyPair: pair,
        status: 'active',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cleanupExpiredLocks(): Promise<number> {
    const result = await prisma.rateLock.updateMany({
      where: {
        status: 'active',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });

    logger.info('Expired rate locks cleaned up', { count: result.count });
    return result.count;
  }
}

export const rateLockService = new RateLockService();
