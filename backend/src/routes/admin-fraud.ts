/**
 * Phase 1.7 — Admin fraud panel APIs.
 *
 * Endpoints powering AdminFraudPanel.tsx:
 *   GET /api/admin/fraud/live-feed           — top N users by risk score
 *   GET /api/admin/fraud/clusters             — all fraud clusters (newest first)
 *   GET /api/admin/fraud/clusters/:id        — one cluster detail
 *   GET /api/admin/fraud/alerts              — recent fraud_alerts (last 24h)
 *   GET /api/admin/fraud/alerts/:id          — one alert
 *   GET /api/admin/fraud/users/:userId/risk-profile
 *                                            — deep-dive risk breakdown
 *                                            (full bonus audit + risk history
 *                                            + devices + cluster membership)
 *
 * Auth: adminLimiter + authMiddleware + super_admin/finance/auditor roles.
 * Read-only — no mutations here. (Mutations live in admin.ts and
 * admin-bonus.ts already.)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';

const router = Router();

// ── Live risk feed (top N by score) ────────────────────────────
router.get(
  '/fraud/live-feed',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const limit = Math.min(parseInt((req.query.limit as string) || '50'), 200);
      const tier = String(req.query.tier || '').trim();

      const params: unknown[] = [];
      const where: string[] = [];
      if (tier && tier !== 'all') {
        params.push(tier);
        where.push(`u.risk_tier = $${params.length}::text`);
      }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const r = await query(
        `SELECT u.id, u.username, u.email, u.is_flagged,
                u.risk_score, u.risk_tier, u.created_at,
                u.bonus_balance_coins, u.withdrawable_balance_coins,
                u.kyc_status, u.device_count,
                urs.score_breakdown, urs.last_calculated
           FROM users u
           LEFT JOIN user_risk_scores urs ON urs.user_id = u.id
           ${whereClause}
          ORDER BY u.risk_score DESC, u.risk_tier DESC
          LIMIT ${limit}`,
        params,
      );

      // Also compute tier counts for the panel summary chips.
      const counts = await query(
        `SELECT risk_tier, count(*)::int AS n
           FROM users
          WHERE risk_tier IS NOT NULL
          GROUP BY risk_tier`,
      );
      const tierCounts: Record<string, number> = {
        critical: 0, high_risk: 0, medium_risk: 0, low_risk: 0, safe: 0,
      };
      for (const row of counts.rows as Array<{ risk_tier: string; n: number }>) {
        tierCounts[row.risk_tier] = row.n;
      }

      res.json({
        success: true,
        users: r.rows,
        tierCounts,
        total: r.rows.length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── List fraud clusters ───────────────────────────────────────
router.get(
  '/fraud/clusters',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const limit = Math.min(parseInt((req.query.limit as string) || '50'), 200);
      const status = String(req.query.status || 'pending');

      const params: unknown[] = [];
      let where = '';
      if (status !== 'all') {
        params.push(status);
        where = `WHERE status = $${params.length}::text`;
      }

      const r = await query(
        `SELECT id, cluster_label, member_user_ids, signal_types,
                total_strength, member_count, detected_at, status
           FROM fraud_clusters
           ${where}
          ORDER BY detected_at DESC
          LIMIT ${limit}`,
        params,
      );
      res.json({ success: true, clusters: r.rows, total: r.rows.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Single cluster (members + usernames) ───────────────────────
router.get(
  '/fraud/clusters/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const id = String(req.params.id);
      const r = await query(
        `SELECT id, cluster_label, member_user_ids, signal_types,
                total_strength, member_count, detected_at, status,
                admin_notes, resolved_at
           FROM fraud_clusters
          WHERE id = $1::uuid`,
        [id],
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Cluster not found' });
      }
      // Hydrate member usernames for the admin view.
      const cluster = r.rows[0] as { member_user_ids: string[] };
      const memberRows = await query(
        `SELECT id, username, email, is_flagged, risk_score, risk_tier,
                created_at, registration_ip
           FROM users
          WHERE id = ANY($1::uuid[])`,
        [cluster.member_user_ids],
      );
      res.json({
        success: true,
        cluster: { ...cluster, members: memberRows.rows },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Recent alerts (default last 24h) ───────────────────────────
router.get(
  '/fraud/alerts',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const limit = Math.min(parseInt((req.query.limit as string) || '100'), 500);
      const hours = Math.min(parseInt((req.query.hours as string) || '24'), 168);
      const severity = String(req.query.severity || '').trim();

      const params: unknown[] = [hours];
      const conds: string[] = [`created_at > NOW() - ($1::int || ' hours')::interval`];
      if (severity && severity !== 'all') {
        params.push(severity);
        conds.push(`severity = $${params.length}::text`);
      }

      const r = await query(
        `SELECT id, alert_type, severity, title, body, affected_user_ids,
                risk_score, signals, channels_sent, delivery,
                recommended_action, admin_link, created_at
           FROM fraud_alerts
          WHERE ${conds.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ${limit}`,
        params,
      );

      // Severity counts for chips.
      const counts = await query(
        `SELECT severity, count(*)::int AS n
           FROM fraud_alerts
          WHERE created_at > NOW() - ($1::int || ' hours')::interval
          GROUP BY severity`,
        [hours],
      );
      const severityCounts: Record<string, number> = {
        critical: 0, high: 0, medium: 0, info: 0,
      };
      for (const row of counts.rows as Array<{ severity: string; n: number }>) {
        severityCounts[row.severity] = row.n;
      }

      res.json({
        success: true,
        alerts: r.rows,
        severityCounts,
        total: r.rows.length,
        windowHours: hours,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Single alert (for drill-in) ────────────────────────────────
router.get(
  '/fraud/alerts/:id',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const id = String(req.params.id);
      const r = await query(
        `SELECT id, alert_type, severity, title, body, affected_user_ids,
                risk_score, signals, channels_sent, delivery,
                recommended_action, admin_link, created_at
           FROM fraud_alerts WHERE id = $1::uuid`,
        [id],
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Alert not found' });
      }
      res.json({ success: true, alert: r.rows[0] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// ── Per-user risk profile (full audit + risk history) ─────────
router.get(
  '/fraud/users/:userId/risk-profile',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const userId = String(req.params.userId);

      // 1. Current user state + latest risk breakdown.
      const userRow = await query(
        `SELECT id, username, email, created_at, is_flagged,
                risk_score, risk_tier,
                bonus_balance_coins, withdrawable_balance_coins,
                wagering_required_coins, wagering_completed_coins,
                kyc_status, kyc_country, self_excluded_until, device_count
           FROM users WHERE id = $1::uuid`,
        [userId],
      );
      if (userRow.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // 2. Risk score history (last 10).
      const history = await query(
        `SELECT history FROM user_risk_scores WHERE user_id = $1::uuid`,
        [userId],
      );
      let riskHistory: unknown = [];
      if (history.rows.length > 0) {
        const h = (history.rows[0] as { history: unknown }).history;
        if (Array.isArray(h)) riskHistory = h.slice(-10);
      }

      // 3. Fraud signals (last 90 days).
      const signals = await query(
        `SELECT id, signal_type, severity, status, detected_at, resolved_at, metadata
           FROM fraud_signals
          WHERE user_id = $1::uuid
            AND detected_at > NOW() - INTERVAL '90 days'
          ORDER BY detected_at DESC`,
        [userId],
      );

      // 4. Devices this user has touched.
      const { getDevicesForUser } = await import('../services/device-fingerprint');
      const devices = await getDevicesForUser(userId);

      // 5. Cluster membership.
      const { getClustersForUser } = await import('../services/graph-fraud');
      const clusters = await getClustersForUser(userId);

      // 6. Bonus claims.
      const claims = await query(
        `SELECT id, bonus_type, amount_coins, wagering_required,
                max_withdrawal_allowed, expires_at, claimed_at, completed_at,
                status, metadata
           FROM bonus_claims
          WHERE user_id = $1::uuid
          ORDER BY claimed_at DESC`,
        [userId],
      );

      // 7. Recent withdrawals.
      const withdrawals = await query(
        `SELECT id, amount, status, created_at
           FROM transactions
          WHERE user_id = $1::uuid AND type = 'withdrawal'
          ORDER BY created_at DESC LIMIT 20`,
        [userId],
      );

      res.json({
        success: true,
        user: userRow.rows[0],
        riskHistory,
        signals: signals.rows,
        devices,
        clusters,
        claims: claims.rows,
        withdrawals: withdrawals.rows,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

// Phase 2.5 — full node+edge graph for a fraud cluster (D3-style visualization)
router.get(
  '/fraud/clusters/:id/graph',
  adminLimiter,
  authMiddleware,
  roleMiddleware(['super_admin', 'finance', 'auditor', 'support']),
  async (req: Request, res: Response) => {
    try {
      const { query } = await import('../config/database');
      const { buildClusterGraph } = await import('../services/graph-fraud');
      const id = String(req.params.id);
      const r = await query(
        `SELECT member_user_ids FROM fraud_clusters WHERE id = $1::uuid`,
        [id],
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Cluster not found' });
      }
      const members = (r.rows[0] as { member_user_ids: string[] }).member_user_ids || [];
      const graph = await buildClusterGraph(members);
      res.json({ success: true, clusterId: id, graph });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  },
);

export default router;