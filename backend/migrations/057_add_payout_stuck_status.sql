-- =============================================================
--  Migration 057: S1-W3 — Add 'payout_stuck' to transactions.status
-- =============================================================
--
--  Background:
--    services/withdrawal-payout.ts:179 currently THROWS when the TRON
--    confirmation polling loop exhausts 30 × 10s = 5 minutes without
--    reaching 19 confirmations. The throw triggers BullMQ retries with
--    exponential backoff, but the broadcast already happened on-chain.
--    Result: DOUBLE BROADCAST on retry, AND the DB row is left as
--    'failed' (or worse, mid-update) — the user's funds are on-chain
--    but the DB doesn't know it.
--
--    S1-W3 replaces the throw with a transition to 'payout_stuck':
--    the row keeps the on-chain tx_hash, the locked_balance is NOT
--    restored (money already left the wallet), and an admin email is
--    queued. A new admin endpoint resolves the row manually after
--    on-chain verification.
--
--  Why 'payout_stuck' is its own state (not 'failed'):
--    'failed'    = operational/system failure (RPC down, signature rejected)
--    'payout_stuck' = broadcast succeeded but confirmations stalled
--    'rejected'  = admin cancellation (S1-C1)
--    'confirmed' = admin approved, BullMQ dispatched (S1-C4-R2)
--    'completed' = on-chain settled
--
--  Ordering: 056 (S1-C1) added 'rejected'. This 057 adds 'payout_stuck'.
--  Drop-then-add is idempotent for the DROP CONSTRAINT IF EXISTS.
--  Migration 057 is the only place that references 'payout_stuck' until
--  S1-W11 (reconciliation cron) starts scanning for it.
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
