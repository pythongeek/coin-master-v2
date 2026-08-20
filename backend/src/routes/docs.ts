/**
 * Swagger UI + OpenAPI JSON routes.
 *
 * P2-07 — Two mounts:
 *   - `/api/docs` + `/api/openapi.json` — PUBLIC spec (admin
 *     endpoints filtered out). No auth required.
 *   - `/api/admin/docs` + `/api/admin/openapi.json` — ADMIN spec
 *     (every path + every tag). Behind admin JWT (authMiddleware +
 *     adminMiddleware).
 *
 * Both specs are generated from the same source-of-truth in
 * `../config/openapi.ts` (the `rawSpec` object). The public spec is
 * derived by filtering operations tagged with an admin tag.
 */

import { Router, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import {
  publicOpenApiSpec,
  adminOpenApiSpec,
} from '../config/openapi';
import {
  authMiddleware,
  adminMiddleware,
} from '../middleware/auth';

const router = Router();

// ── Public endpoints (no auth) ────────────────────────────────

/**
 * `GET /api/openapi.json` — public spec.
 * Returns the OpenAPI 3.1 JSON for partner integrations. Every
 * admin-tagged path is filtered out (see P2-07).
 */
router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(publicOpenApiSpec);
});

/**
 * `GET /api/docs` — Swagger UI for the public spec.
 * The UI is rendered from `publicOpenApiSpec`. Partner integrators
 * should bookmark this URL.
 */
router.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(publicOpenApiSpec, {
    customSiteTitle: 'CryptoFlip API (Public)',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: { persistAuthorization: true },
  }),
);

/**
 * P2-07 — Admin spec endpoints.
 *
 * `GET /api/admin/openapi.json` — full spec (admin JWT required).
 * `GET /api/admin/docs` — Swagger UI for the full spec.
 *
 * Both endpoints are gated by `authMiddleware` (verifies a valid JWT)
 * followed by `adminMiddleware` (requires `isAdmin: true` in the JWT
 * payload). Operators visiting these endpoints in a browser should
 * first hit `/api/auth/login` to obtain a token, then paste it into
 * the "Authorize" dialog at the top of the Swagger UI.
 *
 * The middleware is applied per-route via `router.get(path, ...mw,
 * handler)` rather than `router.use(path, ...mw)` so that future
 * non-admin endpoints mounted at `/api/admin/*` (e.g. `/api/admin/
 * public` for the legitimately-public banner after P1-10) are not
 * affected.
 */
router.get('/admin/openapi.json', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  res.json(adminOpenApiSpec);
});

router.use(
  '/admin/docs',
  authMiddleware,
  adminMiddleware,
  swaggerUi.serve,
  swaggerUi.setup(adminOpenApiSpec, {
    customSiteTitle: 'CryptoFlip API (Admin — JWT required)',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: { persistAuthorization: true },
  }),
);

export { router as docsRoutes };
export default router;