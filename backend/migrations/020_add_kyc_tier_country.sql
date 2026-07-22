-- Migration 020: Add kyc_tier + kyc_country columns for risk scoring
-- These were referenced by withdrawal-risk.service.ts but never added
-- to the production users table.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_tier    VARCHAR(20),       -- 'tier1' | 'tier2' | 'tier3' (NULL = unverified)
  ADD COLUMN IF NOT EXISTS kyc_country VARCHAR(8);        -- ISO 3166-1 alpha-2 (e.g. 'BD', 'IN')

-- Backfill: any user with kyc_status='verified' becomes tier1
UPDATE users SET kyc_tier = 'tier1' WHERE kyc_status = 'verified' AND kyc_tier IS NULL;
