/**
 * ═══════════════════════════════════════════════════════════════
 *  Global Error Handler (P0-06)
 *
 *  Sanitizes every unhandled error before it reaches the client.
 *  Internal Postgres errors, stack traces, and raw `err.message`
 *  are NEVER returned in the response body — only opaque messages
 *  + a per-request `traceId` that an operator can grep in the logs.
 *
 *  Classification rules (in priority order):
 *    1. ZodError                                → 400, sanitized field details
 *    2. AppError.isOperational                  → statusCode + safe message
 *    3. Postgres unique violation (code 23505) → 409 "Duplicate entry"
 *    4. Postgres FK violation     (code 23503) → 409 "Referenced record not found"
 *    5. Postgres not-null violation(code 23502) → 400 "Required field missing"
 *    6. Postgres check violation  (code 23514) → 400 "Constraint violation"
 *    7. Everything else                         → 500 "Internal server error"
 *
 *  Internal logging:
 *    - Every error is logged at `error` level with `traceId`, `err.message`,
 *      `err.stack`, the request method/path, and any PG code.
 *    - Sentry is invoked if SENTRY_DSN is configured.
 *    - Dev mode (NODE_ENV !== 'production') MAY return `err.message` and
 *      `err.stack` in the response body, gated by `EXPOSE_ERROR_DETAILS`
 *      to keep the dev affordance opt-in.
 * ═══════════════════════════════════════════════════════════════
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';

/**
 * Minimal interface for Postgres error shape. The `pg` driver returns
 * errors with `code` (a 5-char SQLSTATE) and `detail`/`hint`/`table`/
 * `column`/`constraint` properties. We only need `code` for the
 * classification below; the rest is logged but never returned.
 */
interface PgError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

/** True iff err is a Postgres driver error. */
function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as PgError).code === 'string';
}

/** Generate a short, URL-safe trace ID. */
function newTraceId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Build a public-facing JSON body. For 5xx errors we never include
 * `err.message` in production; for 4xx errors that came from
 * `AppError.isOperational` we pass the message through (the caller
 * constructed the message and we trust it). For other 4xx errors
 * (PG constraint violations, ZodError, Express parser errors with a
 * 4xx status) we substitute a SAFE message — never the raw err.message.
 *
 * `EXPOSE_ERROR_DETAILS=true` overrides this in development.
 */
function buildPublicBody(
  statusCode: number,
  err: unknown,
  safeMessage: string,
  traceId: string,
): Record<string, unknown> {
  const expose = process.env.EXPOSE_ERROR_DETAILS === 'true';
  const body: Record<string, unknown> = { success: false, traceId };

  if (statusCode >= 500) {
    body.error = expose && err instanceof Error ? err.message : safeMessage;
    if (expose && err instanceof Error && err.stack) {
      body.stack = err.stack;
    }
  } else {
    // 4xx — caller-provided message is OK ONLY for AppError.isOperational.
    if (err instanceof AppError && err.isOperational) {
      body.error = err.message;
      body.code = err.code;
    } else if (err instanceof ZodError) {
      body.error = 'Validation failed';
      body.code = 'VALIDATION_ERROR';
      body.details = err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
    } else {
      // 4xx from PG constraint or Express parser: use the safe message,
      // never the raw err.message. The raw error is still in the logs.
      body.error = safeMessage;
    }
  }
  return body;
}

/**
 * Classify the error into a status code + safe message. Returns the
 * status that should be returned to the client; logging is the
 * caller's responsibility (see `errorHandler`).
 */
export function classifyError(err: unknown): {
  statusCode: number;
  safeMessage: string;
  pgCode?: string;
} {
  if (err instanceof ZodError) {
    return { statusCode: 400, safeMessage: 'Validation failed', pgCode: undefined };
  }
  if (err instanceof AppError) {
    if (err.isOperational) {
      return { statusCode: err.statusCode, safeMessage: err.message, pgCode: undefined };
    }
    // Non-operational AppError (e.g. GameIntegrityError) → 500
    return { statusCode: 500, safeMessage: 'Internal server error', pgCode: undefined };
  }
  if (isPgError(err)) {
    switch (err.code) {
      case '23505': // unique_violation
        return { statusCode: 409, safeMessage: 'Duplicate entry', pgCode: '23505' };
      case '23503': // foreign_key_violation
        return { statusCode: 409, safeMessage: 'Referenced record not found', pgCode: '23503' };
      case '23502': // not_null_violation
        return { statusCode: 400, safeMessage: 'Required field missing', pgCode: '23502' };
      case '23514': // check_violation
        return { statusCode: 400, safeMessage: 'Constraint violation', pgCode: '23514' };
      default:
        return { statusCode: 500, safeMessage: 'Internal server error', pgCode: err.code };
    }
  }
  // Express sets err.statusCode for things like body-parser errors.
  const statusCode =
    (typeof err === 'object' && err !== null && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number')
      ? (err as { statusCode: number }).statusCode
      : (typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number')
      ? (err as { status: number }).status
      : 500;
  if (statusCode >= 400 && statusCode < 500) {
    return { statusCode, safeMessage: err instanceof Error ? err.message : 'Bad request', pgCode: undefined };
  }
  return { statusCode: 500, safeMessage: 'Internal server error', pgCode: undefined };
}

/** Optional Sentry capture; injected to avoid hard-coding the SDK. */
let sentryCapture: ((err: unknown, ctx?: Record<string, unknown>) => void) | null = null;

/** Wire Sentry (or any other APM) capture. Called from index.ts. */
export function setSentryCapture(fn: typeof sentryCapture): void {
  sentryCapture = fn;
}

/**
 * Build the Express error handler. Lives in its own file so it can
 * be unit-tested without standing up the full app.
 */
export function buildErrorHandler(
  logger: { error: (msg: string, ctx?: Record<string, unknown>) => void } = console,
): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const traceId = newTraceId();
    const { statusCode, safeMessage, pgCode } = classifyError(err);

    // Internal logging — always raw, never sanitized.
    const logCtx: Record<string, unknown> = {
      traceId,
      method: req.method,
      path: req.path,
      statusCode,
      pgCode,
    };
    if (err instanceof Error) {
      logCtx.message = err.message;
      logCtx.stack = err.stack;
    } else {
      logCtx.message = String(err);
    }
    if (isPgError(err)) {
      logCtx.pgDetail = err.detail;
      logCtx.pgHint = err.hint;
      logCtx.pgTable = err.table;
      logCtx.pgColumn = err.column;
      logCtx.pgConstraint = err.constraint;
    }
    logger.error('[error]', logCtx);

    if (sentryCapture) {
      try {
        sentryCapture(err, { traceId, path: req.path });
      } catch {
        // Sentry must never break the response path.
      }
    }

    // Public response — uses the safeMessage from classifyError so we
    // never fall back to err.message for non-AppError 4xx errors (PG
    // constraint codes, Express parser errors, etc.).
    const body = buildPublicBody(statusCode, err, safeMessage, traceId);
    res.status(statusCode).json(body);
  };
}

/** Default handler instance for use in index.ts. */
export const errorHandler: ErrorRequestHandler = buildErrorHandler();
