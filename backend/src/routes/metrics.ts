import { Request, Response, Router } from 'express';
import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * P1-06: /metrics endpoint IP allowlist.
 *
 * The /metrics route exposes business-sensitive counters (bets
 * placed, hot wallet balance, deposit USD totals, fraud alerts).
 * Previously public; now restricted to:
 *   1. IPs in the METRICS_IP_ALLOWLIST env var (comma-separated,
 *      supports both single IPs and CIDR ranges), or
 *   2. The default safe loopback set (127.0.0.1, ::1, 10.0.0.0/8,
 *      172.16.0.0/12, 192.168.0.0/16) when METRICS_IP_ALLOWLIST is unset.
 *
 * Unauthorized requests get HTTP 404 (not 403 — see security note
 * below). Operators can verify with:
 *   curl -i https://api.cryptoflip.../metrics        # from non-allowed IP -> 404
 *   curl -i https://api.cryptoflip.../metrics        # from allowed IP   -> 200
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

// ── P1-13: TronGrid endpoint failure counter ──────────────────
//
// Incremented by `services/tron-mcp.service.ts` whenever an endpoint
// failover is triggered (network error, timeout, or HTTP 5xx on the
// primary endpoint). Labeled by `endpoint` (URL host) and `status_code`
// (HTTP code or 'network_error' for non-HTTP failures). Operators
// should alert on a non-zero rate of these counters as they indicate
// TronGrid MCP degradation and could precede a full TRC-20 deposit
// detection outage.
export const trongridEndpointFailuresTotal = new Counter({
  name: 'trongrid_endpoint_failures_total',
  help: 'Total number of failed TronGrid MCP/RPC requests by endpoint and reason',
  labelNames: ['endpoint', 'status_code'],
});

// ─────────────────────────────────────────────────────────────────
// P1-06: IP allowlist logic
// ─────────────────────────────────────────────────────────────────

/**
 * Parse a CIDR string ("10.0.0.0/8") or single IP ("1.2.3.4") into a
 * matcher function. Returns null for malformed input (caller logs a
 * warning and skips the entry).
 */
function parseCidrOrIp(entry: string): ((ip: string) => boolean) | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('/')) {
    // Single IP: exact match.
    return (ip: string) => ip === trimmed;
  }
  const [base, bitsStr] = trimmed.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return null;
  // Convert base IP to a 32-bit integer.
  const baseParts = base.split('.');
  if (baseParts.length !== 4) return null;
  const baseNum = baseParts.reduce(
    (acc, oct) => (acc * 256) + (parseInt(oct, 10) & 0xff),
    0,
  );
  if (baseNum > 0xffffffff) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip: string) => {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    const ipNum = parts.reduce(
      (acc, oct) => (acc * 256) + (parseInt(oct, 10) & 0xff),
      0,
    );
    return ((ipNum & mask) >>> 0) === ((baseNum & mask) >>> 0);
  };
}

/**
 * Build the list of IP matchers. Order:
 *   1. METRICS_IP_ALLOWLIST env var (if set)
 *   2. Default loopback + private-RFC1918 ranges
 *
 * IPv6 addresses are currently treated as NOT in any allowlist
 * (return false) unless they appear literally in METRICS_IP_ALLOWLIST.
 * Future enhancement: add IPv6 CIDR parsing.
 */
function buildAllowlist(): Array<(ip: string) => boolean> {
  const allowlist: Array<(ip: string) => boolean> = [];
  const env = process.env.METRICS_IP_ALLOWLIST;
  if (env && env.trim().length > 0) {
    for (const entry of env.split(',')) {
      const matcher = parseCidrOrIp(entry);
      if (matcher) {
        allowlist.push(matcher);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[metrics] WARNING: ignoring malformed METRICS_IP_ALLOWLIST entry: ${entry}`,
        );
      }
    }
  }
  // Always include safe loopback + RFC1918 private ranges so the
  // default deployment works without env configuration. Operators
  // can override or extend via METRICS_IP_ALLOWLIST.
  const defaultRanges = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
  for (const entry of defaultRanges) {
    const matcher = parseCidrOrIp(entry);
    if (matcher) allowlist.push(matcher);
  }
  return allowlist;
}

// Memoize so we don't re-parse on every request.
let cachedAllowlist: Array<(ip: string) => boolean> | null = null;
let cachedEnvKey: string | null = null;
function getAllowlist(): Array<(ip: string) => boolean> {
  const currentKey = process.env.METRICS_IP_ALLOWLIST ?? null;
  if (cachedAllowlist === null || cachedEnvKey !== currentKey) {
    cachedAllowlist = buildAllowlist();
    cachedEnvKey = currentKey;
  }
  return cachedAllowlist;
}

/** Normalize the request IP (strip IPv6-mapped-IPv4 prefix, etc.). */
function normalizeIp(ip: string): string {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/**
 * IP allowlist middleware. Returns 404 for unauthorized requests
 * (deliberately indistinguishable from a missing route — this avoids
 * confirming to a port-scanner that the /metrics endpoint exists).
 * On allow: calls next().
 */
export function metricsIpAllowlist(req: Request, res: Response, next: () => void): void {
  const allowlist = getAllowlist();
  // Express's req.ip respects 'trust proxy' setting; falls back to
  // socket.remoteAddress. We handle both v4-mapped-v6 and bare v4.
  const rawIp = req.ip || (req.socket && req.socket.remoteAddress) || '';
  const ip = normalizeIp(rawIp);
  if (!ip) {
    res.status(404).end();
    return;
  }
  for (const match of allowlist) {
    if (match(ip)) {
      next();
      return;
    }
  }
  // SECURITY: respond 404 (not 403) so port-scanners can't enumerate
  // the existence of the /metrics endpoint.
  res.status(404).end();
}

router.get('/', metricsIpAllowlist, async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export { router as metricsRoutes };
export default router;
