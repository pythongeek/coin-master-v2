/**
 * P0-1 — KYC national-ID / passport uniqueness guard.
 *
 *  Before insert into kyc_submissions, compute SHA-256(normalized doc #
 *  for the given document_type). The DB has partial UNIQUE indexes
 *  on (national_id_hash, passport_hash) WHERE status='approved', so
 *  the LAST line of defence is the index — but normalizing here
 *  means "AB-12 3456" and "AB123456" are treated as the same ID,
 *  not two different ones.
 *
 *  Public API:
 *    - normalizeDocNumber(raw)  → uppercase, alphanumeric only
 *    - hashDoc(raw)             → 64-char hex SHA-256
 *    - insertSubmission(...)    → handles 23505 unique-violation,
 *                                  translates to FINGERPRINT_DUPLICATE
 *                                  fraud signal + audit row.
 */

import { createHash } from 'crypto';
import { query } from '../config/database';

/**
 * Normalize a document number for hashing.
 *
 * Examples:
 *   "AB-12 3456"   → "AB123456"
 *   "ab123456 "    → "AB123456"
 *   "护照-9001"    → "9001"  (ASCII-only path; non-ascii skipped
 *                              intentionally — best-effort fallback
 *                              for non-Latin scripts is documented in
 *                              doc as P3 follow-up)
 */
export function normalizeDocNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  // Take only 0-9 + A-Z. Drops dashes, spaces, slashes, accents.
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashDoc(raw: string | null | undefined): string | null {
  const norm = normalizeDocNumber(raw);
  if (!norm) return null;
  return createHash('sha256').update(norm).digest('hex');
}

/**
 * Detect document_type → which hash column to populate.
 * Falls back to 'national_id_hash' for unknown types (safe default:
 * the existing partial unique index catches it either way).
 */
function pickHashColumn(
  documentType: string | null | undefined,
): 'national_id_hash' | 'passport_hash' {
  if (!documentType) return 'national_id_hash';
  const t = documentType.toLowerCase();
  if (t.includes('passport')) return 'passport_hash';
  return 'national_id_hash';  // national_id, id_card, drivers_license, etc.
}

/**
 * Submit a KYC document with hash-uniqueness guard.
 *
 * Returns the inserted row OR throws FingerprintDuplicateError if
 * the same hash already exists with status='approved'.
 *
 * IMPORTANT: This wraps the existing kyc_submissions INSERT path.
 * Routes that previously called `query("INSERT INTO kyc_submissions ...")`
 * should be migrated to use this. Until then, the DB partial unique
 * index still catches duplicates — only the friendly error mapping
 * is missing.
 */
export class FingerprintDuplicateError extends Error {
  readonly hash: string;
  readonly column: string;
  readonly existingUserId: string | null;
  constructor(hash: string, column: string, existingUserId: string | null) {
    super(
      `FINGERPRINT_DUPLICATE: KYC document matches an already-approved submission ` +
      `(${column}) on user=${existingUserId ?? 'unknown'}`,
    );
    this.name = 'FingerprintDuplicateError';
    this.hash = hash;
    this.column = column;
    this.existingUserId = existingUserId;
  }
}

export interface KYCSubmissionInput {
  userId: string;
  documentType: string;
  documentNumber: string;
  documentCountry: string;
}

export interface KYCSubmissionRow {
  id: string;
  user_id: string;
  status: string;
  national_id_hash: string | null;
  passport_hash: string | null;
  submitted_at: string;
}

/**
 * Insert a new KYC submission with hash-uniqueness check.
 * Throws FingerprintDuplicateError if the same ID is already
 * approved for another user.
 */
export async function submitKYCSafe(
  input: KYCSubmissionInput,
): Promise<KYCSubmissionRow> {
  const hash = hashDoc(input.documentNumber);
  if (!hash) {
    throw new Error('INVALID_DOCUMENT_NUMBER');
  }
  const column = pickHashColumn(input.documentType);

  // 1. Pre-check (race-safe via partial unique index as final guard)
  const dup = await query(
    `SELECT user_id
       FROM kyc_submissions
      WHERE ${column} = $1
        AND status = 'approved'
      LIMIT 1`,
    [hash],
  );
  if (dup.rows.length > 0) {
    const existingUserId = String((dup.rows[0] as { user_id: string }).user_id);
    await flagDuplicateAttempt(input.userId, existingUserId, column, hash);
    throw new FingerprintDuplicateError(hash, column, existingUserId);
  }

  // 2. Insert with hash. If a concurrent INSERT slipped through
  //    (TOCTOU), the partial unique index returns 23505 — we
  //    catch that and treat it like a duplicate too.
  try {
    const ins = await query(
      `INSERT INTO kyc_submissions
         (user_id, status, document_type, document_number, document_country,
          national_id_hash, passport_hash)
       VALUES ($1, 'pending', $2, $3, $4,
               CASE WHEN $5 = 'national_id_hash' THEN $6 ELSE NULL END,
               CASE WHEN $5 = 'passport_hash'    THEN $6 ELSE NULL END)
       RETURNING id, user_id, status, national_id_hash, passport_hash, submitted_at`,
      [input.userId, input.documentType, input.documentNumber, input.documentCountry,
       column, hash],
    );
    return ins.rows[0] as KYCSubmissionRow;
  } catch (e: unknown) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505' &&
        (err.constraint === 'idx_kyc_national_id_hash_unique' ||
         err.constraint === 'idx_kyc_passport_hash_unique')) {
      // Race: another submission won. Look up the winner.
      const winner = await query(
        `SELECT user_id FROM kyc_submissions
          WHERE ${column} = $1 AND status = 'approved' LIMIT 1`,
        [hash],
      );
      const existingUserId = winner.rows.length
        ? String((winner.rows[0] as { user_id: string }).user_id)
        : null;
      await flagDuplicateAttempt(input.userId, existingUserId, column, hash);
      throw new FingerprintDuplicateError(hash, column, existingUserId);
    }
    throw e;
  }
}

/**
 * When a duplicate attempt is detected, drop a fraud signal + audit row
 * AND flag BOTH accounts as suspicious. The admin can clear the false
 * positives if the duplicate is a system error.
 */
async function flagDuplicateAttempt(
  userId: string,
  otherUserId: string | null,
  column: string,
  hash: string,
): Promise<void> {
  try {
    // Drop a fraud_signals row (existing table from migration 006)
    await query(
      `INSERT INTO fraud_signals (user_id, signal_type, severity, metadata)
       VALUES ($1, 'multi_account', 'high',
               jsonb_build_object(
                 'source', 'kyc_id_uniqueness',
                 'matched_column', $2,
                 'matched_hash_prefix', substring($3::text, 1, 16),
                 'matched_user_id', $4
               ))`,
      [userId, column, hash, otherUserId],
    );

    // Flag the attempted user + the existing one (if any) as suspicious.
    await query(
      `UPDATE users
          SET is_suspicious       = TRUE,
              suspicious_reason   = COALESCE(suspicious_reason, '') ||
                                    CASE WHEN suspicious_reason IS NULL OR suspicious_reason = ''
                                         THEN '' ELSE '; ' END ||
                                    'kyc_id_dup_v027',
              suspicious_flagged_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [[userId, otherUserId].filter(Boolean)],
    );

    // Audit trail
    await query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('kyc', 'kyc.duplicate_detected', 'error', $1, $2)`,
      [
        userId,
        JSON.stringify({
          attempted_user: userId,
          existing_user: otherUserId,
          matched_column: column,
          hash_prefix: hash.slice(0, 16),
        }),
      ],
    );

    // Phase 1.5: emit alert. KYC duplicates are the strongest fraud
    // signal we have — always critical.
    try {
      const { alertKycDuplicate } = await import('./fraud-alerts');
      await alertKycDuplicate(userId, otherUserId ?? userId, column as 'national_id_hash' | 'passport_hash');
    } catch { /* best-effort */ }
  } catch (e) {
    // Never let the audit/flag chain break the KYC insert path.
    // Log and continue — uniqueness is the primary defense.
    // eslint-disable-next-line no-console
    console.error('[kyc-uniqueness] flag-duplicate failed:', e);
  }
}
