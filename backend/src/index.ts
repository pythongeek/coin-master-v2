
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
import { loadEnvFromDisk } from './utils/env-loader';

import { connectDB, query } from './config/database';
import { redis, redisHealthCheck } from './config/redis';
import { setupSocketHandlers } from './services/socket-manager';
import { startReconciliationLoop } from './services/reconciliation';
import { geoipMiddleware } from './middleware/geoip';
import { globalLimiter } from './middleware/rate-limiter';
import { csrfMiddleware, helmetConfig } from './middleware/security';
import { errorHandler, setSentryCapture } from './middleware/error-handler';
import { startAuditBackupWorker } from './services/audit-backup';
import { startWebhookWorker } from './services/webhook';
import { adminHealthRoutes } from './routes/admin-health';
import adminPaymentsQrRoutes from './routes/admin-payments-qr';
import adminEmailRoutes from './routes/admin-email';
import adminKycRoutes from './routes/admin-kyc';
import adminBalanceRoutes from './routes/admin-balance';
import adminAuditRoutes from './routes/admin-audit';
import adminWebhooksRoutes from './routes/admin-webhooks';
import adminFraudRoutes from './routes/admin-fraud';
import graphRoutes from './routes/graphs';
import mlRoutes from './routes/ml-routes';
import adminGeoipRoutes from './routes/admin-geoip';
import adminFraudReportsRoutes from './routes/admin-fraud-reports';
import adminCohortsRoutes from './routes/admin-cohorts';
import { tronDepositMonitor } from './services/tron-deposit-monitor';
import { tronMcpService } from './services/tron-mcp.service';
import docsRoutes from './routes/docs';
import router from './routes/metrics';

const metricsRoutes = router;

import authRoutes  from './routes/auth';
import auth2faRoutes from './routes/auth-2fa';
import gameRoutes  from './routes/game';
import adminRoutes from './routes/admin';
import adminBonusRoutes from './routes/admin-bonus';
import dashboardRoutes from './routes/dashboard';
import walletRoutes from './routes/wallet';
import walletDepositQrRoutes from './routes/wallet-deposit-qr';
import kycRoutes from './routes/kyc';
import leaderboardsRoutes from './routes/leaderboards';
import affiliateRoutes from './routes/affiliate';
import promoRoutes from './routes/promo';
import bonusRoutes from './routes/bonus';
import { ensureActiveSeed } from './services/server-seed';
import depositRoutes from './routes/deposit';


dotenv.config();

// ─── Admin 2FA Toggle ──────────────────────────────────────
// The canonical source of truth is the admin_settings row
// 'admin_2fa_required'. The env variable ADMIN_2FA_REQUIRED is kept
// only as a fallback for existing deployments and is optional. Default
// is false (off) until an admin turns it on from the dashboard.
const admin2faRaw = process.env.ADMIN_2FA_REQUIRED;
if (admin2faRaw !== undefined && admin2faRaw !== '' && admin2faRaw !== 'true' && admin2faRaw !== 'false') {
  console.error(`\n❌ FATAL: ADMIN_2FA_REQUIRED="${admin2faRaw}" is invalid.`);
  console.error('   Only "true", "false", or unset are accepted.');
  process.exit(1);
}
if (admin2faRaw === 'true') {
  console.log('🔐 ADMIN_2FA_REQUIRED=true: admin 2FA fallback enabled');
}
const ADMIN_2FA_REQUIRED_FALLBACK = admin2faRaw === 'true';
export { ADMIN_2FA_REQUIRED_FALLBACK };

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
  // Keep long-lived connections alive through nginx proxies and mobile networks
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  // Allow larger payloads for batched real-time events
  maxHttpBufferSize: 1e6,
  // Do not close on upgrade failure; gracefully fall back to polling
  allowUpgrades: true,
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
app.use('/api/auth/2fa',  auth2faRoutes);
app.use('/api/game',  gameRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/wallet/deposit/qr', walletDepositQrRoutes);
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
import publicFxRoutes from './routes/public-fx';
import adminWithdrawalsRoutes from './routes/admin-withdrawals';
// Public admin config — mounted BEFORE protected admin routes

// Load any missing env vars from on-disk .env files (docker-compose env_file
// may not contain all secrets; this picks up backend/.env at runtime)
const _envLoadResult = loadEnvFromDisk();
if (_envLoadResult.loaded > 0) {
  console.log(`[env-loader] injected ${_envLoadResult.loaded} vars from: ${_envLoadResult.files.join(", ")}`);
}

// Protected admin routes (order matters: withdrawals before catch-all adminRoutes)
//
// P1-10: removed the prior `app.use('/api/admin/config', adminPublicRoutes)` duplicate.
// adminPublicRoutes is now mounted exactly once — at /api/public below — so anonymous
// users no longer accidentally reach a path that is named under /api/admin/*.

app.use('/api/admin/withdrawals', adminWithdrawalsRoutes);
app.use('/api/admin/kyc', adminKycRoutes);
app.use('/api/admin/balance', adminBalanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminBonusRoutes);
app.use('/api/admin', adminHealthRoutes);
app.use('/api/admin/payments', adminPaymentsQrRoutes);
app.use('/api/admin/email', adminEmailRoutes);
app.use('/api/admin/audit', adminAuditRoutes);
app.use('/api/admin/webhooks', adminWebhooksRoutes);
app.use('/api/admin', adminFraudRoutes);
app.use('/api/admin/graphs', graphRoutes);
app.use('/api/admin/ml', mlRoutes);
app.use('/api/admin/geoip', adminGeoipRoutes);
app.use('/api/admin/fraud', adminFraudReportsRoutes);
app.use('/api/admin/cohorts', adminCohortsRoutes);
// OpenAPI / Swagger UI — public, no auth required
app.use('/api', docsRoutes);
// Prometheus metrics — public, scraped by Prometheus
app.use('/metrics', metricsRoutes);
app.use('/api/payment', paymentRoutes);
// Alternative public banner route (avoids /api/admin prefix collision)
app.use('/api/public', adminPublicRoutes);
app.use('/api/public', publicFxRoutes);
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

// Global error handler — P0-06: sanitizes all 5xx errors, never leaks
// err.message / err.stack to clients in production. See
// ./middleware/error-handler.ts for the full classification rules.
if (sentryEnabled && Sentry?.captureException) {
  setSentryCapture((err, ctx) => {
    Sentry.captureException(err, { extra: ctx });
  });
}
app.use(errorHandler);

// ─── Socket.io ──────────────────────────────────────────────
setupSocketHandlers(io);
  import('./services/payment-socket.service').then((m) => m.bindPaymentSocket(io));

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
  
  // Start TronGrid MCP session and deposit monitor
  try {
    await tronMcpService.start();
  } catch (err) {
    console.error('Failed to start TronGrid MCP service; continuing without deposit monitoring', (err as Error).message);
  }
  tronDepositMonitor.start();

  // Start periodic S3/local audit backup (every 1 hour)
  startAuditBackupWorker(3600000);

  // Start webhook dispatcher worker
  startWebhookWorker();

  // Start Binance Pay QR background services
  try {
    const { startLedgerMonitorLoop } = await import('./services/binance-pay-ledger-monitor.service');
    startLedgerMonitorLoop();
  } catch (e) {
    console.warn('[boot] ledger monitor failed to start:', e);
  }
  try {
    const { startWeeklyFeedbackLoop } = await import('./services/llm-feedback-loop.service');
    startWeeklyFeedbackLoop();
  } catch (e) {
    console.warn('[boot] LLM feedback loop failed to start:', e);
  }

  // Start email notification worker (drains email_queue every 10s)
  try {
    const { startEmailWorker } = await import('./services/notification.service');
    startEmailWorker(10_000);
  } catch (e) {
    console.warn('[boot] email worker failed to start:', e);
  }

  // Start P3-5 daily fraud digest worker. Ticks once per hour and
  // fires sendDailyReport() if the configured send hour (default
  // 08:00 UTC) matches the current hour. Idempotent: re-runs
  // within the same hour hit the (report_date, report_kind) unique
  // constraint and short-circuit.
  try {
    const { startDailyFraudReportWorker } = await import('./services/daily-fraud-report');
    startDailyFraudReportWorker(60 * 60 * 1000);
  } catch (e) {
    console.warn('[boot] daily fraud report worker failed to start:', e);
  }

  // Start P3-6 weekly behavioral cohort analysis worker. Ticks
  // once per hour and fires runWeeklyCohortAnalysis() if the current
  // day is Sunday AND the hour matches daily_fraud_report_send_hour_utc
  // (default 04:00 UTC). The hourly tick is the same pattern as
  // llm-feedback-loop + daily-fraud-report: the worker itself
  // gates on day-of-week + hour-of-day so it only fires weekly.
  try {
    const { startWeeklyCohortWorker } = await import('./services/cohort-analysis');
    startWeeklyCohortWorker(60 * 60 * 1000);
  } catch (e) {
    console.warn('[boot] weekly cohort analysis worker failed to start:', e);
  }

  // Start QR expiration worker (ticks every 60s, expires stale orders)
  // Runs independently of the ledger-monitor loop so expired orders don't
  // pile up when BINANCE_API_SECRET is not configured.
  try {
    const { startQrExpirationLoop } = await import('./services/binance-pay-qr.service');
    startQrExpirationLoop(60_000);
  } catch (e) {
    console.warn('[boot] QR expiration loop failed to start:', e);
  }

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
