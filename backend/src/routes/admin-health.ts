/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN HEALTH ROUTES — /api/admin/health
 *  Returns dependency status for Postgres, Redis, and blockchain RPC.
 * ═══════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth';
import { adminLimiter } from '../middleware/rate-limiter';
import { db } from '../config/database';
import { redis } from '../config/redis';

const router = Router();

async function checkPostgres(): Promise<{ status: 'ok' | 'err'; latencyMs: number; message?: string }> {
  const start = Date.now();
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'err', latencyMs: Date.now() - start, message: String(err) };
  }
}

async function checkRedis(): Promise<{ status: 'ok' | 'err'; latencyMs: number; message?: string }> {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'err', latencyMs: Date.now() - start, message: String(err) };
  }
}

async function checkBlockchain(): Promise<{ status: 'ok' | 'err'; latencyMs: number; message?: string; blockHeight?: number }> {
  const start = Date.now();
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  if (!rpcUrl) {
    return { status: 'err', latencyMs: 0, message: 'BLOCKCHAIN_RPC_URL not configured' };
  }
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const data = (await res.json()) as { result?: string; error?: { message?: string } };
    if (typeof data.result === 'string') {
      return { status: 'ok', latencyMs: Date.now() - start, blockHeight: parseInt(data.result, 16) };
    }
    return { status: 'err', latencyMs: Date.now() - start, message: data.error?.message || 'Unexpected RPC response' };
  } catch (err) {
    return { status: 'err', latencyMs: Date.now() - start, message: String(err) };
  }
}

router.get('/', adminLimiter, authMiddleware, roleMiddleware(['super_admin', 'auditor']), async (_req: Request, res: Response) => {
  const start = Date.now();
  const [postgres, redisStatus, blockchain] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkBlockchain(),
  ]);

  const allOk = postgres.status === 'ok' && redisStatus.status === 'ok';
  const status = allOk ? 'ok' : 'degraded';

  res.status(allOk ? 200 : 503).json({
    success: true,
    status,
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - start,
    checks: {
      postgres,
      redis: redisStatus,
      blockchain,
    },
  });
});

export { router as adminHealthRoutes };
