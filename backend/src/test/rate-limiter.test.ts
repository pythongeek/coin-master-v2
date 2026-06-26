import { Request, Response, NextFunction } from 'express';
import { globalLimiter, authLimiter, gameLimiter, adminLimiter } from '../middleware/rate-limiter';
import { redis } from '../config/redis';

// Express Mock generators
function createMockRequest(ip: string, path: string, userId?: string): Request {
  return {
    ip,
    path,
    headers: {},
    user: userId ? { userId } : undefined,
  } as unknown as Request;
}

function createMockResponse() {
  let statusCode = 200;
  let jsonResponse: any = null;
  let headers: Record<string, string | number> = {};

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      jsonResponse = data;
      return this;
    },
    setHeader(name: string, value: string | number) {
      headers[name] = value;
      return this;
    },
    getHeader(name: string) {
      return headers[name];
    },
  } as unknown as Response;

  return {
    res,
    getStatusCode: () => statusCode,
    getResponse: () => jsonResponse,
    getHeaders: () => headers,
  };
}

function createMockNext() {
  let called = 0;
  const next = (() => {
    called += 1;
  }) as NextFunction;
  return {
    next,
    getCalls: () => called,
  };
}

async function runTests() {
  console.log('🧪 Starting Redis & Fallback Rate Limiter Integration Tests...');
  const testIp = '192.168.1.50';

  try {
    // Check current Redis connection status for information
    console.log(`ℹ️ Redis Status: ${redis.status}`);

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Auth Rate Limiting (Limit: 5)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing Auth Rate Limiting (5 requests per 1 minute)...');

    // Make 5 successful hits
    for (let i = 1; i <= 5; i++) {
      const req = createMockRequest(testIp, '/api/auth/login');
      const m = createMockResponse();
      const n = createMockNext();

      await authLimiter(req, m.res, n.next);

      if (n.getCalls() !== 1) {
        throw new Error(`Auth request #${i} was blocked prematurely.`);
      }
      if (m.getStatusCode() !== 200) {
        throw new Error(`Auth request #${i} failed with status ${m.getStatusCode()}`);
      }
      console.log(`  Hit #${i}: Passed.`);
    }

    // Make the 6th hit (should be blocked)
    const req6 = createMockRequest(testIp, '/api/auth/login');
    const m6 = createMockResponse();
    const n6 = createMockNext();

    await authLimiter(req6, m6.res, n6.next);

    if (n6.getCalls() === 0 && m6.getStatusCode() === 429) {
      const resp = m6.getResponse();
      if (!resp.success && resp.error.includes('অতিরিক্ত রিকোয়েস্ট')) {
        console.log('✅ 6th request successfully blocked with 429 and correct Bengali message.');
      } else {
        throw new Error(`Unexpected block response payload: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Expected request #6 to be rate limited but it passed. Code: ${m6.getStatusCode()}, Next calls: ${n6.getCalls()}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Game Rate Limiting (Limit: 60, by user or IP)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing Game Rate Limiting (60 requests per 1 minute)...');
    const playerIp = '10.0.0.5';
    const playerId = 'player-uuid-123';

    // Verify fast hit loop limits
    let passedCount = 0;
    let blockedCount = 0;

    for (let i = 1; i <= 65; i++) {
      const req = createMockRequest(playerIp, '/api/game/bet', playerId);
      const m = createMockResponse();
      const n = createMockNext();

      await gameLimiter(req, m.res, n.next);

      if (n.getCalls() === 1) {
        passedCount++;
      } else if (m.getStatusCode() === 429) {
        blockedCount++;
      }
    }

    console.log(`  Results: ${passedCount} passed, ${blockedCount} blocked.`);
    if (passedCount === 60 && blockedCount === 5) {
      console.log('✅ Game rate limiting correctly allowed exactly 60 requests and blocked 5.');
    } else {
      throw new Error(`Game rate limiting mismatch: expected 60 passed, 5 blocked. Got ${passedCount} passed, ${blockedCount} blocked.`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Admin Rate Limiting (Limit: 30)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing Admin Rate Limiting (30 requests per 1 minute)...');
    const adminIp = '10.0.0.9';
    const adminId = 'admin-uuid-999';

    let adminPassed = 0;
    let adminBlocked = 0;

    for (let i = 1; i <= 35; i++) {
      const req = createMockRequest(adminIp, '/api/admin/config', adminId);
      const m = createMockResponse();
      const n = createMockNext();

      await adminLimiter(req, m.res, n.next);

      if (n.getCalls() === 1) {
        adminPassed++;
      } else if (m.getStatusCode() === 429) {
        adminBlocked++;
      }
    }

    console.log(`  Results: ${adminPassed} passed, ${adminBlocked} blocked.`);
    if (adminPassed === 30 && adminBlocked === 5) {
      console.log('✅ Admin rate limiting correctly allowed exactly 30 requests and blocked 5.');
    } else {
      throw new Error(`Admin rate limiting mismatch: expected 30 passed, 5 blocked. Got ${adminPassed} passed, ${adminBlocked} blocked.`);
    }

    console.log('\n🎉 All API rate limiter integration tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
