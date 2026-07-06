/**
 * ═══════════════════════════════════════════════════════════════
 *  TEST MOCK INFRASTRUCTURE — Shared across all test files
 * ═══════════════════════════════════════════════════════════════
 *
 *  Provides a unified set of mocks for:
 *    - database (in-memory with proper credit/debit semantics)
 *    - redis (lockBet/unlockBet/streak helpers)
 *    - server-seed (reserveNonce/getSeedSecretById/ensureActiveSeed)
 *    - provably-fair (controllable resolveFlip)
 *    - reconciliation-engine (no-op)
 *    - bullmq (no-op)
 *
 *  The mock query handler understands the new dual-balance model
 *  (bonus_balance_coins + withdrawable_balance_coins) and the
 *  UPDATE ... balance = balance + $1 credit pattern.
 *
 *  Usage:
 *    import { installCommonMocks, MOCK_DB, MOCK_USERS, MOCK_BETS } from './helpers/test-mocks';
 *    installCommonMocks();
 *    MOCK_USERS.push({ id: '...', balance: 1000, withdrawable_balance_coins: 1000 });
 *    const { placeBet } = require('../services/game-engine');
 */

import Module from 'module';

// ── Types ──────────────────────────────────────────────────────

export interface MockUser {
  id: string;
  balance: number;
  bonus_balance_coins?: number;
  withdrawable_balance_coins?: number;
  total_wagered?: number;
  pending_rakeback?: number;
  is_active?: boolean;
  is_admin?: boolean;
  is_super_admin?: boolean;
  kyc_status?: string;
  fraud_score?: number;
  country_code?: string;
  referred_by?: string | null;
  wallet_address?: string;
  username?: string;
  email?: string;
  [key: string]: any;
}

export interface MockBet {
  id: string;
  user_id: string;
  choice: string;
  amount: number;
  result: string;
  won: boolean;
  payout: number;
  house_edge: number;
  flip_hash: string;
  created_at: Date;
  [key: string]: any;
}

export interface MockSettings {
  key: string;
  value: string;
}

// ── Shared state ───────────────────────────────────────────────

export const MOCK_USERS: MockUser[] = [];
export const MOCK_BETS: MockBet[] = [];
export const MOCK_SETTINGS: MockSettings[] = [];
export const MOCK_TRANSACTIONS: any[] = [];
export const MOCK_BONUS_CLAIMS: any[] = [];
export const MOCK_GAME_SEEDS: any[] = [];
export const MOCK_WALLETS: any[] = [];
export const MOCK_WITHDRAWALS: any[] = [];
export const MOCK_AFFILIATES: any[] = [];
export const MOCK_FRAUD_FLAGS: any[] = [];
export const MOCK_AUDIT_LOGS: any[] = [];
export const MOCK_KYC_RECORDS: any[] = [];
export const MOCK_TOTP_SECRETS: any[] = [];
export const MOCK_RATE_LIMIT_BUCKETS: Map<string, { count: number; resetAt: number }> = new Map();
export const MOCK_NOTIFICATIONS: any[] = [];
export const MOCK_WEBHOOKS: any[] = [];

// ── Interceptor state ──────────────────────────────────────────

let queryInterceptor: ((text: string, params: any[]) => Promise<any> | any) | null = null;
let txSnapshotUsers: string | null = null;
let txSnapshotBets: string | null = null;
let txSnapshotTransactions: string | null = null;
let txSnapshotWallets: string | null = null;
let txSnapshotBonusClaims: string | null = null;
let txSnapshotWithdrawals: string | null = null;

export function setQueryInterceptor(fn: typeof queryInterceptor) {
  queryInterceptor = fn;
}

// ── Mock query implementation ──────────────────────────────────

function getUser(id: string): MockUser | undefined {
  return MOCK_USERS.find((u) => u.id === id);
}

/**
 * Extract the user ID param from a query by finding the position of
 * `WHERE id = $N` in the SQL text. Falls back to the first param that
 * looks like a UUID if the regex doesn't match.
 */
function extractUserIdParam(q: string, params: any[]): string | undefined {
  const match = q.match(/where\s+id\s*=\s*\$(\d+)/i);
  if (match) {
    const idx = parseInt(match[1]) - 1;
    return params[idx];
  }
  // Fallback: first param
  return params[0];
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  if (process.env.DEBUG2 === '1') console.error('MQ_START: ' + text.slice(0,50));
  if (process.env.MOCK_QUERY_TRACE === '1') console.error('Q:', text.replace(/\s+/g,' ').slice(0,200), '| params:', JSON.stringify(params).slice(0,200));
  // Allow tests to override with their own mockQuery at runtime
  const testOverride = (global as any).__TEST_MOCK_QUERY__;
  if (process.env.DEBUG_TEST === '1') console.error('DELEG_CHECK: text=' + text.slice(0,40) + ' hasOverride=' + !!testOverride + ' sameFn=' + (testOverride === mockQuery));
  if (testOverride && testOverride !== mockQuery) {
      try {
      return await testOverride(text, params);
    } catch (e) {
      if (process.env.DEBUG_TEST === '1') console.error('DELEG_ERR: ' + (e as Error).message);
      throw e;
    }
  }

  if (queryInterceptor) {
    const res = await queryInterceptor(text, params);
    if (res !== undefined) return res;
  }

  const q = normalize(text);
  const upper = q.toUpperCase();

  // ── Transaction control ─────────────────────────────────────
  if (upper === 'BEGIN') {
    txSnapshotUsers = JSON.stringify(MOCK_USERS);
    txSnapshotBets = JSON.stringify(MOCK_BETS);
    txSnapshotTransactions = JSON.stringify(MOCK_TRANSACTIONS);
    txSnapshotWallets = JSON.stringify(MOCK_WALLETS);
    txSnapshotBonusClaims = JSON.stringify(MOCK_BONUS_CLAIMS);
    txSnapshotWithdrawals = JSON.stringify(MOCK_WITHDRAWALS);
    return { rows: [] };
  }

  if (upper === 'COMMIT') {
    txSnapshotUsers = null;
    txSnapshotBets = null;
    txSnapshotTransactions = null;
    txSnapshotWallets = null;
    txSnapshotBonusClaims = null;
    txSnapshotWithdrawals = null;
    return { rows: [] };
  }

  if (upper === 'ROLLBACK') {
    if (txSnapshotUsers !== null) MOCK_USERS.splice(0, MOCK_USERS.length, ...JSON.parse(txSnapshotUsers));
    if (txSnapshotBets !== null) MOCK_BETS.splice(0, MOCK_BETS.length, ...JSON.parse(txSnapshotBets));
    if (txSnapshotTransactions !== null) MOCK_TRANSACTIONS.splice(0, MOCK_TRANSACTIONS.length, ...JSON.parse(txSnapshotTransactions));
    if (txSnapshotWallets !== null) MOCK_WALLETS.splice(0, MOCK_WALLETS.length, ...JSON.parse(txSnapshotWallets));
    if (txSnapshotBonusClaims !== null) MOCK_BONUS_CLAIMS.splice(0, MOCK_BONUS_CLAIMS.length, ...JSON.parse(txSnapshotBonusClaims));
    if (txSnapshotWithdrawals !== null) MOCK_WITHDRAWALS.splice(0, MOCK_WITHDRAWALS.length, ...JSON.parse(txSnapshotWithdrawals));
    txSnapshotUsers = null;
    txSnapshotBets = null;
    txSnapshotTransactions = null;
    txSnapshotWallets = null;
    txSnapshotBonusClaims = null;
    txSnapshotWithdrawals = null;
    return { rows: [] };
  }

  // ── Admin settings ──────────────────────────────────────────
  if (upper.startsWith('SELECT KEY, VALUE FROM ADMIN_SETTINGS') || upper.startsWith("SELECT KEY, VALUE FROM ADMIN_SETTINGS WHERE KEY = '")) {
    if (upper.includes('WHERE KEY =')) {
      const key = params[0];
      const found = MOCK_SETTINGS.find((s) => s.key === key);
      return { rows: found ? [{ key: found.key, value: found.value }] : [] };
    }
    return { rows: [...MOCK_SETTINGS] };
  }

  // ── Generic bets SELECTs (for tests that don't override mockQuery) ──
  if (upper.includes('SELECT') && upper.includes('FROM BETS')) {
    if (upper.includes('COUNT(*)')) {
      return { rows: [{ total_bets: '0', total_wins: '0', total_losses: '0', total_wagered: '0', net_pnl: '0', total_payout: '0', last_bet_at: null, biggest_win: '0' }] };
    }
    return { rows: [] };
  }

  // ── User SELECTs ────────────────────────────────────────────
  if (upper.includes('FROM USERS WHERE ID = $1') && upper.startsWith('SELECT')) {
    const user = getUser(params[0]);
    if (!user) return { rows: [] };
    return {
      rows: [{
        ...user,
        balance: String(user.balance ?? 0),
        bonus_balance_coins: String(user.bonus_balance_coins ?? 0),
        withdrawable_balance_coins: String(user.withdrawable_balance_coins ?? user.balance ?? 0),
        total_wagered: String(user.total_wagered ?? 0),
        pending_rakeback: String(user.pending_rakeback ?? 0),
        referred_by: user.referred_by ?? null,
        pending_affiliate_balance: String(user.pending_affiliate_balance ?? 0),
        total_affiliate_earned: String(user.total_affiliate_earned ?? 0),
        kyc_status: user.kyc_status ?? 'none',
        fraud_score: String(user.fraud_score ?? 0),
        country_code: user.country_code ?? null,
        is_active: user.is_active ?? true,
        is_admin: user.is_admin ?? false,
        is_super_admin: user.is_super_admin ?? false,
        username: user.username ?? null,
        email: user.email ?? null,
        wallet_address: user.wallet_address ?? null,
        frozen: user.frozen ?? false,
        last_login_at: user.last_login_at ?? null,
        created_at: user.created_at ?? new Date(),
        updated_at: user.updated_at ?? new Date(),
        password_hash: user.password_hash ?? 'mock-hash',
        two_factor_enabled: user.two_factor_enabled ?? false,
      }],
    };
  }

  if (upper.startsWith('SELECT ID, USERNAME, EMAIL, PASSWORD_HASH, IS_ACTIVE')) {
    const user = MOCK_USERS.find((u) => u.username === params[0] || u.email === params[0]);
    return { rows: user ? [user] : [] };
  }

  if (upper.includes('SELECT COUNT(*) AS COUNT FROM BETS WHERE USER_ID = $1')) {
    const count = MOCK_BETS.filter((b) => b.user_id === params[0]).length;
    return { rows: [{ count }] };
  }

  if (upper.includes('SELECT COUNT(*) FROM USERS')) {
    return { rows: [{ count: MOCK_USERS.length }] };
  }

  // ── User UPDATE patterns ────────────────────────────────────
  if (upper.startsWith('UPDATE USERS SET BALANCE = $1')) {
    const balance = Number(params[0]);
    const id = extractUserIdParam(q, params);
    const user = id ? getUser(id) : undefined;
    if (user) {
      user.balance = balance;
      user.withdrawable_balance_coins = balance;
    }
    return { rows: [] };
  }

  // Credit/debit via balance = balance + $1
  if (upper.includes('UPDATE USERS') && (upper.includes('BALANCE = BALANCE + $1') || upper.includes('BALANCE = BALANCE - $1'))) {
    const delta = Number(params[0]);
    const id = extractUserIdParam(q, params);
    const user = id ? getUser(id) : undefined;
    if (user) {
      if (upper.includes('BALANCE = BALANCE - $1')) {
        user.balance -= delta;
        user.withdrawable_balance_coins = (user.withdrawable_balance_coins ?? user.balance) - delta;
      } else {
        user.balance += delta;
        user.withdrawable_balance_coins = (user.withdrawable_balance_coins ?? user.balance) + delta;
      }
    }
    return { rows: [{ balance: user ? user.balance : 0 }] };
  }

  if (upper.includes('UPDATE USERS SET') && upper.includes('WITHDRAWABLE_BALANCE_COINS')) {

    const id = extractUserIdParam(q, params);
    const user = id ? getUser(id) : undefined;
    if (user) {
      // Parse the actual SQL expression to compute the new value
      // e.g. "withdrawable_balance_coins = withdrawable_balance_coins + $2"
      //      "withdrawable_balance_coins = withdrawable_balance_coins - $2"
      const matchAdd = q.match(/withdrawable_balance_coins\s*=\s*withdrawable_balance_coins\s*\+\s*\$(\d+)/i);
      const matchSub = q.match(/withdrawable_balance_coins\s*=\s*withdrawable_balance_coins\s*-\s*\$(\d+)/i);
      const matchSet = q.match(/withdrawable_balance_coins\s*=\s*\$(\d+)/i);
      const current = user.withdrawable_balance_coins ?? user.balance ?? 0;
      if (matchAdd) {
        const idx = parseInt(matchAdd[1]) - 1;
        user.withdrawable_balance_coins = current + Number(params[idx] || 0);
      } else if (matchSub) {
        const idx = parseInt(matchSub[1]) - 1;
        user.withdrawable_balance_coins = current - Number(params[idx] || 0);
      } else if (matchSet) {
        const idx = parseInt(matchSet[1]) - 1;
        user.withdrawable_balance_coins = Number(params[idx] || 0);
      } else {
        // Fallback: keep balance in sync (mock approximation)
        user.withdrawable_balance_coins = user.balance;
      }
      // Keep users.balance = withdrawable + bonus (mimics the DB trigger)
      const bonus = user.bonus_balance_coins ?? 0;
      user.balance = (user.withdrawable_balance_coins ?? 0) + bonus;
    }
    return { rows: [{ new_balance: user ? user.balance : 0 }] };
  }

  if (upper.startsWith('UPDATE USERS SET') && upper.includes('TOTAL_WAGERED')) {
    const totalWagered = Number(params[0]);
    const pendingRakeback = Number(params[1] || 0);
    const id = params[2];
    const user = id ? getUser(id) : undefined;
    if (user) {
      user.total_wagered = totalWagered;
      user.pending_rakeback = pendingRakeback;
    }
    return { rows: [] };
  }

  if (upper.startsWith('UPDATE USERS SET') && upper.includes('PENDING_AFFILIATE_BALANCE')) {
    const pending = Number(params[0]);
    const total = Number(params[1] || 0);
    const id = params[2];
    const user = id ? getUser(id) : undefined;
    if (user) {
      user.pending_affiliate_balance = pending;
      user.total_affiliate_earned = total;
    }
    return { rows: [] };
  }

  if (upper.startsWith('UPDATE USERS SET') && upper.includes('UPDATED_AT')) {
    const id = extractUserIdParam(q, params);
    const user = id ? getUser(id) : undefined;
    if (user) user.updated_at = new Date();
    return { rows: [] };
  }

  // ── Bet INSERT ──────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO BETS')) {
    const id = params[0];
    const user_id = params[1];
    const choice = params[2];
    const amount = Number(params[3]);
    const result = params[4];
    const won = params[5];
    const payout = Number(params[6]);
    const house_edge = Number(params[7]);
    const flip_hash = params[8];
    MOCK_BETS.push({
      id, user_id, choice, amount, result, won, payout, house_edge, flip_hash,
      created_at: new Date(),
    });
    return { rows: [] };
  }

  // ── Game seeds INSERT ───────────────────────────────────────
  if (upper.startsWith('INSERT INTO GAME_SEEDS')) {
    const seed = {
      id: params[0] || `seed-${MOCK_GAME_SEEDS.length + 1}`,
      user_id: params[1],
      server_seed: params[2],
      server_seed_hash: params[3],
      client_seed: params[4],
      nonce: Number(params[5] || 0),
      is_revealed: true,
      created_at: new Date(),
    };
    MOCK_GAME_SEEDS.push(seed);
    return { rows: [{ id: seed.id }] };
  }

  // ── Transactions INSERT ─────────────────────────────────────
  if (upper.startsWith('INSERT INTO TRANSACTIONS')) {
    const tx = {
      id: params[0],
      user_id: params[1],
      wallet_id: params[2] || null,
      type: params[3] || params[2],
      amount: Number(params[3] !== undefined && isNaN(Number(params[3])) ? params[4] : params[3]),
      status: 'completed',
      created_at: new Date(),
    };
    MOCK_TRANSACTIONS.push(tx);
    return { rows: [] };
  }

  // ── Wallets ─────────────────────────────────────────────────
  if (upper.startsWith('SELECT * FROM WALLETS WHERE USER_ID')) {
    const wallets = MOCK_WALLETS.filter((w) => w.user_id === params[0]);
    return { rows: wallets };
  }

  if (upper.startsWith('UPDATE WALLETS SET BALANCE')) {
    const id = extractUserIdParam(q, params);
    const wallet = MOCK_WALLETS.find((w) => w.id === id);
    if (wallet) {
      const match = q.match(/balance\s*=\s*balance\s*([+-])\s*\$1/i);
      if (match) {
        const delta = Number(params[0]);
        wallet.balance = match[1] === '+' ? wallet.balance + delta : wallet.balance - delta;
      }
    }
    return { rows: [] };
  }

  // ── Bonus claims ────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO BONUS_CLAIMS')) {
    const claim = {
      id: params[0],
      user_id: params[1],
      bonus_type: params[2],
      amount_coins: Number(params[3] || 0),
      wagering_required: Number(params[4] || 0),
      wagering_completed: 0,
      status: 'active',
      claimed_at: new Date(),
      expires_at: params[5] ? new Date(params[5]) : new Date(Date.now() + 7 * 86400000),
    };
    MOCK_BONUS_CLAIMS.push(claim);
    return { rows: [] };
  }

  // ── Withdrawals ─────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO WITHDRAWALS')) {
    const w = {
      id: params[0],
      user_id: params[1],
      amount: Number(params[2] || 0),
      status: 'pending',
      created_at: new Date(),
    };
    MOCK_WITHDRAWALS.push(w);
    return { rows: [] };
  }

  // ── Audit log ───────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO AUDIT_LOG')) {
    MOCK_AUDIT_LOGS.push({
      id: params[0],
      user_id: params[1],
      action: params[2],
      metadata: params[3] || {},
      created_at: new Date(),
    });
    return { rows: [] };
  }

  // ── Fraud flags ─────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO FRAUD_FLAGS')) {
    MOCK_FRAUD_FLAGS.push({
      id: params[0],
      user_id: params[1],
      reason: params[2],
      severity: params[3],
      created_at: new Date(),
    });
    return { rows: [] };
  }

  // ── KYC records ─────────────────────────────────────────────
  if (upper.startsWith('INSERT INTO KYC_RECORDS')) {
    MOCK_KYC_RECORDS.push({
      id: params[0],
      user_id: params[1],
      status: params[2] || 'pending',
      created_at: new Date(),
    });
    return { rows: [] };
  }

  // ── Default: empty result ───────────────────────────────────
  return { rows: [] };
}

// ── Mock redis ─────────────────────────────────────────────────

// Track active bet locks per user to simulate Redis SET NX semantics.
const _activeBetLocks = new Set<string>();

// In-memory Redis store used by the ioredis mock instance.
const _redisStore = new Map<string, { value: string; expiresAt: number | null }>();

function _redisGet(key: string): string | null {
  const entry = _redisStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
    _redisStore.delete(key);
    return null;
  }
  return entry.value;
}

function _redisSet(key: string, value: string, ...args: any[]) {
  let expiresAt: number | null = null;
  // Support EX <seconds>, PX <milliseconds>, NX/XX flags are ignored for tests.
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]).toUpperCase();
    if (arg === 'EX' && args[i + 1] !== undefined) {
      expiresAt = Date.now() + Number(args[i + 1]) * 1000;
      i++;
    } else if (arg === 'PX' && args[i + 1] !== undefined) {
      expiresAt = Date.now() + Number(args[i + 1]);
      i++;
    }
  }
  _redisStore.set(key, { value, expiresAt });
  return 'OK';
}

// Mock Redis class returned when ioredis is imported. This is used by
// cache.ts, redis.ts helpers, and any other module that calls redis.get/set.
class MockRedisClass {
  on() { return this; }
  async get(key: string) { return _redisGet(key); }
  async set(key: string, value: string, ...args: any[]) { return _redisSet(key, value, ...args); }
  async del(...keys: string[]) {
    let removed = 0;
    for (const k of keys) {
      if (_redisStore.has(k)) {
        _redisStore.delete(k);
        removed++;
      }
    }
    return removed;
  }
  async expire(_key: string, _ttl: number) { return 1; }
  async incr(key: string) {
    const current = parseInt(_redisGet(key) || '0', 10);
    const next = current + 1;
    _redisSet(key, String(next));
    return next;
  }
  async decr(key: string) {
    const current = parseInt(_redisGet(key) || '0', 10);
    const next = current - 1;
    _redisSet(key, String(next));
    return next;
  }
  async info() { return 'redis_version:mock'; }
  async flushdb() { _redisStore.clear(); return 'OK'; }
  async flushall() { _redisStore.clear(); return 'OK'; }
  async quit() { return 'OK'; }
  async ping() { return 'PONG'; }
  pipeline() { return this; }
  multi() { return this; }
  exec() { return []; }
}

// Function-based redis mock used for named exports in redis.ts (lockBet,
// unlockBet, etc.). The redis instance itself is replaced by an instance of
// MockRedisClass so cache.ts (redis.get/set) works.
const mockRedis = {
  // Instance-like methods used when Object.assign is called on the module
  // (kept for safety, although the instance is replaced by MockRedisClass).
  on() { return this; },
  async get(key: string) { return _redisGet(key); },
  async set(key: string, value: string, ...args: any[]) { return _redisSet(key, value, ...args); },
  async del(...keys: string[]) {
    let removed = 0;
    for (const k of keys) {
      if (_redisStore.has(k)) {
        _redisStore.delete(k);
        removed++;
      }
    }
    return removed;
  },
  async expire(_key: string, _ttl: number) { return 1; },
  async incr(key: string) {
    const current = parseInt(_redisGet(key) || '0', 10);
    const next = current + 1;
    _redisSet(key, String(next));
    return next;
  },
  async decr(key: string) {
    const current = parseInt(_redisGet(key) || '0', 10);
    const next = current - 1;
    _redisSet(key, String(next));
    return next;
  },
  async info() { return 'redis_version:mock'; },
  async flushdb() { _redisStore.clear(); return 'OK'; },
  async flushall() { _redisStore.clear(); return 'OK'; },
  async quit() { return 'OK'; },
  async ping() { return 'PONG'; },

  lockBet: async (userId: string, _amount: number) => {
    // Allow tests to disable locking via global flag (e.g. concurrency tests
    // that want to verify the DB row-lock fallback).
    if ((global as any).__DISABLE_BET_LOCK__) return true;
    if (_activeBetLocks.has(userId)) return false;
    _activeBetLocks.add(userId);
    return true;
  },
  unlockBet: async (userId: string) => {
    _activeBetLocks.delete(userId);
  },
  incrementWinStreak: async (_userId: string) => 1,
  resetWinStreak: async (_userId: string) => {},
  setWithdrawalLock: async (_id: string, _ttl: number) => true,
  releaseWithdrawalLock: async (_id: string) => {},
  isRateLimited: async (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    const bucket = MOCK_RATE_LIMIT_BUCKETS.get(key);
    if (!bucket || bucket.resetAt < now) {
      MOCK_RATE_LIMIT_BUCKETS.set(key, { count: 1, resetAt: now + windowMs });
      return { limited: false, remaining: max - 1, resetAt: now + windowMs };
    }
    if (bucket.count >= max) {
      return { limited: true, remaining: 0, resetAt: bucket.resetAt };
    }
    bucket.count++;
    return { limited: false, remaining: max - bucket.count, resetAt: bucket.resetAt };
  },
};

// ── Module-level require interceptor ───────────────────────────

const originalRequire = Module.prototype.require as any;

let modulesInstalled = false;

export function installCommonMocks(options?: {
  flipOutcome?: 'heads' | 'tails';
}) {
  if (modulesInstalled) return;
  modulesInstalled = true;

  let mockOutcomeResult: 'heads' | 'tails' = options?.flipOutcome || 'heads';
  (global as any).__MOCK_OUTCOME__ = () => mockOutcomeResult;
  (global as any).__SET_MOCK_OUTCOME__ = (r: 'heads' | 'tails') => { mockOutcomeResult = r; };

  // Capture original provably-fair exports (lazy to avoid path issues)
  let originalProvablyFair: any = {};
  const tryRequire = (modPath: string) => {
    try {
      return originalRequire.call(Module.prototype, modPath) as any;
    } catch (_) {
      return undefined;
    }
  };
  originalProvablyFair = tryRequire(require.resolve('../../services/provably-fair'))
    || tryRequire('../../services/provably-fair')
    || tryRequire('../services/provably-fair')
    || {};

  // If Module.prototype.require is already wrapped (e.g. by a test that
  // installed its own interceptor), chain to it as the fallback so we
  // don't break the test's mocks for ioredis / reconciliation / etc.
  const previousRequire = (Module.prototype as any).require;
  const isAlreadyWrapped = previousRequire && previousRequire !== originalRequire;

  Module.prototype.require = function (id: string) {
    if (id === 'ioredis') {
      return MockRedisClass;
    }

    if (id === 'bullmq') {
      return {
        Queue: class MockQueue {
          add = async () => {};
          close = async () => {};
        },
        Worker: class MockWorker {
          on = () => {};
          close = async () => {};
        },
      };
    }

    if (id === './provably-fair' || id === '../services/provably-fair') {
      if ((global as any).__TEST_USE_REAL_PROVABLY_FAIR__) {
        return originalRequire.apply(this, arguments as any);
      }
      return {
        ...originalProvablyFair,
        resolveFlip: (seeds: any, choice: any, betAmount: any, houseEdge: any, targetMultiplier: any) => {
          const won = choice === mockOutcomeResult;
          const tm = targetMultiplier || 2;
          const payout = won ? parseFloat((betAmount * tm * (1 - houseEdge / 100)).toFixed(8)) : 0;
          return {
            result: mockOutcomeResult,
            rawHash: 'mock-hash',
            rawValue: mockOutcomeResult === 'heads' ? 0 : 1,
            serverSeedHash: seeds.serverSeedHash,
            payout,
            houseEdge,
            winChance: (100 - houseEdge) / tm,
            targetMultiplier: tm,
            actualMultiplier: tm,
            won,
          };
        },
      };
    }

    if (id === './server-seed' || id === '../services/server-seed') {
      return {
        ensureActiveSeed: async () => {},
        reserveNonce: async () => ({
          seedId: '11111111-1111-1111-1111-111111111111',
          serverSeedHash: 'mock-seed-hash',
          nonce: 1,
        }),
        getSeedSecretById: async () => ({
          serverSeed: 'mock-server-seed',
          serverSeedHash: 'mock-seed-hash',
        }),
        getActiveSeed: async () => ({
          id: '11111111-1111-1111-1111-111111111111',
          server_seed_hash: 'mock-seed-hash',
          current_nonce: 0,
        }),
        rotateSeed: async () => ({
          id: '22222222-2222-2222-2222-222222222222',
          server_seed_hash: 'new-mock-hash',
        }),
        getRevealedSeeds: async () => [],
      };
    }
    // ── Reconciliation engine (returned real engine if requested) ──
    if (id === './reconciliation-engine' || id === '../services/reconciliation-engine') {
      if ((global as any).__TEST_USE_REAL_RECONCILIATION__) {
        return originalRequire.apply(this, arguments as any);
      }
      return {
        reconcileUser: async (_userId: string, _client?: any) => ({
          userId: _userId,
          isValid: true,
          userBalance: { expected: 0, actual: 0, mismatch: 0 },
          walletBalances: [],
          frozen: false
        })
      };
    }

    if (id === './bonus' || id === '../services/bonus') {
      const original = originalRequire.call(this, id);
      return {
        ...original,
        // Pass-through for real functions; tests can override by passing txClient
      };
    }

    if (id === './jackpot-pool' || id === '../services/jackpot-pool') {
      return {
        rollJackpot: async () => ({ won: false, amount: 0, roll: 0.5 }),
        getCurrentPool: async () => 0,
      };
    }

    if (id === './dispatcher' || id === '../services/dispatcher') {
      return {
        dispatchWebhook: async (_type: string, _payload: any) => true,
        dispatchAll: async () => ({ sent: 0, failed: 0 }),
      };
    }

    if (id === './lightning' || id === '../services/lightning') {
      return {
        tryLightningStrike: async (_betAmount: number) => ({ triggered: false, extraPayout: 0 }),
      };
    }

    if (isAlreadyWrapped) {
      return previousRequire.call(this, id);
    }
    return originalRequire.apply(this, arguments as any);
  };

  // Install database mock via dynamic require
  const dbModule = tryRequire(require.resolve('../../config/database'))
    || tryRequire('../../config/database')
    || tryRequire('../config/database');
  const mockDb = {
    connect: async () => ({
      // Use dbModule.query dynamically so tests can override the query function
      query: async (text: string, params?: any[]) => (dbModule.query as any)(text, params || []),
      release: () => {},
    }),
    query: async (text: string, params?: any[]) => mockQuery(text, params || []),
  };
  dbModule.db = mockDb;
  dbModule.query = mockQuery;
  dbModule.withTransaction = async <T>(fn: (txQuery: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>) => Promise<T>): Promise<T> => {
    const client = await mockDb.connect();
    try {
      await client.query('BEGIN', []);
      const result = await fn(async (text: string, params?: unknown[]) => {
        const r = await client.query(text, params as any[]);
        return { rows: r.rows || [], rowCount: r.rowCount ?? 0 };
      });
      await client.query('COMMIT', []);
      return result;
    } catch (err) {
      await client.query('ROLLBACK', []);
      throw err;
    } finally {
      client.release();
    }
  };

  // Install redis mock — replace the exported redis instance so cache.ts
  // helpers (getOrSet, setCache, etc.) use the in-memory store.
  const redisModule = tryRequire(require.resolve('../../config/redis'))
    || tryRequire('../../config/redis')
    || tryRequire('../config/redis');
  // Replace the `redis` instance with our own MockRedisClass instance and
  // overlay the named helper functions (lockBet, unlockBet, etc.).
  redisModule.redis = new MockRedisClass();
  Object.assign(redisModule, mockRedis);
}

// ── Reset helpers ──────────────────────────────────────────────

export function resetAllMocks() {
  MOCK_USERS.length = 0;
  MOCK_BETS.length = 0;
  MOCK_SETTINGS.length = 0;
  MOCK_TRANSACTIONS.length = 0;
  MOCK_BONUS_CLAIMS.length = 0;
  MOCK_GAME_SEEDS.length = 0;
  MOCK_WALLETS.length = 0;
  MOCK_WITHDRAWALS.length = 0;
  MOCK_AFFILIATES.length = 0;
  MOCK_FRAUD_FLAGS.length = 0;
  MOCK_AUDIT_LOGS.length = 0;
  MOCK_KYC_RECORDS.length = 0;
  MOCK_TOTP_SECRETS.length = 0;
  MOCK_RATE_LIMIT_BUCKETS.clear();
  MOCK_NOTIFICATIONS.length = 0;
  MOCK_WEBHOOKS.length = 0;
  queryInterceptor = null;
  txSnapshotUsers = null;
  txSnapshotBets = null;
  txSnapshotTransactions = null;
  txSnapshotWallets = null;
  txSnapshotBonusClaims = null;
  txSnapshotWithdrawals = null;
}

export { mockQuery, mockRedis };