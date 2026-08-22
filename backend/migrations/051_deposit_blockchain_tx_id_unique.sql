-- Migration 051: partial unique index on deposit_transactions.blockchain_tx_id.
--
-- Why hand-written, not Prisma-generated:
--   Prisma's schema language cannot express a partial unique index
--   (`WHERE blockchain_tx_id IS NOT NULL`). The generated baseline
--   (049_prisma_financial_schema.sql) emits a non-unique index because
--   NULL blockchain_tx_id rows are valid (deposit initiated but no
--   on-chain payment yet). We want non-NULL tx ids to be globally unique
--   so a duplicate webhook (same txid delivered twice) cannot create
--   two deposit_transactions rows crediting the user twice.
--
-- Defense-in-depth rationale:
--   The current tx-replay defense is a code-level check in
--   tron-deposit-monitor.ts:166 (`blockchainTxId: { not: null }`
--   followed by a SELECT). Code checks race against concurrent webhook
--   deliveries; the unique index at the DB level does not race.
--
-- Precondition verified 2026-08-22: a grep of all INSERTs into
-- deposit_transactions.blockchain_tx_id confirms no path writes the
-- empty string `''` as a placeholder. The only writer is
-- tron-deposit-monitor.ts:140 (`blockchainTxId: tx.txHash`) which
-- inserts a real 64-char hex txid. Empty-string inserts would
-- collide under the partial unique index and break existing rows.
--
-- Idempotent: standard CREATE UNIQUE INDEX IF NOT EXISTS isn't
-- supported by Postgres, so guard with a DO block.
--
-- Rollback: DROP INDEX IF EXISTS deposit_transactions_blockchain_tx_id_uniq;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'deposit_transactions'
      AND indexname  = 'deposit_transactions_blockchain_tx_id_uniq'
  ) THEN
    CREATE UNIQUE INDEX deposit_transactions_blockchain_tx_id_uniq
      ON deposit_transactions(blockchain_tx_id)
      WHERE blockchain_tx_id IS NOT NULL;
  END IF;
END $$;

COMMIT;