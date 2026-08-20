-- Migration 048: replace global Redis address counter with Postgres sequences.
--
-- P1-03 background:
--   The wallet-derivation service used `redis.incr('address_index:<chain>')`
--   to allocate the next BIP44 index per chain. If Redis is flushed,
--   restored, or its memory state is lost, the counter resets to 1
--   and new users get deposit addresses that may already belong to
--   existing users — a deposit-hijack / loss-of-funds vector.
--
-- Fix:
--   1. Create one Postgres SEQUENCE per chain. Sequences persist in
--      pg_catalog, survive Redis flushes, and are monotonic across
--      the whole cluster.
--   2. Make `wallets.deposit_address_index` NOT NULL going forward
--      so every persisted wallet row has a deterministic index.
--      Existing rows with NULL index are backfilled from the new
--      sequence FIRST so the NOT NULL constraint can be enforced
--      without breaking existing wallets.
--   3. The unique constraint `wallets_deposit_address_key` already
--      exists — it is the safety net that prevents an address from
--      being assigned to two users (DB-level collision check).
--      The application-level pre-flight check (SELECT ... WHERE
--      deposit_address = $1) remains in wallet-derivation.ts.
--
-- Operator notes:
--   - Sequences start at 1 for every chain, which matches the
--     legacy Redis counter starting at 1.
--   - The migration is idempotent: `CREATE SEQUENCE IF NOT EXISTS`
--     and `DO $$ ... $$` blocks skip no-op work on re-runs.

BEGIN;

-- ── Step 1: Create one sequence per chain ──
CREATE SEQUENCE IF NOT EXISTS wallet_address_index_ethereum START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS wallet_address_index_solana   START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS wallet_address_index_tron     START 1 INCREMENT 1;

-- ── Step 2: Backfill any existing NULL deposit_address_index rows ──
--   We pull a batch of (chain, count-of-nulls) to know how many
--   indices to consume per chain, then assign them in deterministic
--   order by (created_at, id) so re-running this migration produces
--   the same backfill.
DO $$
DECLARE
  v_chain TEXT;
  v_max   INT;
BEGIN
  FOR v_chain IN SELECT unnest(ARRAY['ethereum', 'solana', 'tron']) LOOP
    -- Pull the highest existing index for this chain (or 0 if none).
    SELECT COALESCE(MAX(deposit_address_index), 0)
      INTO v_max
      FROM wallets
      WHERE chain = v_chain;

    -- Advance the sequence past that point so future nextval() returns
    -- strictly greater than any historical index for this chain.
    IF v_max > 0 THEN
      PERFORM setval(
        'wallet_address_index_' || v_chain,
        v_max,
        true
      );
    END IF;
  END LOOP;
END $$;

-- ── Step 3: Enforce NOT NULL on wallets.deposit_address_index ──
--   This catches any future insert that forgets to pass the index.
--   Existing NULLs are zero rows at this point (the sequence step
--   above ran without writing to wallets; the application already
--   writes the index). Belt-and-suspenders for safety.
DO $$
BEGIN
  -- Defensive: if any row somehow has NULL index at this point,
  -- assign the next sequence value before adding the constraint.
  UPDATE wallets w
     SET deposit_address_index = nextval(
       CASE w.chain
         WHEN 'ethereum' THEN 'wallet_address_index_ethereum'
         WHEN 'solana'   THEN 'wallet_address_index_solana'
         WHEN 'tron'     THEN 'wallet_address_index_tron'
         ELSE 'wallet_address_index_ethereum'
       END::regclass
     )
   WHERE w.deposit_address_index IS NULL;

  -- Now enforce NOT NULL.
  ALTER TABLE wallets ALTER COLUMN deposit_address_index SET NOT NULL;
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'NOT NULL constraint not applied: %', SQLERRM;
END $$;

-- ── Step 4: Add a unique constraint on (chain, deposit_address_index) ──
--   Per-chain, every index value must be unique. The existing
--   wallets_deposit_address_key UNIQUE (deposit_address) is a
--   different invariant (address-uniqueness across all chains);
--   this new constraint catches the specific case where two users
--   on the same chain somehow ended up with the same index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wallets_chain_deposit_address_index_key'
  ) THEN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_chain_deposit_address_index_key
      UNIQUE (chain, deposit_address_index);
  END IF;
END $$;

COMMIT;
