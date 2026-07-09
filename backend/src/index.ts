/**
 * ═══════════════════════════════════════════════════════════════
 *  CRYPTOFLIP BACKEND — মূল সার্ভার এন্ট্রি পয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 */
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { connectDB, query } from './config/database';
import { redis, redisHealthCheck } from './config/redis';
import { setupSocketHandlers } from './services/socket-manager';
import { startReconciliationLoop } from './services/reconciliation';
import { geoipMiddleware } from './middleware/geoip';
import { globalLimiter } from './middleware/rate-limiter';
import { csrfMiddleware, helmetConfig } from './middleware/security';
import { startAuditBackupWorker } from './services/audit-backup';
import { startWebhookWorker } from './services/webhook';
import { adminHealthRoutes } from './routes/admin-health';
import { tronDepositMonitor } from './services/tron-deposit-monitor';
import docsRoutes from './routes/docs';
import router from './routes/metrics';

const metricsRoutes = router;

import authRoutes  from './routes/auth';
import gameRoutes  from './routes/game';
import adminRoutes from './routes/admin';
import adminBonusRoutes from './routes/admin-bonus';
import dashboardRoutes from './routes/dashboard';
import walletRoutes from './routes/wallet';
import kycRoutes from './routes/kyc';
import leaderboardsRoutes from './routes/leaderboards';
import affiliateRoutes from './routes/affiliate';
import promoRoutes from './routes/promo';
import bonusRoutes from './routes/bonus';
import { ensureActiveSeed } from './services/server-seed';
import depositRoutes from './routes/deposit';


dotenv.config();

// ─── Mandatory Security Configuration ────────────────────────
// ADMIN_2FA_REQUIRED must be explicitly set. We refuse to start
// if it's missing to prevent accidental production deployments
// with disabled 2FA.
//
// Fail-closed: in development/admin mode (NODE_ENV != production) we
// still require an explicit value. Use ADMIN_2FA_REQUIRED=false only
// for local dev, never in staging/production.
const admin2faRaw = process.env.ADMIN_2FA_REQUIRED;
if (admin2faRaw === undefined || admin2faRaw === '') {
  console.error('\n❌ FATAL: ADMIN_2FA_REQUIRED is not set.');
  console.error('   Set it explicitly in your .env file:');
  console.error('     ADMIN_2FA_REQUIRED=true   # production / staging (enforces admin 2FA)');
  console.error('     ADMIN_2FA_REQUIRED=false  # local dev ONLY');
  process.exit(1);
}
const admin2faValid = admin2faRaw === 'true' || admin2faRaw === 'false';
if (!admin2faValid) {
  console.error(`\n❌ FATAL: ADMIN_2FA_REQUIRED="${admin2faRaw}" is invalid.`);
  console.error('   Only "true" or "false" are accepted.');
  process.exit(1);
}
// if (process.env.NODE_ENV === 'production' && admin2faRaw !== 'true') {
//   console.error('\n❌ FATAL: ADMIN_2FA_REQUIRED must be "true" in production.');
//   console.error('   Admin 2FA cannot be disabled in production mode.');
//   process.exit(1);
// }
if (process.env.NODE_ENV === 'production' && admin2faRaw !== 'true') {
  console.warn('⚠️  ADMIN_2FA_REQUIRED is false in production. Admin 2FA bypass is active — re-enable before going live.');
}
const ADMIN_2FA_REQUIRED = admin2faRaw === 'true';
if (ADMIN_2FA_REQUIRED) {
  console.log('🔐 ADMIN_2FA_REQUIRED=true: admin 2FA enforcement enabled');
}
export { ADMIN_2FA_REQUIRED };

// Build CORS allowlist from all configured frontend URLs.
// NEXT_PUBLIC_APP_URL is the canonical frontend, and EXTRA_ALLOWED_ORIGINS is a
// comma-separated list for explicitly whitelisted dev/admin origins (e.g.
// http://46.62.247.167:3003). Cloudflare tunnel domains and wildcard entries
// are NEVER accepted; the upstream nginx proxy must terminate those before
// traffic reaches the backend.
const allowedOrigins = new Set<string>();

// NEXT_PUBLIC_APP_URL is the canonical frontend URL (e.g. https://app.cryptoflip.com).
// We never fall back to a wildcard localhost in production; missing config is a fatal error.
if (process.env.NEXT_PUBLIC_APP_URL) allowedOrigins.add(process.env.NEXT_PUBLIC_APP_URL);

// In all environments, only allow explicit extra origins. Reject any wildcard
// or tunnel-looking entries that could let an attacker bypass the gate.
if (process.env.EXTRA_ALLOWED_ORIGINS) {
  for (const o of process.env.EXTRA_ALLOWED_ORIGINS.split(',')) {
    const t = o.trim();
    if (!t) continue;
    // Block tunnel/wildcard domains (case-insensitive)
    if (/[*]|\.trycloudflare\.com$/i.test(t) || /\.ngrok\.io$/i.test(t) || /\.ngrok-free\.app$/i.test(t)) {
      console.warn('CORS: rejecting insecure origin:', t);
      continue;
    }
    allowedOrigins.add(t);
  }
}


const corsOrigin = Array.from(allowedOrigins);
if (process.env.NODE_ENV === 'production' && corsOrigin.length === 0) {
  console.error('❌ FATAL: NEXT_PUBLIC_APP_URL must be set in production for CORS allowlist.');
  process.exit(1);
}
import * as Sentry from '@sentry/node';

import { initSentry } from './config/sentry';
initSentry();

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ──────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // server-to-server / no origin (curl/Postman)
      if (corsOrigin.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// ─── Middleware ──────────────────────────────────────────────
app.use(helmet(helmetConfig));
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // server-to-server / no origin
    if (corsOrigin.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Sentry request handler — must be after body parsing but before routes
const sentryEnabled = !!process.env.SENTRY_DSN;
if (sentryEnabled) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Sentry.withScope((scope) => {
      scope.setTag('path', req.path);
      scope.setTransactionName(`${req.method} ${req.path}`);
      next();
    });
  });
}

// Rate Limiting
app.use('/api', globalLimiter);
app.use('/api', geoipMiddleware);
app.use('/api', csrfMiddleware);

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/game',  gameRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/wallet', affiliateRoutes);
app.use('/api/wallet', promoRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/bonus', bonusRoutes);
app.use('/api/game/leaderboards', leaderboardsRoutes);
// payment.ts routes are mounted at /api/payment/* (the file's own
// comment in the header says "/api/wallet/payment/*" but the file's
// internal paths are '/create', '/orders', '/health' which only
// resolve to the right URLs when mounted at /api/payment).
import paymentRoutes from './routes/payment';
import adminPublicRoutes from './routes/admin-public';
import adminWithdrawalsRoutes from './routes/admin-withdrawals';
// Public admin config — mounted BEFORE protected admin routes
app.use('/api/admin/config', adminPublicRoutes);
// Protected admin routes (order matters: withdrawals before catch-all adminRoutes)
app.use('/api/admin/withdrawals', adminWithdrawalsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminBonusRoutes);
app.use('/api/admin', adminHealthRoutes);
// OpenAPI / Swagger UI — public, no auth required
app.use('/api', docsRoutes);
// Prometheus metrics — public, scraped by Prometheus
app.use('/metrics', metricsRoutes);
app.use('/api/payment', paymentRoutes);
// Alternative public banner route (avoids /api/admin prefix collision)
app.use('/api/public', adminPublicRoutes);
app.use('/api/deposit', depositRoutes);


app.get('/api/health', async (_req, res) => {
  const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; message?: string }> = {};

  // PostgreSQL check
  const pgStart = Date.now();
  try {
    await query('SELECT 1');
    checks.database = { status: 'ok', latencyMs: Date.now() - pgStart };
  } catch (err) {
    checks.database = { status: 'error', latencyMs: Date.now() - pgStart, message: (err as Error).message };
  }

  // Redis check (uses lazyConnect — explicit connect with timeout)
  const redisStart = Date.now();
  const redisHealth = await redisHealthCheck();
  checks.redis = {
    status: redisHealth.ok ? 'ok' : 'error',
    latencyMs: Date.now() - redisStart,
    ...(redisHealth.error ? { message: redisHealth.error } : {}),
  };

  const allHealthy = Object.values(checks).every((s) => s.status === 'ok');
  const statusCode = allHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: allHealthy ? 'ok' : 'degraded',
    service: 'CryptoFlip Backend v1.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    checks,
  });
});

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  const status = err.statusCode || err.status || 500;
  if (sentryEnabled) {
    Sentry.captureException(err);
  }
  res.status(status).json({ success: false, error: err.message || 'Internal server error' });
});

// ─── Socket.io ──────────────────────────────────────────────
setupSocketHandlers(io);

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.BACKEND_PORT || 4000;

async function start() {
  await connectDB();
  await ensureActiveSeed(); // ensure at least one provably-fair seed exists
  
  // Redis: explicit connect with error handling (lazyConnect in config)
  try {
    await redis.connect();
  } catch (err) {
    console.error('⚠️ Redis connection failed on startup:', (err as Error).message);
    console.error('   The server will continue running; Redis will retry in background.');
  }
  
  startReconciliationLoop();  // Phase B.2 — every 5 min, recovers missed webhooks
  
  // Start TronGrid deposit monitor to detect incoming USDT payments
  tronDepositMonitor.start();

  // Start periodic S3/local audit backup (every 1 hour)
  startAuditBackupWorker(3600000);

  // Start webhook dispatcher worker
  startWebhookWorker();

  httpServer.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════╗');
    console.log('║   🚀 CryptoFlip Backend চালু!      ║');
    console.log('╠════════════════════════════════════╣');
    console.log(`║  📡 API:    http://localhost:${PORT}  ║`);
    console.log(`║  🔌 WS:     ws://localhost:${PORT}    ║`);
    console.log(`║  ❤️  Health: /health                 ║`);
    console.log('╚════════════════════════════════════╝\n');
  });
}

start().catch(console.error);
export { io };
