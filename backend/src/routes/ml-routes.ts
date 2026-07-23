import { NextFunction } from 'express';
/**
 * Phase 3 / P3-1d — Admin ML endpoints.
 *
 *  GET    /admin/ml/models              list all versions + active marker
 *  POST   /admin/ml/models              upload new model row (metrics + paths)
 *                                        (the actual ONNX file upload lives at
 *                                        /admin/ml/models/:id/file when admin
 *                                        hits it from the panel; for the
 *                                        Free-Tier Kaggle/Colab workflow the
 *                                        admin pre-stages the file at a known
 *                                        path on disk via docker cp)
 *  POST   /admin/ml/models/:id/activate  promote a model to status='active'
 *  POST   /admin/ml/models/:id/rollback retire + auto-promote previous
 *  GET    /admin/ml/predictions         recent predictions (paginated + user)
 *  GET    /admin/ml/jobs                training job history
 *  POST   /admin/ml/train               record a training request (offline)
 *
 * All endpoints require super_admin.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { query } from '../config/database';
import { setAdminSetting } from '../services/admin-settings.service';
import { clearModelCache } from '../services/ml-pipeline';

const router = Router();

const AuthReq = (req: Request): string | null =>
  (req as Request & { user?: { userId?: string } }).user?.userId ?? null;

const logJob = async (modelId: string | null, event: string,
                     actorId: string | null, payload: unknown, notes?: string) => {
  await query(
    `INSERT INTO ml_training_jobs (model_id, event, actor_user_id, payload, notes)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5)`,
    [modelId, event, actorId, JSON.stringify(payload ?? {}), notes ?? null],
  );
};

// 1. list models
router.get('/models', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin']), async (_req, res, next: NextFunction) => {
    try {
      const r = await query(
        `SELECT m.id, m.name, m.version, m.provider, m.status,
                m.training_metrics, m.feature_importance, m.feature_columns,
                m.file_path, m.activated_at, m.activated_by, m.created_at,
                u.username AS activated_by_username,
                c.username AS created_by_username
           FROM ml_models m
           LEFT JOIN users u ON u.id = m.activated_by
           LEFT JOIN users c ON c.id = m.created_by
          ORDER BY m.created_at DESC`,
      );
      const active = (r.rows as Array<{ id: string; status: string }>).find((m) => m.status === 'active');
      res.json({ success: true, models: r.rows, activeModelId: active?.id ?? null });
    } catch (err: unknown) { next(err);
    }
  });

// 2. register a new model row (admin hands us the metadata + on-disk path)
router.post('/models', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = AuthReq(req);
      const body = req.body as {
        name?: string; version?: string; provider?: 'onnx' | 'mock';
        filePath?: string; featureImportance?: Array<{ name: string; gain: number }>;
        trainingMetrics?: Record<string, number>; featureColumns?: string[];
        notes?: string;
      };
      if (!body.name || !body.version) {
        return res.status(400).json({ success: false, error: 'name + version required' });
      }
      const r = await query(
        `INSERT INTO ml_models
           (name, version, provider, file_path, status, feature_importance,
            training_metrics, feature_columns, notes, created_by)
         VALUES ($1, $2, $3, $4, 'uploaded', $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::uuid)
         RETURNING id`,
        [
          body.name, body.version,
          body.provider === 'onnx' ? 'onnx' : 'mock',
          body.filePath ?? null,
          JSON.stringify(body.featureImportance ?? []),
          JSON.stringify(body.trainingMetrics ?? {}),
          JSON.stringify(body.featureColumns ?? []),
          body.notes ?? null,
          actor,
        ],
      );
      const id = String((r.rows[0] as { id: string }).id);
      await logJob(id, 'upload_completed', actor, {
        name: body.name, version: body.version, provider: body.provider ?? 'mock',
      }, body.notes);
      res.json({ success: true, id, name: body.name, version: body.version });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate')) {
        return res.status(409).json({ success: false, error: 'name+version already exists' });
      }
      next(err);
    }
  });

// 3. activate
router.post('/models/:id/activate', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = AuthReq(req);
      const id = String(req.params.id);
      const found = await query(`SELECT name, version, provider FROM ml_models WHERE id=$1::uuid`, [id]);
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'model not found' });
      // Demote any current active.
      await query(`UPDATE ml_models SET status='retired' WHERE status='active'`);
      await query(
        `UPDATE ml_models SET status='active', activated_at=NOW(), activated_by=$2::uuid
          WHERE id=$1::uuid`, [id, actor]);
      const row = found.rows[0] as { name: string; version: string; provider: string };
      await setAdminSetting('ml_active_model_id', id);
      await setAdminSetting('ml_provider', row.provider === 'onnx' ? 'onnx' : 'mock');
      await clearModelCache();
      await logJob(id, 'activated', actor, { name: row.name, version: row.version });
      res.json({ success: true, activeModelId: id });
    } catch (err: unknown) { next(err);
    }
  });

// 4. rollback — retire current active, promote latest uploaded.
router.post('/models/:id/rollback', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = AuthReq(req);
      const id = String(req.params.id);
      const target = await query(`SELECT id FROM ml_models WHERE id=$1::uuid`, [id]);
      if (!target.rows.length) return res.status(404).json({ success: false, error: 'model not found' });
      await query(`UPDATE ml_models SET status='retired' WHERE id=$1::uuid`, [id]);
      // Promote most recent non-retired if any
      const cur = await query(
        `SELECT id FROM ml_models WHERE status IN ('uploaded','training') ORDER BY created_at DESC LIMIT 1`);
      if (cur.rows.length) {
        const promoteId = String((cur.rows[0] as { id: string }).id);
        await query(
          `UPDATE ml_models SET status='active', activated_at=NOW(), activated_by=$2::uuid
            WHERE id=$1::uuid`, [promoteId, actor]);
        await setAdminSetting('ml_active_model_id', promoteId);
        await clearModelCache();
      } else {
        await query(`UPDATE admin_settings SET value='' WHERE key='ml_active_model_id'`);
      }
      await logJob(id, 'rolled_back', actor, {});
      res.json({ success: true, rolledBackFrom: id });
    } catch (err: unknown) { next(err);
    }
  });

// 5. predictions
router.get('/predictions', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin', 'auditor']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.query.userId ? String(req.query.userId) : null;
      const limit = Math.min(200, Number(req.query.limit ?? 50));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      const r = userId
        ? await query(
            `SELECT id, user_id, model_id, source, ml_prob, rule_score,
                    blended_score, threshold, predicted_fraud, flag_action, created_at
               FROM ml_predictions
              WHERE user_id=$1::uuid
              ORDER BY created_at DESC LIMIT $2::int OFFSET $3::int`,
            [userId, limit, offset])
        : await query(
            `SELECT id, user_id, model_id, source, ml_prob, rule_score,
                    blended_score, threshold, predicted_fraud, flag_action, created_at
               FROM ml_predictions
              ORDER BY created_at DESC LIMIT $1::int OFFSET $2::int`,
            [limit, offset]);
      const total = (await query(`SELECT count(*)::int AS n FROM ml_predictions${userId ? ` WHERE user_id=$1::uuid` : ''}`,
        userId ? [userId] : [])).rows[0] as { n: number };
      res.json({ success: true, predictions: r.rows, total: total.n, limit, offset });
    } catch (err: unknown) { next(err);
    }
  });

// 6. jobs
router.get('/jobs', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin', 'auditor']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(200, Number(req.query.limit ?? 50));
      const r = await query(
        `SELECT j.id, j.model_id, j.event, j.actor_user_id, j.payload, j.notes, j.created_at,
                u.username AS actor_username, m.name AS model_name, m.version AS model_version
           FROM ml_training_jobs j
           LEFT JOIN users u ON u.id = j.actor_user_id
           LEFT JOIN ml_models m ON m.id = j.model_id
          ORDER BY j.created_at DESC LIMIT $1::int`, [limit]);
      res.json({ success: true, jobs: r.rows });
    } catch (err: unknown) { next(err);
    }
  });

// 7. record a train request
router.post('/train', adminLimiter, authMiddleware,
  roleMiddleware(['super_admin']), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = AuthReq(req);
      const body = req.body as { notes?: string; fromPeriod?: string; toPeriod?: string };
      // Insert a `training`-status row as the placeholder model.
      const r = await query(
        `INSERT INTO ml_models (name, version, provider, status, notes, training_metrics, created_by)
         VALUES ($1, $2, 'mock', 'training', $3, jsonb_build_object('requested_at', NOW()), $4::uuid)
         RETURNING id`,
        [
          'xgboost_pending',
          `req-${Date.now()}`,
          body.notes ?? `train request from ${actor ?? 'admin'}; period ${body.fromPeriod ?? '?'}..${body.toPeriod ?? '?'}`,
          actor,
        ],
      );
      const id = String((r.rows[0] as { id: string }).id);
      await logJob(id, 'train_requested', actor, body);
      res.json({ success: true, modelId: id, notes: 'Admin must run the notebook then POST to /admin/ml/models with file path + metrics.' });
    } catch (err: unknown) { next(err);
    }
  });

export default router;
