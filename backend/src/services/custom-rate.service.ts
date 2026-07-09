import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { v5 as uuidv5 } from 'uuid';
import { logger } from '../config/logger';
import { redis } from '../config/redis';
import { AppError, SecurityError } from '../utils/errors';

const prisma = new PrismaClient();

export class CustomRateService {
  private readonly PAIR_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  private pairToUuid(pair: string): string {
    return uuidv5(pair, this.PAIR_NAMESPACE);
  }

  async setCustomRate(
    adminId: string,
    pair: string,
    customRate: Decimal,
    buySpread: Decimal,
    sellSpread: Decimal,
    justification: string,
    validFrom: Date = new Date(),
    validUntil?: Date,
    autoRevert: boolean = true
  ): Promise<{
    configId: string;
    pair: string;
    customRate: Decimal;
    effectiveBuyRate: Decimal;
    effectiveSellRate: Decimal;
    isPlatformDefault: boolean;
    validFrom: Date;
    validUntil?: Date;
  }> {
    const marketRate = await this.getLastMarketRate(pair);
    if (marketRate) {
      const deviation = customRate.minus(marketRate).abs().dividedBy(marketRate).times(100);
      if (deviation.greaterThan(50)) {
        throw new SecurityError(
          `Custom rate deviates ${deviation.toFixed(2)}% from market rate. ` +
          `Maximum allowed deviation is 50%. Current market: ${marketRate.toFixed(2)}`
        );
      }
    }

    const effectiveBuyRate = customRate.times(new Decimal(1).minus(buySpread));
    const effectiveSellRate = customRate.times(new Decimal(1).plus(sellSpread));

    await prisma.$transaction(async (tx) => {
      await tx.customRateConfig.updateMany({
        where: {
          currencyPair: pair,
          isPlatformDefault: true,
        },
        data: {
          isPlatformDefault: false,
          isActive: false,
        },
      });

      // Clear platform default for this pair to avoid unique constraint
      await tx.exchangeRate.updateMany({
        where: {
          currencyPair: pair,
        },
        data: { isPlatformDefault: false },
      });

      await tx.customRateConfig.create({
        data: {
          currencyPair: pair,
          customRate,
          inverseRate: new Decimal(1).dividedBy(customRate),
          buySpread,
          sellSpread,
          isActive: true,
          isPlatformDefault: true,
          setById: adminId,
          justification,
          validFrom,
          validUntil,
          autoRevert,
        },
      });

      await tx.exchangeRate.create({
        data: {
          currencyPair: pair,
          baseCurrency: pair.split('_')[0],
          quoteCurrency: pair.split('_')[1],
          rate: customRate,
          inverseRate: new Decimal(1).dividedBy(customRate),
          sourceType: 'custom',
          buySpread,
          sellSpread,
          effectiveBuyRate,
          effectiveSellRate,
          fetchedAt: new Date(),
          expiresAt: validUntil || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          isPlatformDefault: true,
          setById: adminId,
          customJustification: justification,
        },
      });

      await tx.adminAction.create({
        data: {
          adminId,
          actionType: 'rate_override',
          targetType: 'currency',
          targetId: this.pairToUuid(pair),
          oldValue: marketRate ? { marketRate: marketRate.toString() } : undefined,
          newValue: {
            customRate: customRate.toString(),
            buySpread: buySpread.toString(),
            sellSpread: sellSpread.toString(),
            effectiveBuyRate: effectiveBuyRate.toString(),
            effectiveSellRate: effectiveSellRate.toString(),
          },
          justification,
          approvalStatus: 'executed',
          executedAt: new Date(),
        },
      });
    });

    await redis.del(`rate:${pair}:market`);
    await redis.del(`rate:${pair}:custom`);

    logger.info('Custom rate set as platform default', {
      pair,
      customRate: customRate.toString(),
      adminId,
      effectiveBuyRate: effectiveBuyRate.toString(),
      effectiveSellRate: effectiveSellRate.toString(),
    });

    return {
      configId: '',
      pair,
      customRate,
      effectiveBuyRate,
      effectiveSellRate,
      isPlatformDefault: true,
      validFrom,
      validUntil,
    };
  }

  async revertToMarketRate(
    adminId: string,
    pair: string,
    justification: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.customRateConfig.updateMany({
        where: {
          currencyPair: pair,
          isPlatformDefault: true,
        },
        data: {
          isPlatformDefault: false,
          isActive: false,
        },
      });

      await tx.exchangeRate.updateMany({
        where: {
          currencyPair: pair,
          isPlatformDefault: true,
          sourceType: { in: ['custom', 'manual_override'] },
        },
        data: { isPlatformDefault: false },
      });

      await tx.adminAction.create({
        data: {
          adminId,
          actionType: 'rate_override',
          targetType: 'currency',
          targetId: this.pairToUuid(pair),
          oldValue: { source: 'custom' },
          newValue: { source: 'market' },
          justification,
          approvalStatus: 'executed',
          executedAt: new Date(),
        },
      });
    });

    await redis.del(`rate:${pair}:market`);
    await redis.del(`rate:${pair}:custom`);

    logger.info('Reverted to market rate', { pair, adminId });
  }

  async getActiveCustomRate(pair: string) {
    return prisma.customRateConfig.findFirst({
      where: {
        currencyPair: pair,
        isActive: true,
        isPlatformDefault: true,
        validFrom: { lte: new Date() },
        OR: [
          { validUntil: null },
          { validUntil: { gt: new Date() } },
        ],
      },
    });
  }

  async listCustomRates(pair?: string) {
    return prisma.customRateConfig.findMany({
      where: pair ? { currencyPair: pair } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async autoRevertExpiredRates(): Promise<number> {
    const expired = await prisma.customRateConfig.findMany({
      where: {
        isActive: true,
        isPlatformDefault: true,
        autoRevert: true,
        validUntil: { lt: new Date() },
      },
    });

    for (const config of expired) {
      await this.revertToMarketRate(
        config.setById,
        config.currencyPair,
        'Auto-reverted: custom rate validity period expired'
      );
    }

    logger.info('Auto-reverted expired custom rates', { count: expired.length });
    return expired.length;
  }

  private async getLastMarketRate(pair: string): Promise<Decimal | null> {
    const lastMarket = await prisma.exchangeRate.findFirst({
      where: {
        currencyPair: pair,
        sourceType: { notIn: ['custom', 'manual_override'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    return lastMarket?.rate || null;
  }
}

export const customRateService = new CustomRateService();
