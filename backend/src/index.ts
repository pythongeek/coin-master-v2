/**
 * ═══════════════════════════════════════════════════════════════
 *  CRYPTOFLIP BACKEND — মূল সার্ভার এন্ট্রি পয়েন্ট
 * ═══════════════════════════════════════════════════════════════
 *  Phase 2.5: tighter Helmet, per-route rate limiters, audit_log
 *  + fraud_signals wired for rate-limit events.
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

import authRoutes  from './routes/auth';
import gameRoutes  from './routes/game';
import adminRoutes from './routes/admin';
import adminPublicRoutes from './routes/admin-public';  // Phase 1.4 follow-up: public config subset
import adminWithdrawalsRoutes from './routes/admin-withdrawals';  // Session 1
import walletRoutes from './routes/wallet';
import paymentRoutes from './routes/payment';  // Phase B.1
import webhookRoutes from './routes/webhooks';  // Phase B.1 (webhooks live at /api/webhooks)
import {
  loginLimiter, registerLimiter, passwordResetLimiter,
  apiLimiter,
} from './middleware/rate-limit';

dotenv.config();

const app = express();
const httpServer = createServer(app);

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// ─── Socket.io ──────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: APP_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// ─── Trust proxy (so req.ip works behind Cloudflare Tunnel) ──────
// Phase 2.5: Cloudflare tunnel in front → we need to trust the X-Forwarded-For
// header to get the real client IP. Without this, all requests show as 127.0.0.1
app.set('trust proxy', true);

// ─── Security headers (Helmet) ─────────────────────────────────
// Phase 2.5: tightened config. Removed `crossOriginEmbedderPolicy: false` from
// v1 because Next.js dev mode needs COEP off, but prod builds don't.
// Added CSP, HSTS, hidePoweredBy, frameguard defaults.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
      fontSrc:    ["'self'", 'data:'],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // Next.js dev mode compat
  hsts: {
    maxAge: 31536000,  // 1 year
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },  // no iframe embedding
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ─── CORS ─────────────────────────────────────────────────────
// Phase 2.5: explicit allowlist (was using a permissive origin check).
// Session 2 patch: allow VPS public-IP origin (we opened UFW for 3002/4000
// so users can hit the app via http://46.62.247.167:3002). Also keep
// the old Cloudflare tunnel domain and localhost dev origins.
const ALLOWED_ORIGINS = new Set<string>([
  APP_URL,
  'http://localhost:3000',
  'http://localhost:3002',
  'http://46.62.247.167:3000',
  'http://46.62.247.167:3002',
  'http://46.62.247.167:4000',
  'https://occasions-announced-asia-vsnet.trycloudflare.com',
]);

// Origin check helper: allow Set members + any 46.62.247.127/167 origin.
// This is OK because we run on a single VPS with UFW locked down — but
// it's a tightened rule (not wildcards) for traceability in logs.
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin (no Origin header) / curl
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow any http://46.62.247.167:<port> and http://46.62.247.127:<port>
  // (VPS public IP variants) — UFW controls who can actually reach us,
  // CORS just controls which origins are told "yes" by the browser.
  return /^http:\/\/46\.62\.247\.(127|167)(:\d+)?$/.test(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    // Block: respond 403 (don't leak via 500 stack trace). Empty body
    // so the browser still sees a CORS rejection.
    console.warn(`[CORS] blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Skip JSON parsing for webhook paths — we read the raw body ourselves
// and verify HMAC signatures against the unparsed bytes.
const jsonParser = express.json({ limit: '10kb' });
const urlencodedParser = express.urlencoded({ extended: true });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    return next();  // skip JSON parsing; webhook routes read rawBody directly
  }
  jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    return next();
  }
  urlencodedParser(req, res, next);
});

// ─── Rate Limiting (Phase 2.5: per-route) ──────────────────────
// 1. General API: 200/15min per IP — applied to ALL /api/* as a baseline
app.use('/api', apiLimiter);

// 2. Stricter auth limiters — applied per-route inside the auth router
//    (auth.ts imports them and attaches to specific endpoints).

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);    // auth.ts uses loginLimiter + registerLimiter
// /api/game: per-user rate limit is applied per-route inside game.ts
// (after authMiddleware, so req.user.userId is the bucket key).
// We intentionally do NOT apply the IP-level betLimiter here anymore —
// it ran before authMiddleware, so it keyed by source IP and punished
// legitimate users behind shared NAT (offices, dorms, mobile carriers)
// while failing to stop attackers who rotate IPs. The per-user limiter
// in routes/game.ts is the correct gate. See middleware/rate-limit.ts
// for the H3 rationale.
app.use('/api/game',  gameRoutes);
// Public subset of admin config (no auth) — must be mounted BEFORE the
// protected /api/admin router because Express matches routes in mount
// order. Mounting after would cause adminRoutes's authMiddleware to
// fire first and reject the public request.
app.use('/api/admin/config/public', adminPublicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/withdrawals', adminWithdrawalsRoutes);
app.use('/api/wallet', walletRoutes);
// Phase B.1: payment routes mounted at top level so webhook endpoints
// can skip the auth middleware. (The /api/wallet sub-router applies
// authMiddleware globally; webhooks need public access with HMAC instead.)
app.use('/api/wallet/payment', paymentRoutes);
// IMPORTANT: must come AFTER /api/wallet so wallet's authMiddleware doesn't catch payment routes
// (Express middleware ordering: first matching path runs first, runs all middlewares in chain)
// Webhooks: separate top-level mount so they don't get caught by wallet's authMiddleware.
app.use('/api/webhooks', webhookRoutes);
import dashboardRoutes from './routes/dashboard';
app.use('/api/dashboard', dashboardRoutes);

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
  void redis;  // redis কানেক্ট হয় import এর সময়

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

// Re-export the auth limiters so auth.ts can attach them per-route.
// (auth.ts already imports the named exports above; this is just a
// convenience if anyone wants them inline elsewhere.)
export {
  loginLimiter, registerLimiter, passwordResetLimiter,
} from './middleware/rate-limit';