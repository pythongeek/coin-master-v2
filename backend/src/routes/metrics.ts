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

// P2-18 — queue rejections from TronMcpService.enqueue().
// Increments when the queue is at maxQueueSize and a new request is
// refused. Operators should alert on a non-zero rate of these counters
// as they indicate the rate-limit loop is overwhelmed and the upstream
// TronGrid endpoint is too slow to drain the queue.
export const trongridQueueRejectedTotal = new Counter({
  name: 'trongrid_queue_rejected_total',
  help: 'Total number of requests rejected by the TronGrid MCP rate-limit queue because it is full',
  labelNames: ['reason'],
});

// ─── Gap 7: Group Play metrics ──────────────────────────────────
// Nine metrics covering the group-bet lifecycle. Cardinality is
// bounded by the label sets: payout_mode ∈ {equal, proportional,
// founder_boost}, turn_mode ∈ {creator, auto_on_full, random_lottery},
// winning_side ∈ {heads, tails}, signal_type ∈ {the 8 fraud signals},
// severity ∈ {low, medium, high, critical}, action ∈ { the 7 admin
// actions}. Worst-case series count: 3×3×2 + 8×4 + 7 = 57 series,
// which is well within Prometheus budget.

// 1. groupBetCreated — total groups created.
export const groupBetCreatedTotal = new Counter({
  name: 'group_bet_created_total',
  help: 'Total number of group bets created, labeled by payout_mode and turn_mode',
  labelNames: ['payout_mode', 'turn_mode'],
});

// 2. groupBetResolved — total groups resolved.
export const groupBetResolvedTotal = new Counter({
  name: 'group_bet_resolved_total',
  help: 'Total number of group bets resolved, labeled by payout_mode, turn_mode, winning_side',
  labelNames: ['payout_mode', 'turn_mode', 'winning_side'],
});

// 3. groupPoolSize — distribution of pool sizes at create time.
// Buckets cover micro (<$10), small ($10-$100), mid ($100-$500),
// large ($500-$1000), whale ($1k-$5k), and mega ($5k-$50k).
export const groupPoolSizeCoins = new Histogram({
  name: 'group_pool_size_coins',
  help: 'Distribution of group pool sizes in coins at create time',
  buckets: [10, 50, 100, 500, 1000, 5000, 50000],
});

// 4. groupMemberCount — distribution of current_members at create.
// Buckets cover min_members (2), typical 3-5, max default 7-10.
export const groupMemberCountGauge = new Histogram({
  name: 'group_member_count',
  help: 'Distribution of group current_members counts at create time',
  buckets: [2, 3, 5, 7, 10],
});

// 5. groupFlipDurationMs — wall-clock time from flip request to\ resolve.
// Buckets cover fast (<100ms), normal (<500ms), slow (<1s), very slow
// (<5s), and pathological (>30s — would indicate a stuck TX).
export const groupFlipDurationMs = new Histogram({
  name: 'group_flip_duration_ms',
  help: 'Wall-clock time in ms from flip request to room resolved',
  buckets: [100, 500, 1000, 5000, 30000],
});

// 6. groupFraudSignals — count of fraud signals emitted by group-bet-fraud.
// Labeled by the 8 signal types (group_sybil_suspected,
// group_vpn_suspected, etc.) and severity (low, medium, high, critical).
export const groupFraudSignalsTotal = new Counter({
  name: 'group_fraud_signals_total',
  help: 'Total number of group fraud signals by signal_type and severity',
  labelNames: ['signal_type', 'severity'],
});

// 7. groupAdminActions — count of admin actions on groups.
// Labeled by action (force_cancel, freeze, mark_fraud, refund, kick,
// shadow, ...).
export const groupAdminActionsTotal = new Counter({
  name: 'group_admin_actions_total',
  help: 'Total number of admin actions on group bets, labeled by action',
  labelNames: ['action'],
});

// 8. groupActiveCount — live count of active groups (open/ready/flipping).
// Refreshed every 30s by a setInterval in index.ts to avoid hitting
// the DB on every Prometheus scrape.
export const groupActiveCountGauge = new Gauge({
  name: 'group_active_count',
  help: 'Current number of group bets in non-terminal state (open/ready/flipping). Refreshed every 30s.',
});

// 9. groupInviteRedemptions — count of invite token redemptions.
// No labels — single number per redemption event. Operators can pair
// with groupInviteTokensCreatedTotal (future) for redemption rate.
export const groupInviteRedemptionsTotal = new Counter({
  name: 'group_invite_redemptions_total',
  help: 'Total number of group invite token redemptions',
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
