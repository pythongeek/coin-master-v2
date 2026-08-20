/**
 * OpenAPI 3.1 spec for the CryptoFlip API.
 *
 * P2-07 — Two spec exports:
 *   - `publicOpenApiSpec` — served at `/api/docs` and `/api/openapi.json`.
 *     Excludes every path tagged with an admin tag so a partner
 *     integrator (or an attacker scraping the public docs) cannot
 *     enumerate operator endpoints. Admin endpoints are still REAL
 *     (gated by the secret-path gateway per P1-10) — they are just
 *     not advertised in the public spec.
 *   - `adminOpenApiSpec` — served at `/api/admin/docs` behind admin
 *     JWT authentication. Contains the FULL spec (every path + every
 *     tag) for operator reference and CI contract testing.
 *
 * Implementation
 * ───────────────
 * The single source of truth is the `rawSpec` object below. Filtering
 * is done at module-load by:
 *   1. Identifying operations whose `tags` array contains an admin
 *      tag (Admin, Admin — Withdrawals, Admin — Health, Admin — Bonuses).
 *   2. Removing those operations from the public spec's `paths`.
 *   3. Removing those tags from the public spec's `tags` array.
 *
 * The admin spec is the raw spec unchanged.
 *
 * Adding a new path that should be admin-only:
 *   1. Add the path to `rawSpec.paths` with one of the admin tags.
 *   2. Done — the path is automatically excluded from publicOpenApiSpec.
 *
 * Adding a new public path:
 *   1. Add the path to `rawSpec.paths` with a non-admin tag.
 *   2. Done.
 *
 * Adding a new admin tag:
 *   1. Add the tag to `rawSpec.tags` AND to `ADMIN_TAGS` below.
 *   2. Add a comment in `BACKEND_PROD_READINESS.md` P2-07.
 */

const PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://crazycoin.duckdns.org';

/**
 * The complete OpenAPI 3.1 spec. Source of truth for both the public
 * and admin exports. The `as const` ensures the deep type survives
 * compilation so downstream `tsc` callers see literal types.
 */
const rawSpec = {
  openapi: '3.1.0',
  info: {
    title: 'CryptoFlip API',
    version: '1.0.0',
    description:
      'HTTP API for the CryptoFlip provably-fair coin-flip platform. ' +
      'This is the operator-facing full spec. The public spec at ' +
      '`/api/openapi.json` excludes every `/api/admin/*` path.',
    contact: { name: 'CryptoFlip', url: PUBLIC_APP_URL },
    license: { name: 'Proprietary' },
  },
  servers: [
    { url: PUBLIC_APP_URL, description: 'Production' },
    { url: 'http://localhost:4000', description: 'Local dev' },
  ],
  tags: [
    { name: 'Auth', description: 'Account registration, login, 2FA' },
    { name: 'Wallet', description: 'Deposit & withdrawal flows' },
    { name: 'Game', description: 'Betting, verification, jackpot' },
    { name: 'Dashboard', description: 'User stats and history' },
    { name: 'Admin', description: 'Operator endpoints (auth + role required)' },
    { name: 'Admin — Withdrawals', description: 'Operator withdrawal queue' },
    { name: 'Admin — Health', description: 'Reconciliation and ledger alerts' },
    { name: 'Admin — Bonuses', description: 'Campaigns, claims, wagering' },
    { name: 'Public', description: 'No-auth info endpoints' },
    { name: 'Webhooks', description: 'Payment provider callbacks (no auth)' },
    { name: 'KYC', description: 'Sumsub integration' },
    { name: 'Affiliates', description: 'Referral codes, commissions' },
    { name: 'Promos', description: 'Promo codes / campaigns' },
  ],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Success: {
        type: 'object',
        required: ['success'],
        properties: { success: { type: 'boolean', example: true } },
      },
      Error: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          username: { type: 'string' },
          email: { type: 'string', nullable: true, format: 'email' },
          wallet_address: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['user', 'support', 'finance', 'auditor', 'admin', 'super_admin'] },
          is_active: { type: 'boolean' },
          is_admin: { type: 'boolean' },
          two_factor_enabled: { type: 'boolean' },
          balance: { type: 'number' },
          bonus_balance_coins: { type: 'number' },
          withdrawable_balance_coins: { type: 'number' },
        },
      },
      PlaceBetRequest: {
        type: 'object',
        required: ['amount', 'choice', 'clientSeed'],
        properties: {
          amount: { type: 'number', minimum: 0.0001 },
          choice: { type: 'string', enum: ['heads', 'tails'] },
          clientSeed: { type: 'string' },
        },
      },
      PlaceBetResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          bet: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              outcome: { type: 'string', enum: ['heads', 'tails'] },
              won: { type: 'boolean' },
              payout: { type: 'number' },
              nonce: { type: 'integer' },
              serverSeedHash: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Authenticated but role check failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Too many requests',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  paths: {
    // ─── Public ───────────────────────────────────────────────
    '/api/health': {
      get: {
        tags: ['Public'],
        summary: 'Liveness + DB + Redis check',
        responses: {
          '200': {
            description: 'All checks healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded'] },
                    service: { type: 'string' },
                    uptime: { type: 'string' },
                    checks: {
                      type: 'object',
                      properties: {
                        database: { type: 'object' },
                        redis: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
          '503': { description: 'One or more dependencies unhealthy' },
        },
      },
    },
    '/api/public/banner': {
      get: {
        tags: ['Public'],
        summary: 'Site-wide announcement banner',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
          },
        },
      },
    },

    // ─── Auth ─────────────────────────────────────────────────
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create a new account',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Email + password login',
        responses: {
          '200': { description: 'OK — returns JWT' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: '2FA setup required (admin accounts)' },
        },
      },
    },
    '/api/auth/wallet': {
      post: {
        tags: ['Auth'],
        summary: 'Sign-in with wallet signature',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user',
        security: [{ bearer: [] }],
        responses: {
          '200': { description: 'OK' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/auth/2fa/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Start 2FA enrollment (returns otpauthUrl + base64 QR)',
        security: [{ bearer: [] }],
        responses: {
          '200': {
            description: 'Setup created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    secret: { type: 'string' },
                    otpauthUrl: { type: 'string' },
                    qrDataUrl: { type: 'string', description: 'Base64 data URL PNG — server-rendered QR' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/auth/2fa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify the first TOTP code and enable 2FA',
        security: [{ bearer: [] }],
        responses: { '200': { description: '2FA enabled' } },
      },
    },
    '/api/auth/2fa/login': {
      post: {
        tags: ['Auth'],
        summary: 'Submit TOTP after login challenge',
        responses: { '200': { description: 'JWT issued' } },
      },
    },

    // ─── Game ─────────────────────────────────────────────────
    '/api/game/bet': {
      post: {
        tags: ['Game'],
        summary: 'Place a coin-flip bet',
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaceBetRequest' } } },
        },
        responses: {
          '200': {
            description: 'Bet resolved',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaceBetResponse' } } },
          },
          '400': { description: 'Invalid bet / insufficient balance' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/api/game/verify': {
      post: {
        tags: ['Game'],
        summary: 'Verify a past bet using server seed reveal',
        responses: { '200': { description: 'Outcome verified' } },
      },
    },
    '/api/game/jackpot': {
      get: { tags: ['Game'], summary: 'Live jackpot amount', responses: { '200': { description: 'OK' } } },
    },
    '/api/game/seed': {
      get: { tags: ['Game'], summary: 'Current provably-fair seed hash', responses: { '200': { description: 'OK' } } },
    },
    '/api/game/history/{userId}': {
      get: {
        tags: ['Game'],
        summary: 'User bet history (auth required; owner only)',
        security: [{ bearer: [] }],
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/game/config': {
      get: { tags: ['Game'], summary: 'House edge / min/max bet / payout tables', responses: { '200': { description: 'OK' } } },
    },

    // ─── Dashboard ────────────────────────────────────────────
    '/api/dashboard/stats/{userId}': {
      get: {
        tags: ['Dashboard'],
        summary: 'User aggregate stats',
        security: [{ bearer: [] }],
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/dashboard/chart/{userId}': {
      get: {
        tags: ['Dashboard'],
        summary: 'Daily P&L chart points',
        security: [{ bearer: [] }],
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/dashboard/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'List users with search + pagination',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/api/dashboard/admin/users/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Freeze/unfreeze a user or adjust balance',
        security: [{ bearer: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/api/dashboard/admin/live': {
      get: {
        tags: ['Admin'],
        summary: 'Platform-wide live counters (cached 10s)',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ─── Admin — Withdrawals ──────────────────────────────────
    '/api/admin/withdrawals': {
      get: {
        tags: ['Admin — Withdrawals'],
        summary: 'List withdrawal requests (filter by status)',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/withdrawals/stats': {
      get: {
        tags: ['Admin — Withdrawals'],
        summary: 'Aggregate withdrawal counters',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/withdrawals/{id}/approve': {
      post: {
        tags: ['Admin — Withdrawals'],
        summary: 'Approve a pending withdrawal',
        security: [{ bearer: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Approved' } },
      },
    },
    '/api/admin/withdrawals/{id}/reject': {
      post: {
        tags: ['Admin — Withdrawals'],
        summary: 'Reject a pending withdrawal and refund',
        security: [{ bearer: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Rejected' } },
      },
    },

    // ─── Admin — Health / Audit / Fraud ───────────────────────
    '/api/admin/health': {
      get: {
        tags: ['Admin — Health'],
        summary: 'Postgres / Redis / RPC / reconciliation summary',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/audit-logs': {
      get: {
        tags: ['Admin'],
        summary: 'Audit log feed',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/fraud-logs': {
      get: {
        tags: ['Admin'],
        summary: 'Fraud signal feed',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/change-password': {
      post: {
        tags: ['Admin'],
        summary: 'Self-service password change',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'Password updated' }, '401': { description: 'Wrong current password' } },
      },
    },
    '/api/admin/2fa/status': {
      get: {
        tags: ['Admin'],
        summary: 'Check whether the calling admin has 2FA enabled',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/seed/rotate': {
      post: {
        tags: ['Admin'],
        summary: 'Manually rotate the provably-fair server seed (step-up password)',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'Rotated' }, '401': { description: 'Bad password' } },
      },
    },

    // ─── Wallet ───────────────────────────────────────────────
    '/api/wallet/balances': {
      get: {
        tags: ['Wallet'],
        summary: 'All balance columns for the current user',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/wallet/transactions': {
      get: {
        tags: ['Wallet'],
        summary: 'Recent wallet transactions',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/payment/create': {
      post: {
        tags: ['Wallet'],
        summary: 'Create a deposit order (Binance Pay / RedotPay)',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/payment/orders': {
      get: {
        tags: ['Wallet'],
        summary: 'List the current user’s deposit orders',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ─── Bonuses / Promos ─────────────────────────────────────
    '/api/bonus/active': {
      get: { tags: ['Admin — Bonuses'], summary: 'Active bonus campaigns', security: [{ bearer: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/api/bonus/claim': {
      post: { tags: ['Admin — Bonuses'], summary: 'Claim a campaign bonus', security: [{ bearer: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/api/promo/validate': {
      post: { tags: ['Promos'], summary: 'Validate a promo code', responses: { '200': { description: 'OK' } } },
    },
    '/api/leaderboard': {
      get: { tags: ['Dashboard'], summary: 'Top users by wagered / net profit', responses: { '200': { description: 'OK' } } },
    },

    // ─── KYC ──────────────────────────────────────────────────
    '/api/kyc/status': {
      get: {
        tags: ['KYC'],
        summary: 'Current user KYC status',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/kyc/token': {
      post: {
        tags: ['KYC'],
        summary: 'Issue a Sumsub access token',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/kyc/admin/list': {
      get: {
        tags: ['Admin'],
        summary: 'List pending KYC submissions (admin)',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ─── Affiliates ───────────────────────────────────────────
    '/api/affiliate': {
      get: {
        tags: ['Affiliates'],
        summary: 'Current user referral stats',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/affiliate/claim': {
      post: {
        tags: ['Affiliates'],
        summary: 'Claim accrued referral commissions',
        security: [{ bearer: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ─── Webhooks ─────────────────────────────────────────────
    '/api/webhooks/binance': {
      post: { tags: ['Webhooks'], summary: 'Binance Pay callback (signed)', responses: { '200': { description: 'OK' } } },
    },
    '/api/webhooks/redot': {
      post: { tags: ['Webhooks'], summary: 'RedotPay callback (signed)', responses: { '200': { description: 'OK' } } },
    },
  },
} as const;

/**
 * Tags whose operations are filtered out of the public spec.
 * Adding a new admin tag requires both this list AND the `tags`
 * entry in `rawSpec` to be updated.
 */
export const ADMIN_TAGS: ReadonlyArray<string> = [
  'Admin',
  'Admin — Withdrawals',
  'Admin — Health',
  'Admin — Bonuses',
];

const ADMIN_TAGS_SET: Set<string> = new Set(ADMIN_TAGS);

/**
 * Helper: does an operation object (e.g. rawSpec.paths['/x'].get) have
 * any admin tag?
 */
function isAdminOperation(op: any): boolean {
  if (!op || typeof op !== 'object') return false;
  const tags = op.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => ADMIN_TAGS_SET.has(t));
}

/**
 * Build the public OpenAPI spec by filtering out admin paths and
 * admin tags. Used at module-load time. The deep clone via JSON
 * round-trip is intentional: we MUST NOT mutate `rawSpec` (the
 * `adminOpenApiSpec` export shares it).
 */
function buildPublicSpec(): any {
  const spec = JSON.parse(JSON.stringify(rawSpec));

  // Filter out admin paths.
  for (const path of Object.keys(spec.paths)) {
    const pathObj = spec.paths[path];
    if (!pathObj || typeof pathObj !== 'object') continue;
    for (const method of Object.keys(pathObj)) {
      // Standard OpenAPI methods.
      if (
        method === 'get' ||
        method === 'post' ||
        method === 'put' ||
        method === 'patch' ||
        method === 'delete' ||
        method === 'head' ||
        method === 'options'
      ) {
        if (isAdminOperation(pathObj[method])) {
          delete pathObj[method];
        }
      }
    }
    // If the path has no methods left, drop the path entirely.
    if (Object.keys(pathObj).length === 0) {
      delete spec.paths[path];
    }
  }

  // Filter out admin tags.
  if (Array.isArray(spec.tags)) {
    spec.tags = spec.tags.filter(
      (t: { name?: string }) => !t.name || !ADMIN_TAGS_SET.has(t.name),
    );
  }

  // Update the info.description to reflect the public subset.
  spec.info = {
    ...spec.info,
    description:
      'Public HTTP API for the CryptoFlip provably-fair coin-flip platform. ' +
      'This is the PARTNER-FACING public spec — admin endpoints are ' +
      'intentionally excluded. Operators can see the full spec at ' +
      '`/api/admin/docs` (JWT-gated). All mutations are rate-limited.',
  };

  return spec;
}

/**
 * Public spec — served at `/api/docs` and `/api/openapi.json`.
 * Excludes every path tagged with an admin tag.
 */
export const publicOpenApiSpec = buildPublicSpec();

/**
 * Admin spec — served at `/api/admin/docs` behind admin JWT
 * authentication. Contains every path and every tag.
 */
export const adminOpenApiSpec = JSON.parse(JSON.stringify(rawSpec));

/**
 * @deprecated Use `publicOpenApiSpec` for the public endpoint and
 * `adminOpenApiSpec` for the admin endpoint. The single-spec
 * `openApiSpec` export is kept for backward compatibility with the
 * existing /api/docs mount; it is the public subset.
 */
export const openApiSpec = publicOpenApiSpec;

/**
 * Helper exposed for tests: how many admin paths are filtered out?
 * Used by the test in `backend/src/test/openapi-filter.test.ts` to
 * verify the public spec excludes every admin-tagged path.
 */
export function isAdminPath(path: string): boolean {
  const pathObj = (rawSpec.paths as any)[path];
  if (!pathObj) return false;
  return Object.values(pathObj).some((op: any) => isAdminOperation(op));
}
