/**
 * Phase 2.1 unit tests for the frontend error sanitizer.
 *
 * Run with: cd frontend && npx jest lib/api/__tests__/errors.test.ts
 *   (or however the frontend test runner is configured)
 *
 * If the frontend has no test runner, this file is documentation of
 * intent — the same logic is exercised manually via the live UI in
 * Phase 2.1 verification.
 */
import { describe, it, expect } from '@jest/globals';
import { sanitizeError, looksLikeDbError } from '../errors';

describe('sanitizeError', () => {
  it('returns "Unknown error" for empty/null inputs', () => {
    expect(sanitizeError(null)).toBe('Unknown error');
    expect(sanitizeError(undefined)).toBe('Unknown error');
    expect(sanitizeError('')).toBe('Unknown error');
  });

  it('returns generic message for column-does-not-exist errors', () => {
    const raw = 'column "confirmed_at" of relation "transactions" does not exist';
    expect(sanitizeError(raw)).toBe('Schema drift detected — please contact engineering');
  });

  it('returns generic message for relation-does-not-exist errors', () => {
    expect(sanitizeError('relation "users" does not exist')).toBe(
      'Schema drift detected — please contact engineering',
    );
  });

  it('returns generic message for function/operator missing', () => {
    expect(sanitizeError('function crypt(text) does not exist')).toBe(
      'Schema drift detected — please contact engineering',
    );
    expect(sanitizeError('operator does not exist: integer = text')).toBe(
      'Schema drift detected — please contact engineering',
    );
  });

  it('returns generic message for permission denied', () => {
    expect(sanitizeError('permission denied for table transactions')).toBe(
      'Schema drift detected — please contact engineering',
    );
  });

  it('returns generic message for pg_catalog / pg-node leaks', () => {
    expect(sanitizeError('relation pg_catalog.pg_user does not exist')).toBe(
      'Schema drift detected — please contact engineering',
    );
  });

  it('returns generic message for long stack-trace lines', () => {
    const stacky = 'Error: column "x" does not exist at /app/node_modules/pg/lib/client.js:652:17 at process.processTicksAndRejections';
    expect(sanitizeError(stacky)).toBe('Schema drift detected — please contact engineering');
  });

  it('passes through normal user-facing errors', () => {
    expect(sanitizeError('withdrawal is in pending state; only payout_stuck can be resolved')).toBe(
      'withdrawal is in pending state; only payout_stuck can be resolved',
    );
    expect(sanitizeError('Insufficient Admin 2FA token')).toBe('Insufficient Admin 2FA token');
    expect(sanitizeError('Invalid request: amount must be positive')).toBe(
      'Invalid request: amount must be positive',
    );
  });

  it('passes through short error messages with "stack" hints but no DB markers', () => {
    const short = 'at runQuery (file:10)';
    expect(looksLikeDbError(short)).toBe(false);
    expect(sanitizeError(short)).toBe(short);
  });
});
