import { PrismaClient, DepositStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { rateLockService } from './rate-lock.service';
import { walletService } from './wallet.service';
import { logger } from '../config/logger';
import { redis } from '../config/redis';
import { AppError, SecurityError } from '../utils/errors';
import { env } from '../config/env';

const prisma = new PrismaClient();
const TRON_REQUIRED_CONFIRMATIONS = 19;
const DEPOSIT_EXPIRY_MS = parseInt(env.DEPOSIT_EXPIRY_MINUTES || '60') * 60 * 1000;

// Hardcoded USDT configuration for the v2.1.0 deposit system.
// Admin panel can later seed / manage the currencies table.
const USDT_CURRENCY_ID = '00000000-0000-0000-0000-000000000001';
const USDT_CONFIG = {
  id: USDT_CURRENCY_ID,
  code: 'USDT' as const,
  isActive: true,
  minDeposit: new Decimal(10),
  maxDeposit: new Decimal(100000),
  withdrawalFee: new Decimal(0),
  decimalPlaces: 6,
};

export class DepositService {
  async initiateDeposit(
    userId: string,
    cryptoAmount: Decimal,
    currencyPair: string = 'USDT_BDT',
    ipAddress: string,
    deviceFingerprint: string
  ): Promise<{
    depositId: string;
    lockId: string;
    depositAddress: string;
    cryptoAmount: Decimal;
    fiatEquivalent: Decimal;
    lockedRate: Decimal;
    expiresAt: Date;
    network: string;
    memo: string;
  }> {
    if (!USDT_CONFIG.isActive) {
      throw new SecurityError('USDT deposits are currently disabled');
    }

    if (cryptoAmount.lessThan(USDT_CONFIG.minDeposit)) {
      throw new AppError(400, 'BELOW_MINIMUM', `Minimum deposit is ${USDT_CONFIG.minDeposit} USDT`);
    }

    if (cryptoAmount.greaterThan(USDT_CONFIG.maxDeposit)) {
      throw new AppError(400, 'ABOVE_MAXIMUM', `Maximum deposit is ${USDT_CONFIG.maxDeposit} USDT`);
    }

    const lock = await rateLockService.createDepositLock(
      userId,
      currencyPair,
      'buy',
      cryptoAmount,
      ipAddress,
      deviceFingerprint
    );

    const depositAddress = env.HOT_WALLET_ADDRESS || 'TExampleAddress123456789';
    const memo = this.generateMemo(userId, lock.lockId);

    const expiresAt = new Date(Date.now() + DEPOSIT_EXPIRY_MS);
    const deposit = await prisma.depositTransaction.create({
      data: {
        userId,
        currencyId: USDT_CONFIG.id,
        rateLockId: lock.lockId,
        blockchainNetwork: 'TRON',
        toAddress: depositAddress,
        cryptoAmount,
        fiatEquivalent: lock.outputAmount,
        platformFee: new Decimal(0),
        netCreditAmount: lock.outputAmount,
        status: 'rate_locked',
        statusHistory: [
          { status: 'initiated', at: new Date().toISOString() },
          { status: 'rate_locked', at: new Date().toISOString(), rate: lock.lockedRate.toString() },
        ],
        initiatedAt: new Date(),
        lockedAt: new Date(),
        expiresAt,
      },
    });

    await redis.setex(
      `deposit:${deposit.id}`,
      Math.floor(DEPOSIT_EXPIRY_MS / 1000),
      JSON.stringify({
        depositId: deposit.id,
        userId,
        lockId: lock.lockId,
        address: depositAddress,
        expectedAmount: cryptoAmount.toString(),
        memo,
        expiresAt: deposit.expiresAt.toISOString(),
      })
    );

    logger.info('Deposit initiated', {
      depositId: deposit.id,
      userId,
      lockId: lock.lockId,
      cryptoAmount: cryptoAmount.toString(),
      fiatEquivalent: lock.outputAmount.toString(),
      rate: lock.lockedRate.toString(),
    });

    return {
      depositId: deposit.id,
      lockId: lock.lockId,
      depositAddress,
      cryptoAmount,
      fiatEquivalent: lock.outputAmount,
      lockedRate: lock.lockedRate,
      expiresAt,
      network: 'TRON (TRC-20)',
      memo,
    };
  }

  async detectPayment(
    depositId: string,
    blockchainTxId: string,
    fromAddress: string,
    actualAmount: Decimal
  ): Promise<void> {
    const deposit = await prisma.depositTransaction.findUnique({
      where: { id: depositId },
    });

    if (!deposit) {
      throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    }

    if (deposit.status !== 'rate_locked' && deposit.status !== 'awaiting_payment') {
      throw new AppError(400, 'INVALID_STATE', `Deposit is in ${deposit.status} state`);
    }

    const tolerance = deposit.cryptoAmount.times(0.01);
    const difference = actualAmount.minus(deposit.cryptoAmount).abs();

    if (difference.greaterThan(tolerance)) {
      await prisma.depositTransaction.update({
        where: { id: depositId },
        data: {
          status: 'failed',
          failureReason: `Amount mismatch: expected ${deposit.cryptoAmount}, received ${actualAmount}`,
          statusHistory: {
            push: {
              status: 'failed',
              at: new Date().toISOString(),
              reason: 'amount_mismatch',
              expected: deposit.cryptoAmount.toString(),
              received: actualAmount.toString(),
            },
          },
        },
      });

      logger.error('Deposit amount mismatch', {
        depositId,
        expected: deposit.cryptoAmount.toString(),
        received: actualAmount.toString(),
      });

      throw new AppError(400, 'AMOUNT_MISMATCH', 'Received amount does not match expected amount');
    }

    await prisma.depositTransaction.update({
      where: { id: depositId },
      data: {
        status: 'payment_detected',
        blockchainTxId,
        fromAddress,
        statusHistory: {
          push: {
            status: 'payment_detected',
            at: new Date().toISOString(),
            txId: blockchainTxId,
            amount: actualAmount.toString(),
          },
        },
        detectedAt: new Date(),
      },
    });

    logger.info('Payment detected', {
      depositId,
      txId: blockchainTxId,
      amount: actualAmount.toString(),
    });
  }

  async confirmDeposit(depositId: string, confirmations: number): Promise<void> {
    const deposit = await prisma.depositTransaction.findUnique({
      where: { id: depositId },
    });

    if (!deposit) {
      throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    }

    if (deposit.status !== 'payment_detected' && deposit.status !== 'confirming') {
      throw new AppError(400, 'INVALID_STATE', `Deposit is in ${deposit.status} state`);
    }

    if (!deposit.rateLockId) {
      throw new AppError(500, 'LOCK_MISSING', 'Rate lock missing for deposit');
    }

    const consumed = await rateLockService.consumeLock(
      deposit.rateLockId,
      depositId
    );

    await prisma.depositTransaction.update({
      where: { id: depositId },
      data: {
        confirmations,
        status: 'confirming',
        statusHistory: {
          push: {
            status: 'confirming',
            at: new Date().toISOString(),
            confirmations,
          },
        },
      },
    });

    if (confirmations >= TRON_REQUIRED_CONFIRMATIONS) {
      await this.completeDeposit(depositId, consumed);
    }
  }

  private async completeDeposit(
    depositId: string,
    lockResult: { lockId: string; lockedRate: Decimal; outputAmount: Decimal; wasExpired: boolean }
  ): Promise<void> {
    const deposit = await prisma.depositTransaction.findUnique({
      where: { id: depositId },
    });

    if (!deposit) return;

    const platformFee = USDT_CONFIG.withdrawalFee;
    const netCredit = lockResult.outputAmount.minus(platformFee);

    if (netCredit.lessThan(0)) {
      throw new AppError(400, 'FEE_EXCEEDS_AMOUNT', 'Platform fee exceeds deposit amount');
    }

    await walletService.processDeposit(
      deposit.userId,
      deposit.currencyId,
      netCredit,
      depositId,
      `Deposit ${deposit.cryptoAmount} USDT @ ${lockResult.lockedRate.toFixed(2)} BDT/USDT`
    );

    await prisma.depositTransaction.update({
      where: { id: depositId },
      data: {
        status: 'completed',
        platformFee,
        netCreditAmount: netCredit,
        statusHistory: {
          push: {
            status: 'completed',
            at: new Date().toISOString(),
            credited: netCredit.toString(),
            fee: platformFee.toString(),
            wasExpired: lockResult.wasExpired,
          },
        },
        completedAt: new Date(),
      },
    });

    logger.info('Deposit completed', {
      depositId,
      userId: deposit.userId,
      cryptoAmount: deposit.cryptoAmount.toString(),
      credited: netCredit.toString(),
      fee: platformFee.toString(),
      rate: lockResult.lockedRate.toString(),
      wasExpired: lockResult.wasExpired,
    });
  }

  async expireOldDeposits(): Promise<number> {
    const expired = await prisma.depositTransaction.updateMany({
      where: {
        status: { in: ['initiated', 'rate_locked', 'awaiting_payment'] },
        expiresAt: { lt: new Date() },
      },
      data: {
        status: 'expired',
        statusHistory: {
          push: {
            status: 'expired',
            at: new Date().toISOString(),
            reason: 'timeout',
          },
        },
        expiredAt: new Date(),
      },
    });

    const oldDeposits = await prisma.depositTransaction.findMany({
      where: {
        status: 'expired',
        expiredAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });

    for (const dep of oldDeposits) {
      if (dep.rateLockId) {
        const lock = await prisma.rateLock.findUnique({ where: { id: dep.rateLockId } });
        if (lock && lock.status === 'active') {
          await rateLockService.cancelLock(lock.id, dep.userId);
        }
      }
      await redis.del(`deposit:${dep.id}`);
    }

    logger.info('Expired deposits cleaned up', { count: expired.count });
    return expired.count;
  }

  async getDepositStatus(depositId: string, userId: string) {
    const deposit = await prisma.depositTransaction.findFirst({
      where: { id: depositId, userId },
    });

    if (!deposit) {
      throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    }

    let lockedRate: string | undefined;
    if (deposit.rateLockId) {
      const lock = await prisma.rateLock.findUnique({ where: { id: deposit.rateLockId } });
      lockedRate = lock?.lockedRate.toString();
    }

    return {
      id: deposit.id,
      status: deposit.status,
      cryptoAmount: deposit.cryptoAmount.toString(),
      fiatEquivalent: deposit.fiatEquivalent.toString(),
      netCreditAmount: deposit.netCreditAmount?.toString(),
      platformFee: deposit.platformFee.toString(),
      lockedRate,
      toAddress: deposit.toAddress,
      blockchainTxId: deposit.blockchainTxId,
      confirmations: deposit.confirmations,
      requiredConfirmations: TRON_REQUIRED_CONFIRMATIONS,
      expiresAt: deposit.expiresAt,
      completedAt: deposit.completedAt,
      statusHistory: deposit.statusHistory,
    };
  }

  async getDepositHistory(userId: string, limit: number = 20, offset: number = 0) {
    const deposits = await prisma.depositTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return deposits.map(d => ({
      ...d,
      rateLock: d.rateLockId ? null : null, // placeholder, caller can query separately if needed
    }));
  }

  private generateDepositAddress(userId: string): string {
    return env.HOT_WALLET_ADDRESS || 'TExampleAddress123456789';
  }

  private generateMemo(userId: string, lockId: string): string {
    const data = `${userId}:${lockId}:${Date.now()}`;
    return Buffer.from(data).toString('base64').slice(0, 32);
  }
}

export const depositService = new DepositService();
