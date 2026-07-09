import { priceFeedService } from '../services/price-feed.service';
import { customRateService } from '../services/custom-rate.service';
import { logger } from '../config/logger';

async function runPriceSync() {
  logger.info('Starting price sync job...');

  try {
    const results = await priceFeedService.refreshAllRates();
    logger.info(`Refreshed ${results.length} market rates`, {
      rates: results.map(r => ({ pair: r.pair, rate: r.rate.toString(), source: r.source })),
    });

    const reverted = await customRateService.autoRevertExpiredRates();
    if (reverted > 0) {
      logger.info(`Auto-reverted ${reverted} expired custom rates`);
    }

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const activeCustoms = await prisma.customRateConfig.findMany({
      where: {
        isActive: true,
        isPlatformDefault: true,
      },
    });

    for (const config of activeCustoms) {
      try {
        const marketRate = await priceFeedService.getEffectiveRate(config.currencyPair, 'buy');
        const deviation = config.customRate.minus(marketRate.rate).abs()
          .dividedBy(marketRate.rate)
          .times(100);

        if (deviation.greaterThan(20)) {
          logger.error('CRITICAL: Custom rate deviates significantly from market', {
            pair: config.currencyPair,
            customRate: config.customRate.toString(),
            marketRate: marketRate.rate.toString(),
            deviation: `${deviation.toFixed(2)}%`,
          });
        }
      } catch (e) {
        logger.warn(`Could not validate custom rate for ${config.currencyPair}`, { error: (e as Error).message });
      }
    }

    await prisma.$disconnect();
    logger.info('Price sync job complete');
  } catch (error) {
    logger.error('Price sync job failed', { error: (error as Error).message });
    process.exit(1);
  }
}

runPriceSync();
