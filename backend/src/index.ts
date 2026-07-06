/**
 * ═══════════════════════════════════════════════════════════════
 *  CRYPTOFLIP BACKEND — মূল সার্ভার এন্ট্রি পয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { connectDB } from './config/database';
import { redis } from './config/redis';
import { setupSocketHandlers } from './services/socket-manager';
import { startReconciliationLoop } from './services/reconciliation';
import { geoipMiddleware } from './middleware/geoip';
import { globalLimiter } from './middleware/rate-limiter';
import { csrfMiddleware, helmetConfig } from './middleware/security';
import { startAuditBackupWorker } from './services/audit-backup';
import { startWebhookWorker } from './services/webhook';
import { adminHealthRoutes } from './routes/admin-health';

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


dotenv.config();

// Build CORS allowlist from all configured frontend URLs.
// NEXT_PUBLIC_APP_URL is the canonical frontend, TUNNEL_APP_URL is the
// Cloudflare tunnel, and EXTRA_ALLOWED_ORIGINS is a comma-separated list
// for dev/external-IP access (e.g. http://46.62.247.167:3002).
const allowedOrigins = new Set<string>([
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
]);
if (process.env.TUNNEL_APP_URL) allowedOrigins.add(process.env.TUNNEL_APP_URL);
if (process.env.EXTRA_ALLOWED_ORIGINS) {
  for (const o of process.env.EXTRA_ALLOWED_ORIGINS.split(',')) {
    const t = o.trim();
    if (t) allowedOrigins.add(t);
  }
}
const corsOrigin = Array.from(allowedOrigins);

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ──────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// ─── Middleware ──────────────────────────────────────────────
app.use(helmet(helmetConfig));
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

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
app.use('/api/payment', paymentRoutes);
// Alternative public banner route (avoids /api/admin prefix collision)
app.use('/api/public', adminPublicRoutes);


app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'CryptoFlip Backend v1.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
  });
});

// ─── Socket.io ──────────────────────────────────────────────
setupSocketHandlers(io);

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.BACKEND_PORT || 4000;

async function start() {
  await connectDB();
  await ensureActiveSeed(); // ensure at least one provably-fair seed exists
  void redis;  // redis কানেক্ট হয় import এর সময়
  startReconciliationLoop();  // Phase B.2 — every 5 min, recovers missed webhooks
  
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
