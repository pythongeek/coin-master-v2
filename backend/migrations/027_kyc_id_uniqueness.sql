-- =============================================================
--  Migration 027: KYC national-id & passport uniqueness (P0-1)
-- =============================================================
--  Block multi-account bonus farming where same person registers
--  N accounts with their own real KYC docs. SHA-256 hash columns +
--  UNIQUE partial indexes on status='approved' ensure ONE approved
--  ID per person. Duplicate attempts auto-fraud-flag both sides.
--
--  SAFE on existing data:
--   - columns are NULL-allowed (existing rows untouched)
--   - backfill populates hash where document_number matches a known
--     id type. Old rows without hash pass through leniently.
--   - unique indexes are partial (WHERE status='approved') so a
--     pending duplicate doesn't break insert.
--
--  Run:  docker exec -i coin-master-postgres-1 psql -U cryptoflip_user \
--           -d cryptoflip_db < 027_kyc_id_uniqueness.sql
--  Then restart backend so node-pg-migrate records this version.

BEGIN;

-- 1. Add hash columns (NULL-allowed for backfill)
ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS national_id_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS passport_hash    VARCHAR(64);

COMMENT ON COLUMN kyc_submissions.national_id_hash IS
  'SHA-256 hex of normalized national-id; enforced unique among approved rows';
COMMENT ON COLUMN kyc_submissions.passport_hash IS
  'SHA-256 hex of normalized passport number; enforced unique among approved rows';

-- 2. Backfill: hash whatever docs are already approved so the
--    unique index can apply without blocking existing legitimate users.
--    Normalize: trim, uppercase, strip spaces/dashes — same logic
--    backend code will use at insert time.
UPDATE kyc_submissions
   SET national_id_hash = encode(digest(
         upper(regexp_replace(COALESCE(document_number,''), '[^A-Za-z0-9]', '', 'g')),
         'sha256'), 'hex')
 WHERE document_type IN ('national_id','id_card','nationalid')
   AND national_id_hash IS NULL
   AND COALESCE(document_number,'') <> '';

UPDATE kyc_submissions
   SET passport_hash = encode(digest(
         upper(regexp_replace(COALESCE(document_number,''), '[^A-Za-z0-9]', '', 'g')),
         'sha256'), 'hex')
 WHERE document_type IN ('passport')
   AND passport_hash IS NULL
   AND COALESCE(document_number,'') <> '';

-- 3. Resolve pre-existing duplicates BEFORE adding unique index.
--    Keep the OLDEST approved row (first to claim), mark the rest
--    as status='rejected' with reason 'duplicate_id_v027_cleanup'.
WITH dup_national AS (
  SELECT id, user_id, document_number,
         ROW_NUMBER() OVER (
           PARTITION BY national_id_hash
           ORDER BY submitted_at ASC
         ) AS rn,
         'duplicate_id_v027_cleanup'::text AS reason
    FROM kyc_submissions
   WHERE status = 'approved'
     AND national_id_hash IS NOT NULL
),
dup_passport AS (
  SELECT id, user_id, document_number,
         ROW_NUMBER() OVER (
           PARTITION BY passport_hash
           ORDER BY submitted_at ASC
         ) AS rn,
         'duplicate_id_v027_cleanup'::text AS reason
    FROM kyc_submissions
   WHERE status = 'approved'
     AND passport_hash IS NOT NULL
)
UPDATE kyc_submissions k
   SET status          = 'rejected',
       reviewed_at     = NOW(),
       rejection_reason = COALESCE(rejection_reason, d.reason)
  FROM (
    SELECT id, reason FROM dup_national WHERE rn > 1
    UNION ALL
    SELECT id, reason FROM dup_passport WHERE rn > 1
  ) d
 WHERE k.id = d.id;

-- 4. Partial unique indexes — only enforced on approved rows.
--    A pending submission from a legit user with same ID as a still-
--    pending duplicate is fine; only one APPROVED can exist per hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_national_id_hash_unique
  ON kyc_submissions (national_id_hash)
  WHERE status = 'approved' AND national_id_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_passport_hash_unique
  ON kyc_submissions (passport_hash)
  WHERE status = 'approved' AND passport_hash IS NOT NULL;

-- 5. Helpful lookup index for hash lookups during review
CREATE INDEX IF NOT EXISTS idx_kyc_national_id_hash_lookup
  ON kyc_submissions (national_id_hash)
  WHERE national_id_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kyc_passport_hash_lookup
  ON kyc_submissions (passport_hash)
  WHERE passport_hash IS NOT NULL;

-- 6. Audit row (visible in admin_audit_trail queries)
INSERT INTO audit_log (category, action, severity, details)
VALUES ('kyc', 'migration.kyc_id_uniqueness', 'info',
        jsonb_build_object(
          'migration', '027_kyc_id_uniqueness',
          'summary', 'Added SHA-256 ID hashing + unique partial indexes',
          'applied_at', NOW()
        ));

COMMIT;
