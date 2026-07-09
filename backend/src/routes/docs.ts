/**
 * Swagger UI + OpenAPI JSON route.
 *
 * Mounts at /api/docs (UI) and /api/openapi.json (raw spec).
 * Public — no auth required — because we want external integrators
 * to read the docs without a JWT.
 */

import { Router, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../config/openapi';

const router = Router();

router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

router.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'CryptoFlip API',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: { persistAuthorization: true },
  }),
);

export { router as docsRoutes };
export default router;