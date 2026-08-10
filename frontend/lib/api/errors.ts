/**
 * Frontend error sanitizer (Sprint 1 / Phase 2.1 / P0-06 partial)
 *
 *  The backend can surface raw Postgres error strings when a query
 *  hits a schema-drift condition (e.g. "column \"confirmed_at\" of
 *  relation \"transactions\" does not exist"). The audit's P0-06
 *  partial from 2026-08-03 documented this; the fix is a thin
 *  client-side filter that swaps the raw text for a generic
 *  message before rendering.
 *
 *  The audit log server-side still records the original error via
 *  audit_log entries, so engineering can debug from the API logs
 *  or the admin Audit Log panel.
 *
 *  Patterns matched (case-insensitive):
 *    - "column \"X\" of relation \"Y\" does not exist"     (P0-06)
 *    - "relation \"X\" does not exist"
 *    - "function X does not exist" / "operator does not exist"
 *    - "syntax error at or near"     (developer typo, not user-visible)
 *    - "permission denied for ..."
 *    - Raw "PG" / "Postgres" / "pg_catalog" leaks
 *    - Long raw stack-trace lines (>300 chars) — almost always a
 *      Postgres/Python error dump
 */

const SCHEMA_DRIFT_PATTERNS: RegExp[] = [
  /column\s+["\w]+\s+(?:of\s+relation\s+["\w]+\s+)?does not exist/i,
  /relation\s+["\w]+\s+does not exist/i,
  /function\s+\S+\s+does not exist/i,
  /operator\s+does not exist/i,
  /syntax error at or near/i,
  /permission denied for/i,
  /unrecognized configuration parameter/i,
  /\bpg_catalog\b/i,
  /\bPostgresError\b/,
  /\bnode_modules[\/\\]pg\b/,
];

const STACK_LINE_HINT = /at\s+\S+\s+\([^)]+:\d+:\d+\)/;

/**
 * Returns true if the error text looks like a raw Postgres / pg stack-trace.
 */
export function looksLikeDbError(err: string | undefined | null): boolean {
  if (!err) return false;
  if (SCHEMA_DRIFT_PATTERNS.some((re) => re.test(err))) return true;
  if (err.length > 300 && STACK_LINE_HINT.test(err)) return true;
  return false;
}

/**
 * Sanitize an error string for display. Schema-drift / DB internals
 * are replaced with a generic message. Other errors pass through
 * unchanged. The original error is still logged to the console for
 * engineering to pick up.
 */
export function sanitizeError(err: string | undefined | null): string {
  if (!err) return 'Unknown error';
  if (looksLikeDbError(err)) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[sanitizeError] raw DB error suppressed:', err.slice(0, 200));
    }
    return 'Schema drift detected — please contact engineering';
  }
  return err;
}
