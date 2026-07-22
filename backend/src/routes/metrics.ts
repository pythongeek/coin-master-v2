import { Request, Response, Router } from 'express';
import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Prometheus metrics route.
 *
 * Mounted publicly at /metrics for Prometheus scraping. No auth required.
 * Custom metrics cover the core game / financial flows.
 */

const router = Router();

// Enable default Node.js / process / event loop / GC metrics.
collectDefaultMetrics({ prefix: 'cryptoflip_' });

// ── Custom counters ────────────────────────────────────────────────
export const httpRequestsTotal = new Counter({
  name: 'cryptoflip_http_requests_total',
  help: 'Total HTTP requests by method, route and status code',
  labelNames: ['method', 'route', 'status_code'],
});

export const betsPlacedTotal = new Counter({
  name: 'cryptoflip_bets_placed_total',
  help: 'Total number of bets placed',
  labelNames: ['choice'],
});

export const unusualBettingPatternsTotal = new Counter({
  name: 'cryptoflip_unusual_betting_patterns_total',
  help: 'Counter of fraud-flagged betting patterns',
});

export const depositsCreatedTotal = new Counter({
  name: 'cryptoflip_deposits_created_total',
  help: 'Deposit orders created by provider',
  labelNames: ['provider', 'status'],
});

export const withdrawalsCreatedTotal = new Counter({
  name: 'cryptoflip_withdrawals_created_total',
  help: 'Withdrawal requests created by status',
  labelNames: ['status'],
});

export const kycSubmittedTotal = new Counter({
  name: 'cryptoflip_kyc_submitted_total',
  help: 'KYC submissions by status',
  labelNames: ['status'],
});

// ── Custom histograms / gauges ─────────────────────────────────────
export const betAmountHistogram = new Histogram({
  name: 'cryptoflip_bet_amount_coins',
  help: 'Distribution of bet sizes in coins',
  buckets: [0.0001, 0.001, 0.01, 0.1, 1, 5, 10, 50, 100, 500, 1000],
});

export const hotWalletBalanceGauge = new Gauge({
  name: 'cryptoflip_hot_wallet_balance',
  help: 'Current hot wallet balance in USD equivalent',
  labelNames: ['chain'],
});

export const kycPendingGauge = new Gauge({
  name: 'cryptoflip_kyc_pending_count',
  help: 'Number of pending KYC verifications',
});

router.get('/', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export { router as metricsRoutes };
export default router;