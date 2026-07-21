/**
 * P3-6 — Admin endpoints for the Behavioral Cohort Comparison.
 *
 *   GET  /api/admin/cohorts/overview
 *     List of cohort keys with size + last-computed-at. Top of the panel.
 *
 *   GET  /api/admin/cohorts/:cohort_key/stats
 *     Full stats table for one cohort (5 metrics × mean/stddev/p50/p95/n).
 *
 *   GET  /api/admin/cohorts/outliers?severity=&cohort_key=&limit=
 *     Recent outliers across all cohorts. Filterable by severity + cohort.
 *
 *   POST /api/admin/cohorts/run-now
 *     Force-trigger the weekly analysis (same code path the cron uses).
 *
 *   GET  /api/admin/cohorts/settings
 *     Read current admin_settings for the cron.
 *
 * Auth: authMiddleware + roleMiddleware(['super_admin']) on every
 * endpoint, matches the canonical /api/admin pattern.
 *
 * Path convention: this router is mounted at /api/admin/cohorts,
 * so the route paths below should NOT include the /cohorts prefix.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { query } from '../config/database';
import { getAdminSetting } from '../services/admin-settings.service';
import {
  listCohortKeys,
  listRecentOutliers,
  runWeeklyCohortAnalysis,
} from '../services/cohort-analysis';

const router = Router();
router.use(authMiddleware, roleMiddleware(['super_admin']));

// ── GET /overview ──────────────────────────────────────
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const cohorts = await listCohortKeys();
    const stats = (await query(
      `SELECT cohort_key, MAX(computed_at)::text AS last_computed_at
         FROM behavioral_cohort_stats
        GROUP BY cohort_key`,
    )).rows as Array<{ cohort_key: string; last_computed_at: string }>;
    const lastByCohort = new Map(stats.map((s) => [s.cohort_key, s.last_computed_at]));
    const totalOutliers = (await query(
      `SELECT COUNT(*)::int AS n FROM behavioral_cohort_outliers`,
    )).rows[0] as { n: number };
    const enabled = await getAdminSetting('cohort_analysis_enabled', 'true');
    res.json({
      success: true,
      data: {
        cohorts: cohorts.map((c) => ({
          cohort_key: c.cohort_key,
          size: c.size,
          last_computed_at: lastByCohort.get(c.cohort_key) ?? null,
        })),
        total_cohorts: cohorts.length,
        total_outliers: totalOutliers.n,
        enabled: enabled === 'true',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /:cohort_key/stats ────────────────────────────
router.get('/:cohort_key/stats', async (req: Request, res: Response) => {
  try {
    const ck = String(req.params.cohort_key);
    const r = (await query(
      `SELECT metric, mean_value, stddev_value, p50_value, p95_value, n_samples, computed_at::text AS computed_at
         FROM behavioral_cohort_stats
        WHERE cohort_key = $1
        ORDER BY metric ASC`,
      [ck],
    )).rows;
    const size = (await query(
      `SELECT COUNT(*)::int AS n FROM behavioral_cohort_assignments WHERE cohort_key = $1`,
      [ck],
    )).rows[0] as { n: number };
    res.json({ success: true, data: { cohort_key: ck, cohort_size: size.n, metrics: r } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /outliers ─────────────────────────────────────
router.get('/outliers', async (req: Request, res: Response) => {
  try {
    const sev = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const ck = typeof req.query.cohort_key === 'string' ? req.query.cohort_key : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const data = await listRecentOutliers({ severity: sev, cohort_key: ck, limit });
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── POST /run-now ─────────────────────────────────────
router.post('/run-now', async (_req: Request, res: Response) => {
  try {
    const result = await runWeeklyCohortAnalysis();
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /settings ─────────────────────────────────────
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT key, value, description FROM admin_settings
        WHERE key IN (
          'cohort_analysis_enabled',
          'cohort_analysis_z_threshold',
          'cohort_analysis_lookback_days',
          'cohort_analysis_send_hour_utc'
        )`,
    );
    const data = r.rows.reduce<Record<string, string>>((acc, row) => {
      const r2 = row as { key: string; value: string };
      acc[r2.key] = r2.value;
      return acc;
    }, {});
    res.json({ success: true, data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;