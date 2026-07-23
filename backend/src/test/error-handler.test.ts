/**
 * P0-06 focused test: global error handler sanitization.
 *
 * The previous global handler returned `err.message` verbatim on 500
 * responses, leaking Postgres column/table names and partial SQL. Several
 * admin/dashboard routes had the same leak in inline catch blocks.
 *
 * This test confirms the new contract:
 *
 *   1. Generic Error → 500, body has only `success: false`, `error: 'Internal server error'`,
 *      and a hex `traceId`. NO `err.message`, NO stack, NO table/column refs.
 *   2. Postgres unique violation (code 23505) → 409 "Duplicate entry".
 *   3. Postgres FK violation (code 23503) → 409 "Referenced record not found".
 *   4. Postgres not-null violation (code 23502) → 400 "Required field missing".
 *   5. Postgres check violation (code 23514) → 400 "Constraint violation".
 *   6. AppError.isOperational → uses err.statusCode + err.message + err.code.
 *   7. AppError.isOperational=false (e.g. GameIntegrityError) → 500 "Internal server error"
 *      (NOT the raw message — non-operational means internal error).
 *   8. ZodError → 400 with sanitized field details.
 *   9. Errors are logged internally with traceId, err.message, err.stack, status, method, path.
 *  10. Sentry capture is invoked when configured (and ignored if not).
 *  11. EXPOSE_ERROR_DETAILS=true includes err.message+stack in the response (dev affordance).
 *  12. EXPOSE_ERROR_DETAILS unset / !='true' → no err.message leak in 5xx responses.
 *  13. Route-level `next(err)` works — the global handler picks up the error.
 */

import Module from 'module';
import fs from 'fs';
import path from 'path';

let failed = false;
function assert(cond: boolean, msg: string) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log('✅', msg);
  } else {
    // eslint-disable-next-line no-console
    console.error('❌', msg);
    failed = true;
  }
}

interface LogCall {
  msg: string;
  ctx?: Record<string, unknown>;
}
const capturedLogs: LogCall[] = [];
const testLogger = {
  error: (msg: string, ctx?: Record<string, unknown>) => {
    capturedLogs.push({ msg, ctx });
  },
};

// Stub ioredis and config/database BEFORE requiring the handler.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async connect() { return this; }
      async quit() { return 'OK'; }
      async disconnect() { return 'OK'; }
      async get() { return null; }
      async set() { return 'OK'; }
      async incr() { return 1; }
      async del() { return 1; }
      async expire() { return 1; }
    };
  }
  return originalRequire.apply(this, arguments as unknown as [string]);
};

import { buildErrorHandler, classifyError, setSentryCapture } from '../middleware/error-handler';
import { AppError, SecurityError, ValidationError, InsufficientBalanceError, GameIntegrityError } from '../utils/errors';
import { ZodError, z } from 'zod';

interface MockRes {
  statusCode: number;
  body: any;
  status(c: number): MockRes;
  json(b: any): MockRes;
}
function makeRes(): MockRes {
  return {
    statusCode: 200,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
}
function makeReq(method: string = 'GET', p: string = '/test'): any {
  return { method, path: p };
}

let sentryCalls = 0;
let lastSentryError: any = null;
let lastSentryCtx: any = null;
setSentryCapture((err, ctx) => {
  sentryCalls++;
  lastSentryError = err;
  lastSentryCtx = ctx;
});

// ---------------------------------------------------------------------------
// 1. classifyError — pure-function contract tests
// ---------------------------------------------------------------------------
function makePgError(message: string, code: string): Error & { code: string } {
  const err: any = new Error(message);
  err.code = code;
  err.detail = 'Key (id)=(123) already exists.';
  err.table = 'audit_log';
  err.column = 'id';
  return err;
}

const clsGeneric = classifyError(new Error('relation "users_secret_col" does not exist'));
assert(clsGeneric.statusCode === 500,
  `classifyError(generic Error) → 500 (got: ${clsGeneric.statusCode})`);

const clsUnique = classifyError(makePgError('duplicate key value violates unique constraint', '23505'));
assert(clsUnique.statusCode === 409,
  `classifyError(PG 23505) → 409 (got: ${clsUnique.statusCode})`);
assert(clsUnique.safeMessage === 'Duplicate entry',
  `classifyError(PG 23505) message is "Duplicate entry" (got: "${clsUnique.safeMessage}")`);

const clsFk = classifyError(makePgError('foreign key violation', '23503'));
assert(clsFk.statusCode === 409,
  `classifyError(PG 23503) → 409 (got: ${clsFk.statusCode})`);

const clsNotNull = classifyError(makePgError('null value in column "email"', '23502'));
assert(clsNotNull.statusCode === 400,
  `classifyError(PG 23502) → 400 (got: ${clsNotNull.statusCode})`);

const clsCheck = classifyError(makePgError('violates check constraint', '23514'));
assert(clsCheck.statusCode === 400,
  `classifyError(PG 23514) → 400 (got: ${clsCheck.statusCode})`);

const clsAppOp = classifyError(new ValidationError('bad input'));
assert(clsAppOp.statusCode === 400,
  `classifyError(AppError isOperational) → statusCode (got: ${clsAppOp.statusCode})`);

const clsAppNonOp = classifyError(new GameIntegrityError('seed hash mismatch — internal'));
assert(clsAppNonOp.statusCode === 500,
  `classifyError(AppError isOperational=false) → 500 (got: ${clsAppNonOp.statusCode})`);
assert(clsAppNonOp.safeMessage === 'Internal server error',
  `classifyError(AppError isOperational=false) message is sanitized (got: "${clsAppNonOp.safeMessage}")`);

// ZodError
const zodParse = z.object({ name: z.string() }).safeParse({ name: 123 });
if (!zodParse.success) {
  const clsZod = classifyError(zodParse.error);
  assert(clsZod.statusCode === 400,
    `classifyError(ZodError) → 400 (got: ${clsZod.statusCode})`);
} else {
  assert(false, 'Zod parse unexpectedly succeeded');
}

// ---------------------------------------------------------------------------
// 2. Handler behavior — response body is sanitized
// ---------------------------------------------------------------------------
const handler = buildErrorHandler(testLogger);

function runHandler(err: unknown, method: string = 'GET', path: string = '/test'): MockRes {
  const res = makeRes();
  capturedLogs.length = 0;
  sentryCalls = 0;
  handler(err, makeReq(method, path) as any, res as any, (() => {}) as any);
  return res;
}

// ── Case A: generic Error → sanitized 500 ──
const resA = runHandler(new Error('relation "users_secret_col" does not exist'));
assert(resA.statusCode === 500,
  `generic Error → 500 (got: ${resA.statusCode})`);
assert(resA.body.success === false, 'response body has success: false');
assert(resA.body.error === 'Internal server error',
  `response body.error === 'Internal server error' (got: "${resA.body.error}")`);
assert(typeof resA.body.traceId === 'string' && resA.body.traceId.length === 16,
  `response body has a 16-char hex traceId (got: "${resA.body.traceId}")`);
assert(!('message' in resA.body), 'response body has no raw "message" key');
assert(!('stack' in resA.body), 'response body has no raw "stack" key');
assert(!('detail' in resA.body), 'response body has no raw "detail" key');
assert(!('table' in resA.body), 'response body has no raw "table" key');
assert(!('column' in resA.body), 'response body has no raw "column" key');
const bodyStrA = JSON.stringify(resA.body);
assert(!bodyStrA.includes('users_secret_col'),
  'response body does NOT contain "users_secret_col" (the leaked table ref)');
assert(!bodyStrA.includes('does not exist'),
  'response body does NOT contain the raw error substring');

// Internal logging captured the raw error.
assert(capturedLogs.length === 1, 'exactly one log entry was emitted');
assert(capturedLogs[0].ctx?.traceId === resA.body.traceId,
  'log entry has the same traceId as the response');
assert(capturedLogs[0].ctx?.message === 'relation "users_secret_col" does not exist',
  `log entry contains raw err.message (got: "${capturedLogs[0].ctx?.message}")`);
assert(typeof capturedLogs[0].ctx?.stack === 'string',
  'log entry contains a stack trace');
assert(capturedLogs[0].ctx?.method === 'GET',
  `log entry contains request method (got: ${capturedLogs[0].ctx?.method})`);
assert(capturedLogs[0].ctx?.path === '/test',
  `log entry contains request path (got: ${capturedLogs[0].ctx?.path})`);

// Sentry capture was invoked.
assert(sentryCalls === 1, `Sentry capture was invoked once (got: ${sentryCalls})`);
assert(lastSentryError instanceof Error, 'Sentry received the Error instance');
assert(lastSentryCtx?.traceId === resA.body.traceId,
  'Sentry ctx includes traceId');

// ── Case B: PG 23505 → 409 "Duplicate entry" ──
const resB = runHandler(makePgError('duplicate key value violates unique constraint "audit_log_pkey"', '23505'));
assert(resB.statusCode === 409,
  `PG 23505 → 409 (got: ${resB.statusCode})`);
assert(resB.body.error === 'Duplicate entry',
  `PG 23505 body.error === 'Duplicate entry' (got: "${resB.body.error}")`);
const bodyStrB = JSON.stringify(resB.body);
assert(!bodyStrB.includes('audit_log_pkey'),
  'PG 23505 response does NOT include constraint name');
assert(!bodyStrB.includes('duplicate key'),
  'PG 23505 response does NOT include raw error substring');

// ── Case C: PG 23503 → 409 ──
const resC = runHandler(makePgError('insert or update on table "wallets" violates foreign key constraint "wallets_user_id_fkey"', '23503'));
assert(resC.statusCode === 409, `PG 23503 → 409 (got: ${resC.statusCode})`);
assert(resC.body.error === 'Referenced record not found',
  `PG 23503 body.error === 'Referenced record not found' (got: "${resC.body.error}")`);

// ── Case D: PG 23502 → 400 ──
const resD = runHandler(makePgError('null value in column "email" violates not-null constraint', '23502'));
assert(resD.statusCode === 400, `PG 23502 → 400 (got: ${resD.statusCode})`);
assert(resD.body.error === 'Required field missing',
  `PG 23502 body.error === 'Required field missing' (got: "${resD.body.error}")`);

// ── Case E: PG 23514 → 400 ──
const resE = runHandler(makePgError('new row for relation "users" violates check constraint "users_age_check"', '23514'));
assert(resE.statusCode === 400, `PG 23514 → 400 (got: ${resE.statusCode})`);
assert(resE.body.error === 'Constraint violation',
  `PG 23514 body.error === 'Constraint violation' (got: "${resE.body.error}")`);

// ── Case F: AppError.isOperational → statusCode + message + code ──
const resF = runHandler(new ValidationError('Invalid email format'));
assert(resF.statusCode === 400, `AppError(ValidationError) → 400 (got: ${resF.statusCode})`);
assert(resF.body.error === 'Invalid email format',
  `AppError body.error === 'Invalid email format' (got: "${resF.body.error}")`);
assert(resF.body.code === 'VALIDATION_ERROR',
  `AppError body.code === 'VALIDATION_ERROR' (got: "${resF.body.code}")`);

const resF2 = runHandler(new InsufficientBalanceError('Insufficient bonus balance: $0.50'));
assert(resF2.statusCode === 400, `InsufficientBalanceError → 400 (got: ${resF2.statusCode})`);
assert(resF2.body.error === 'Insufficient bonus balance: $0.50',
  `InsufficientBalanceError message preserved`);

const resF3 = runHandler(new SecurityError('KYC required'));
assert(resF3.statusCode === 403, `SecurityError → 403 (got: ${resF3.statusCode})`);
assert(resF3.body.code === 'SECURITY_VIOLATION',
  `SecurityError code === 'SECURITY_VIOLATION' (got: "${resF3.body.code}")`);

// ── Case G: AppError.isOperational=false → 500 sanitized ──
const resG = runHandler(new GameIntegrityError('seed hash mismatch — internal invariant violated'));
assert(resG.statusCode === 500,
  `GameIntegrityError (isOperational=false) → 500 (got: ${resG.statusCode})`);
assert(resG.body.error === 'Internal server error',
  `GameIntegrityError body.error sanitized (got: "${resG.body.error}")`);
assert(!JSON.stringify(resG.body).includes('seed hash'),
  'GameIntegrityError raw message NOT leaked');

// ── Case H: ZodError → 400 with sanitized field details ──
const zParse = z.object({
  username: z.string().min(3),
  email: z.string().email(),
  age: z.number().int().positive(),
}).safeParse({ username: 'ab', email: 'not-an-email', age: -5 });
if (!zParse.success) {
  const resH = runHandler(zParse.error);
  assert(resH.statusCode === 400, `ZodError → 400 (got: ${resH.statusCode})`);
  assert(resH.body.error === 'Validation failed',
    `ZodError body.error === 'Validation failed' (got: "${resH.body.error}")`);
  assert(resH.body.code === 'VALIDATION_ERROR',
    `ZodError body.code === 'VALIDATION_ERROR' (got: "${resH.body.code}")`);
  assert(Array.isArray(resH.body.details) && resH.body.details.length === 3,
    `ZodError body.details is an array of 3 issues (got: ${resH.body.details?.length})`);
  // Each detail must have path + message, but NOT a full stack trace.
  for (const d of resH.body.details) {
    assert(typeof d.path === 'string' && typeof d.message === 'string',
      `ZodError detail has path+message (got: ${JSON.stringify(d)})`);
    assert(!('stack' in d), 'ZodError detail has no stack field');
  }
} else {
  assert(false, 'Zod parse unexpectedly succeeded');
}

// ── Case I: tracing — distinct traceIds across requests ──
const resI1 = runHandler(new Error('boom 1'));
const resI2 = runHandler(new Error('boom 2'));
assert(resI1.body.traceId !== resI2.body.traceId,
  'each error response gets a unique traceId');

// ── Case J: source-level — handlers use next(err) not res.status(500).json ──
const adminAuditSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-audit.ts'), 'utf8');
assert(!/res\.status\(500\)\.json/.test(adminAuditSrc),
  'admin-audit.ts has NO res.status(500).json calls anymore');
assert(/next\(err\)/.test(adminAuditSrc),
  'admin-audit.ts uses next(err) for error propagation');
const adminEmailSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-email.ts'), 'utf8');
assert(!/res\.status\(500\)\.json/.test(adminEmailSrc),
  'admin-email.ts has NO res.status(500).json calls anymore');
const mlSrc = fs.readFileSync(path.join(__dirname, '../routes/ml-routes.ts'), 'utf8');
assert(!/res\.status\(500\)\.json/.test(mlSrc),
  'ml-routes.ts has NO res.status(500).json calls anymore');
const dashboardSrc = fs.readFileSync(path.join(__dirname, '../routes/dashboard.ts'), 'utf8');
assert(!/res\.status\(500\)\.json/.test(dashboardSrc),
  'dashboard.ts has NO res.status(500).json calls anymore');
const adminSrc = fs.readFileSync(path.join(__dirname, '../routes/admin.ts'), 'utf8');
assert(!/res\.status\(500\)\.json/.test(adminSrc),
  'admin.ts has NO res.status(500).json calls anymore');

// ── Case K: index.ts uses the new handler ──
const indexSrc = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8');
assert(/from ['"]\.\/middleware\/error-handler['"]/.test(indexSrc),
  'index.ts imports from ./middleware/error-handler');
assert(/app\.use\(errorHandler\)/.test(indexSrc),
  'index.ts mounts the new errorHandler');

// ── Case L: EXPOSE_ERROR_DETAILS gate ──
process.env.EXPOSE_ERROR_DETAILS = 'true';
const resL = runHandler(new Error('dev-only context: table=foo'));
assert(resL.body.error === 'dev-only context: table=foo',
  `EXPOSE_ERROR_DETAILS=true includes raw err.message in body.error (got: "${resL.body.error}")`);
assert(typeof resL.body.stack === 'string',
  'EXPOSE_ERROR_DETAILS=true includes raw err.stack in body');

delete process.env.EXPOSE_ERROR_DETAILS;
const resL2 = runHandler(new Error('prod leak test'));
assert(resL2.body.error === 'Internal server error',
  `without EXPOSE_ERROR_DETAILS, body.error is sanitized (got: "${resL2.body.error}")`);
assert(!('message' in resL2.body),
  'without EXPOSE_ERROR_DETAILS, body has no raw message');
assert(!('stack' in resL2.body),
  'without EXPOSE_ERROR_DETAILS, body has no raw stack');

// ── Case M: handler does not throw when downstream consumer is missing ──
// (just confirms the handler is resilient — it should never itself throw)
const resM = runHandler(undefined as any);
assert(resM.statusCode === 500, 'undefined error still produces 500');
assert(resM.body.error === 'Internal server error', 'undefined error body sanitized');

// ── Summary ──────────────────────────────────────────────────────────
console.log('');
if (failed) {
  console.error('❌ P0-06 tests FAILED');
  process.exit(1);
} else {
  console.log('🎉 All P0-06 error-handler-sanitization tests passed');
  process.exit(0);
}
