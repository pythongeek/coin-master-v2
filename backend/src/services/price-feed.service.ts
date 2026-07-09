import { PrismaClient, RateSourceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { redis } from '../config/redis';
import { AppError } from '../utils/errors';
import { env } from '../config/env';

const prisma = new PrismaClient();
const BINANCE_P2P_API = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const BINANCE_SPOT_API = 'https://api.binance.com/api/v3';
const BANGLADESH_BANK_API = 'https://www.bangladesh-bank.org/en/currency/exchange_rate';

const SOURCE_PRIORITY: RateSourceType[] = [
  'binance_p2p',
  'binance_spot',
  'bangladesh_bank',
  'custom',
];

interface PriceFeedResult {
  pair: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Decimal;
  inverseRate: Decimal;
  source: RateSourceType;
  sourceUrl: string;
  rawResponse: any;
  timestamp: Date;
}

export class PriceFeedService {
  private readonly STALE_THRESHOLD_MS = 5 * 60 * 1000;
  private readonly CACHE_TTL = 60;

  async getEffectiveRate(
    pair: string,
    direction: 'buy' | 'sell' = 'buy'
  ): Promise<{
    rate: Decimal;
    inverseRate: Decimal;
    source: RateSourceType;
    sourceId: string;
    spread: Decimal;
    effectiveRate: Decimal;
    fetchedAt: Date;
    expiresAt: Date;
  }> {
    const customDefault = await prisma.exchangeRate.findFirst({
      where: {
        currencyPair: pair,
        isPlatformDefault: true,
        sourceType: { in: ['custom', 'manual_override'] },
        isStale: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (customDefault) {
      const effectiveRate = direction === 'buy'
        ? customDefault.effectiveBuyRate
        : customDefault.effectiveSellRate;

      return {
        rate: customDefault.rate,
        inverseRate: customDefault.inverseRate,
        source: customDefault.sourceType,
        sourceId: customDefault.id,
        spread: direction === 'buy' ? customDefault.buySpread : customDefault.sellSpread,
        effectiveRate,
        fetchedAt: customDefault.fetchedAt,
        expiresAt: customDefault.expiresAt,
      };
    }

    const cacheKey = `rate:${pair}:market`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const cacheAge = Date.now() - new Date(parsed.fetchedAt).getTime();
      if (cacheAge < this.STALE_THRESHOLD_MS) {
        return {
          rate: new Decimal(parsed.rate),
          inverseRate: new Decimal(parsed.inverseRate),
          source: parsed.source,
          sourceId: parsed.sourceId,
          spread: new Decimal(parsed.spread),
          effectiveRate: new Decimal(parsed.effectiveRate),
          fetchedAt: new Date(parsed.fetchedAt),
          expiresAt: new Date(parsed.expiresAt),
        };
      }
    }

    const marketRate = await this.fetchMarketRate(pair);

    const buySpread = new Decimal(env.DEFAULT_BUY_SPREAD || '0.005');
    const sellSpread = new Decimal(env.DEFAULT_SELL_SPREAD || '0.005');

    const effectiveBuyRate = marketRate.rate.times(new Decimal(1).minus(buySpread));
    const effectiveSellRate = marketRate.rate.times(new Decimal(1).plus(sellSpread));

    const effectiveRate = direction === 'buy' ? effectiveBuyRate : effectiveSellRate;

    const existingDefault = await prisma.exchangeRate.findFirst({
      where: { currencyPair: pair, isPlatformDefault: true },
      orderBy: { createdAt: 'desc' },
    });

    const commonRateData = {
      rate: marketRate.rate,
      inverseRate: marketRate.inverseRate,
      sourceType: marketRate.source,
      sourceUrl: marketRate.sourceUrl,
      sourceResponse: marketRate.rawResponse,
      buySpread,
      sellSpread,
      effectiveBuyRate,
      effectiveSellRate,
      fetchedAt: marketRate.timestamp,
      isStale: false,
      expiresAt: new Date(Date.now() + this.STALE_THRESHOLD_MS),
      isPlatformDefault: true,
    };

    const stored = existingDefault
      ? await prisma.exchangeRate.update({
          where: { id: existingDefault.id },
          data: commonRateData,
        })
      : await prisma.exchangeRate.create({
          data: {
            currencyPair: pair,
            baseCurrency: marketRate.baseCurrency,
            quoteCurrency: marketRate.quoteCurrency,
            ...commonRateData,
          },
        });

    await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify({
      rate: marketRate.rate.toString(),
      inverseRate: marketRate.inverseRate.toString(),
      source: marketRate.source,
      sourceId: stored.id,
      spread: direction === 'buy' ? buySpread.toString() : sellSpread.toString(),
      effectiveRate: effectiveRate.toString(),
      fetchedAt: marketRate.timestamp.toISOString(),
      expiresAt: new Date(Date.now() + this.STALE_THRESHOLD_MS).toISOString(),
    }));

    return {
      rate: marketRate.rate,
      inverseRate: marketRate.inverseRate,
      source: marketRate.source,
      sourceId: stored.id,
      spread: direction === 'buy' ? buySpread : sellSpread,
      effectiveRate,
      fetchedAt: marketRate.timestamp,
      expiresAt: new Date(Date.now() + this.STALE_THRESHOLD_MS),
    };
  }

  async refreshAllRates(): Promise<PriceFeedResult[]> {
    const pairs = ['USDT_BDT', 'USDT_USD', 'USD_BDT'];
    const results: PriceFeedResult[] = [];

    for (const pair of pairs) {
      try {
        const rate = await this.fetchMarketRate(pair);
        results.push(rate);

        await prisma.exchangeRate.updateMany({
          where: {
            currencyPair: pair,
            isPlatformDefault: false,
            sourceType: { notIn: ['custom', 'manual_override'] },
            createdAt: { lt: new Date(Date.now() - this.STALE_THRESHOLD_MS) },
          },
          data: { isStale: true },
        });
      } catch (error) {
        logger.error(`Failed to refresh rate for ${pair}`, { error: (error as Error).message });
      }
    }

    return results;
  }

  async validateRate(rateId: string, maxDeviationPercent: number = 5): Promise<boolean> {
    const rate = await prisma.exchangeRate.findUnique({
      where: { id: rateId },
    });

    if (!rate) return false;
    if (rate.isStale) return false;
    if (rate.expiresAt < new Date()) return false;

    const currentMarket = await this.fetchMarketRate(rate.currencyPair);
    const deviation = currentMarket.rate.minus(rate.rate).abs()
      .dividedBy(rate.rate)
      .times(100);

    if (deviation.greaterThan(maxDeviationPercent)) {
      logger.error('Rate deviation exceeds threshold', {
        rateId,
        storedRate: rate.rate.toString(),
        marketRate: currentMarket.rate.toString(),
        deviation: deviation.toString(),
      });
      return false;
    }

    return true;
  }

  private async fetchMarketRate(pair: string): Promise<PriceFeedResult> {
    const [base, quote] = pair.split('_');

    for (const source of SOURCE_PRIORITY) {
      try {
        let result: PriceFeedResult | null = null;

        switch (source) {
          case 'binance_p2p':
            result = await this.fetchBinanceP2P(base, quote);
            break;
          case 'binance_spot':
            result = await this.fetchBinanceSpot(base, quote);
            break;
          case 'bangladesh_bank':
            result = await this.fetchBangladeshBank(base, quote);
            break;
          case 'custom':
            continue;
        }

        if (result) {
          logger.info(`Rate fetched from ${source}`, {
            pair,
            rate: result.rate.toString(),
            source,
          });
          return result;
        }
      } catch (error) {
        logger.warn(`Source ${source} failed for ${pair}`, { error: (error as Error).message });
        continue;
      }
    }

    throw new AppError(503, 'RATE_UNAVAILABLE', `Unable to fetch market rate for ${pair} from any source`);
  }

  private async fetchBinanceP2P(base: string, quote: string): Promise<PriceFeedResult | null> {
    if (base !== 'USDT' || quote !== 'BDT') return null;

    const response = await fetch(BINANCE_P2P_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'USDT',
        fiat: 'BDT',
        tradeType: 'BUY',
        page: 1,
        rows: 10,
        payTypes: [],
      }),
    });

    if (!response.ok) throw new Error(`Binance P2P API error: ${response.status}`);

    const data = (await response.json()) as any;

    if (!data.data || data.data.length === 0) {
      throw new Error('No P2P offers available');
    }

    const prices = data.data
      .map((offer: any) => parseFloat(offer.adv.price))
      .filter((p: number) => !isNaN(p))
      .sort((a: number, b: number) => a - b);

    if (prices.length === 0) throw new Error('No valid prices in P2P response');

    const trimCount = Math.floor(prices.length * 0.2);
    const trimmedPrices = prices.slice(trimCount, prices.length - trimCount);

    const medianPrice = trimmedPrices.reduce((a: number, b: number) => a + b, 0) / trimmedPrices.length;

    const rate = new Decimal(medianPrice.toFixed(2));
    const inverseRate = new Decimal(1).dividedBy(rate);

    return {
      pair: `${base}_${quote}`,
      baseCurrency: base,
      quoteCurrency: quote,
      rate,
      inverseRate,
      source: 'binance_p2p',
      sourceUrl: BINANCE_P2P_API,
      rawResponse: {
        offerCount: data.data.length,
        prices: trimmedPrices,
        medianPrice,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date(),
    };
  }

  private async fetchBinanceSpot(base: string, quote: string): Promise<PriceFeedResult | null> {
    const symbol = `${base}${quote}`;

    try {
      const response = await fetch(`${BINANCE_SPOT_API}/ticker/price?symbol=${symbol}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        const rate = new Decimal(data.price);
        return {
          pair: `${base}_${quote}`,
          baseCurrency: base,
          quoteCurrency: quote,
          rate,
          inverseRate: new Decimal(1).dividedBy(rate),
          source: 'binance_spot',
          sourceUrl: `${BINANCE_SPOT_API}/ticker/price?symbol=${symbol}`,
          rawResponse: data,
          timestamp: new Date(),
        };
      }
    } catch {
      const reverseSymbol = `${quote}${base}`;
      try {
        const response = await fetch(`${BINANCE_SPOT_API}/ticker/price?symbol=${reverseSymbol}`);
        if (response.ok) {
          const data = (await response.json()) as any;
          const inverseRate = new Decimal(data.price);
          const rate = new Decimal(1).dividedBy(inverseRate);
          return {
            pair: `${base}_${quote}`,
            baseCurrency: base,
            quoteCurrency: quote,
            rate,
            inverseRate,
            source: 'binance_spot',
            sourceUrl: `${BINANCE_SPOT_API}/ticker/price?symbol=${reverseSymbol}`,
            rawResponse: data,
            timestamp: new Date(),
          };
        }
      } catch {
        // Fall through
      }
    }

    if (base !== 'USDT' && quote !== 'USDT') {
      try {
        const [baseUsdt, quoteUsdt] = (await Promise.all([
          fetch(`${BINANCE_SPOT_API}/ticker/price?symbol=${base}USDT`).then(r => r.json()),
          fetch(`${BINANCE_SPOT_API}/ticker/price?symbol=${quote}USDT`).then(r => r.json()),
        ])) as [any, any];

        const basePrice = new Decimal(baseUsdt.price);
        const quotePrice = new Decimal(quoteUsdt.price);
        const rate = basePrice.dividedBy(quotePrice);

        return {
          pair: `${base}_${quote}`,
          baseCurrency: base,
          quoteCurrency: quote,
          rate,
          inverseRate: new Decimal(1).dividedBy(rate),
          source: 'binance_spot',
          sourceUrl: `${BINANCE_SPOT_API}/ticker/price (composite)`,
          rawResponse: { baseUsdt, quoteUsdt, composite: true },
          timestamp: new Date(),
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  private async fetchBangladeshBank(base: string, quote: string): Promise<PriceFeedResult | null> {
    if (base !== 'USD' || quote !== 'BDT') return null;

    try {
      const response = await fetch(BANGLADESH_BANK_API);
      if (!response.ok) throw new Error('Bangladesh Bank API unavailable');

      const html = await response.text();
      const match = html.match(/USD\s*[:\s]*([\d.]+)/i);
      if (!match) throw new Error('Could not parse USD rate');

      const rate = new Decimal(match[1]);

      return {
        pair: `${base}_${quote}`,
        baseCurrency: base,
        quoteCurrency: quote,
        rate,
        inverseRate: new Decimal(1).dividedBy(rate),
        source: 'bangladesh_bank',
        sourceUrl: BANGLADESH_BANK_API,
        rawResponse: { parsedRate: match[1], timestamp: new Date().toISOString() },
        timestamp: new Date(),
      };
    } catch {
      return null;
    }
  }
}

export const priceFeedService = new PriceFeedService();
