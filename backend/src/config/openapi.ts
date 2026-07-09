/**
 * OpenAPI 3.1 spec for the CryptoFlip public API.
 *
 * The spec is intentionally hand-curated and grouped by route file so
 * any future endpoint addition is obvious. `swagger-ui-express` reads
 * the JSON and renders the docs at /api/docs.
 */

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'CryptoFlip API',
    version: '1.0.0',
    description:
      'Public HTTP API for the CryptoFlip provably-fair coin-flip platform. ' +
      'All `/api/admin/*` and `/api/admin/withdrawals/*` routes require an ' +
      'authenticated user with the matching admin role and 2FA enabled. ' +
      'Most mutations are rate-limited (see per-route headers).',
    contact: { name: 'CryptoFlip', url: 'https://crazycoin.duckdns.org' },
    license: { name: 'Proprietary' },
  },
  servers: [
    { url: 'https://crazycoin.duckdns.org', description: 'Production' },
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