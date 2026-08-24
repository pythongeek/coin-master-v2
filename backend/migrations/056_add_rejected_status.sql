-- =============================================================
--  Migration 056: S1-C1 + S1-W3 — Extend transactions.status CHECK
-- =============================================================
--
--  This migration adds BOTH 'rejected' (S1-C1) and 'payout_stuck'
--  (S1-W3) to the transactions.status CHECK constraint. Originally
--  the plan was to split this into 056 (S1-C1) and 057 (S1-W3),
--  but in production the W11 reconciliation cron (S1-W11) flipped
--  hundreds of confirmed-without-tx-hash rows to 'payout_stuck'
--  before the migrations were applied. A two-step DROP+ADD with
--  056's narrow 7-value list would have violated those rows.
--
--  Putting both in 056 keeps the migration idempotent and the
--  CHECK list complete. The legacy 057 file is kept as a no-op
--  for environments that already recorded 057 in pgmigrations;
--  it just re-asserts the same 8-value CHECK.
--
--  Background (S1-C1):
--    The rejectWithdrawal() function in backend/src/services/bonus.ts
--    was emitting status='failed' for admin rejections. The audit
--    PROD_AUDIT_2026-08-07.md (S1-C1) requires a distinct
--    'rejected' state so that:
--      - 'failed'    = operational/on-chain failure
--      - 'rejected'  = admin/manual cancellation
--
--  Background (S1-W3):
--    services/withdrawal-payout.ts:179 used to THROW when the TRON
--    confirmation polling loop exhausted 30 × 10s = 5 minutes. The
--    throw triggered BullMQ retries with the broadcast already
--    on-chain → DOUBLE BROADCAST + 'failed' status. S1-W3 introduces
--    'payout_stuck' = broadcast succeeded but confirmations stalled.
--    The S1-W11 cron flips confirmed-without-tx-hash rows here, and
--    the S1-W3 admin resolve-stuck endpoint acts on them.
--
--  Status semantics (final):
--    'pending'      = user submitted, awaiting admin review
--    'confirming'   = admin approved, BullMQ dispatched, waiting for
--                      on-chain settlement
--    'confirmed'    = admin approved + BullMQ payout job dispatched
--                      (alias of 'confirming' in some code paths)
--    'completed'    = on-chain settled
--    'failed'       = operational/system failure
--    'cancelled'    = user-cancelled before admin review
--    'rejected'     = admin cancellation (S1-C1)
--    'payout_stuck' = broadcast succeeded but confirmations stalled
--                      (S1-W3); requires admin resolve via
--                      POST /api/admin/withdrawals/:id/resolve-stuck
--
--  Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
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
    'rejected',
    'payout_stuck'
  ));
