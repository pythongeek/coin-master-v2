-- =============================================================
--  Migration 056: S1-C1 — Add 'rejected' to transactions.status
-- =============================================================
--
--  Background:
--    The rejectWithdrawal() function in backend/src/services/bonus.ts
--    (lines 961-1004 prior to this fix) was emitting
--    status='failed' for admin rejections. The audit
--    PROD_AUDIT_2026-08-07.md (S1-C1) requires a distinct
--    'rejected' state so that:
--
--      - 'failed'    = operational/on-chain failure (timeout, RPC error)
--      - 'rejected'  = admin/manual cancellation (KYC fail, fraud review,
--                      user request, tier mismatch)
--
--    Conflating the two blocks accurate reporting, risk scoring
--    (withdrawal-risk.service.ts filters by status='rejected'), and
--    reconciliation. The CHECK constraint blocks the new value, so
--    the pragma must be extended atomically.
--
--  Why this is safe:
--    - Existing rows are not affected (constraint is forward-only).
--    - 'payout_stuck' will be added by migration 057 (W3 in this
--      sprint). This migration adds only 'rejected'.
--    - DROP CONSTRAINT IF EXISTS is idempotent in case the migration
--      is re-run.
--
--  Order in sprint: 056 (C1) — precede 057 (W3).
-- =============================================================

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN (
    'pending',
    'confirming',
    'completed',
    'failed',
    'cancelled',
    'confirmed',
    'rejected'
  ));
