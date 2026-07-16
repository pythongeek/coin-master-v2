/**
 * Phase 3 / P3-3b — Audience-graph metric endpoint.
 *
 * One endpoint, six audience views. Each metric runs a single GROUP BY
 * query against the existing production tables (no new schema) and
 * returns top-N nodes + a sparse edge list (only "star" edges from
 * each user to a synthetic centre node — keeps the D3 graph visually
 * clean: a constellation, not a hairball).
 *
 * Metrics:
 *   - top_depositors:  last 30d, sum(deposit amount) per user
 *   - top_winners:     last 30d, sum(bet_payout amount) per user
 *   - top_withdrawers: last 30d, sum(withdrawal amount) per user
 *   - top_volume:      last 30d, sum(bet amount) per user
 *   - top_risk:        current risk_score from user_risk_scores
 *   - top_fraud_signals:last 30d, count(*) fraud_signals per user
 *
 * Admin-only (super_admin + finance + auditor).
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { query } from '../config/database';

const router = Router();

const VALID_METRICS = [
  'top_depositors', 'top_winners', 'top_withdrawers',
  'top_volume', 'top_risk', 'top_fraud_signals',
] as const;
type Metric = (typeof VALID_METRICS)[number];

const TIER_COLOR: Record<string, string> = {
  critical: '#dc3545', high_risk: '#fd7e14', medium_risk: '#eab308',
  low_risk: '#3b82f6', safe: '#6b7280',
};

interface Node {
  id: string;
  username?: string;
  metric: number;
  metricLabel: string;
  riskScore?: number;
  riskTier?: string;
  isFlagged?: boolean;
}

interface Edge {
  id: string;
  a: string;
  b: string;
  weight: number;
}

interface AudienceMetricResult {
  metric: Metric;
  generatedAt: string;
  range: { from: string; to: string };
  nodes: Node[];
  edges: Edge[];
}

const DAY = 86_400_000;

function clampTier(s: string | null | undefined): string {
  if (!s) return 'safe';
  return TIER_COLOR[s] ? s : 'safe';
}

/**
 * Run the requested metric. Returns up to `limit` nodes + the same
 * number of synthetic star-edges (one per node, pointing at a single
 * centre node). The centre node keeps the graph from collapsing to a
 * single point and makes the force simulation push everyone outward.
 */
async function runMetric(metric: Metric, limit: number): Promise<AudienceMetricResult> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const now = new Date();
  const from = new Date(now.getTime() - 30 * DAY);
  let nodes: Node[] = [];

  if (metric === 'top_depositors') {
    const r = await query(
      `SELECT u.id, u.username,
              COALESCE(SUM(t.amount), 0)::float8 AS amt,
              u.risk_score, u.risk_tier, u.is_flagged
         FROM users u
         JOIN transactions t
           ON t.user_id = u.id
          AND t.type = 'deposit'
          AND t.status = 'completed'
          AND t.completed_at >= $1
        GROUP BY u.id, u.username, u.risk_score, u.risk_tier, u.is_flagged
        ORDER BY amt DESC
        LIMIT $2::int`,
      [from.toISOString(), safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; amt: number; risk_score: number | null; risk_tier: string | null; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.amt),
      metricLabel: `Deposited`,
      riskScore: row.risk_score ?? 0,
      riskTier: clampTier(row.risk_tier),
      isFlagged: row.is_flagged,
    }));
  } else if (metric === 'top_winners') {
    const r = await query(
      `SELECT u.id, u.username,
              COALESCE(SUM(t.amount), 0)::float8 AS amt,
              u.risk_score, u.risk_tier, u.is_flagged
         FROM users u
         JOIN transactions t
           ON t.user_id = u.id
          AND t.type IN ('win', 'bet_payout', 'game_win', 'rain')
          AND t.status = 'completed'
          AND t.completed_at >= $1
        GROUP BY u.id, u.username, u.risk_score, u.risk_tier, u.is_flagged
        ORDER BY amt DESC
        LIMIT $2::int`,
      [from.toISOString(), safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; amt: number; risk_score: number | null; risk_tier: string | null; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.amt),
      metricLabel: `Won`,
      riskScore: row.risk_score ?? 0,
      riskTier: clampTier(row.risk_tier),
      isFlagged: row.is_flagged,
    }));
  } else if (metric === 'top_withdrawers') {
    const r = await query(
      `SELECT u.id, u.username,
              COALESCE(SUM(t.amount), 0)::float8 AS amt,
              u.risk_score, u.risk_tier, u.is_flagged
         FROM users u
         JOIN transactions t
           ON t.user_id = u.id
          AND t.type = 'withdrawal'
          AND t.status = 'completed'
          AND t.completed_at >= $1
        GROUP BY u.id, u.username, u.risk_score, u.risk_tier, u.is_flagged
        ORDER BY amt DESC
        LIMIT $2::int`,
      [from.toISOString(), safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; amt: number; risk_score: number | null; risk_tier: string | null; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.amt),
      metricLabel: `Withdrawn`,
      riskScore: row.risk_score ?? 0,
      riskTier: clampTier(row.risk_tier),
      isFlagged: row.is_flagged,
    }));
  } else if (metric === 'top_volume') {
    const r = await query(
      `SELECT u.id, u.username,
              COALESCE(SUM(t.amount), 0)::float8 AS amt,
              u.risk_score, u.risk_tier, u.is_flagged
         FROM users u
         JOIN transactions t
           ON t.user_id = u.id
          AND t.type IN ('bet', 'wager')
          AND t.status = 'completed'
          AND t.completed_at >= $1
        GROUP BY u.id, u.username, u.risk_score, u.risk_tier, u.is_flagged
        ORDER BY amt DESC
        LIMIT $2::int`,
      [from.toISOString(), safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; amt: number; risk_score: number | null; risk_tier: string | null; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.amt),
      metricLabel: `Wagered`,
      riskScore: row.risk_score ?? 0,
      riskTier: clampTier(row.risk_tier),
      isFlagged: row.is_flagged,
    }));
  } else if (metric === 'top_risk') {
    // Read directly from user_risk_scores (the blended score is the
    // best single number to surface). No time window — current state.
    const r = await query(
      `SELECT u.id, u.username,
              urs.current_score::float8 AS score,
              urs.tier,
              u.is_flagged
         FROM user_risk_scores urs
         JOIN users u ON u.id = urs.user_id
        ORDER BY urs.current_score DESC
        LIMIT $1::int`,
      [safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; score: number; tier: string; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.score),
      metricLabel: `Risk score`,
      riskScore: Number(row.score),
      riskTier: clampTier(row.tier),
      isFlagged: row.is_flagged,
    }));
  } else if (metric === 'top_fraud_signals') {
    const r = await query(
      `SELECT u.id, u.username,
              count(*)::int AS cnt,
              u.risk_score, u.risk_tier, u.is_flagged
         FROM users u
         JOIN fraud_signals fs ON fs.user_id = u.id
        WHERE fs.created_at >= $1
        GROUP BY u.id, u.username, u.risk_score, u.risk_tier, u.is_flagged
        ORDER BY cnt DESC
        LIMIT $2::int`,
      [from.toISOString(), safeLimit],
    );
    nodes = (r.rows as Array<{ id: string; username: string; cnt: number; risk_score: number | null; risk_tier: string | null; is_flagged: boolean }>).map((row) => ({
      id: row.id,
      username: row.username,
      metric: Number(row.cnt),
      metricLabel: `Fraud signals (30d)`,
      riskScore: row.risk_score ?? 0,
      riskTier: clampTier(row.risk_tier),
      isFlagged: row.is_flagged,
    }));
  }

  // Star-graph: every user connects to a single centre node labelled
  // with the metric + range. Lets D3-force push everyone outward.
  const centreId = `__centre_${metric}`;
  const centre: Node = {
    id: centreId,
    username: metric,
    metric: 0,
    metricLabel: 'centre',
    riskScore: 0,
    riskTier: 'safe',
    isFlagged: false,
  };
  const edges: Edge[] = nodes.map((n) => ({
    id: `e_${n.id}_${centreId}`,
    a: centreId,
    b: n.id,
    weight: 0.3 + Math.min(0.7, n.metric / Math.max(1, nodes[0]?.metric ?? 1)),
  }));

  return {
    metric,
    generatedAt: now.toISOString(),
    range: { from: from.toISOString(), to: now.toISOString() },
    nodes: [centre, ...nodes],
    edges,
  };
}

router.get('/audience-metric',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (req: Request, res: Response) => {
    try {
      const metric = String(req.query.metric ?? '') as Metric;
      if (!VALID_METRICS.includes(metric)) {
        return res.status(400).json({
          success: false,
          error: `Invalid metric. Must be one of: ${VALID_METRICS.join(', ')}`,
        });
      }
      const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50;
      const result = await runMetric(metric, limit);
      res.json({ success: true, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  },
);

// Tiny list endpoint for the panel's pill-button sub-nav (so the UI
// doesn't hardcode the list of valid metrics).
router.get('/audience-metrics-list',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor']),
  async (_req: Request, res: Response) => {
    res.json({ success: true, metrics: VALID_METRICS });
  },
);

export default router;
