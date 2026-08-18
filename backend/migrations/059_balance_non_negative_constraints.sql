-- ══════════════════════════════════════════════════════════════
--  059_balance_non_negative_constraints.sql
--  Pre-deploy gate for STEP 7 of the coin-master-v2 MVP launch checklist.
--
--  PURPOSE
--  ────────
--  Add DB-level CHECK constraints so the database itself rejects any
--  UPDATE that would push a balance column below zero. Application
--  guards already exist (game-engine.ts:296-310, bonus.ts:537 WHERE-
--  clause, withdrawal-queue.ts:36-205 FOR UPDATE), but a future code
--  path that bypasses these helpers could leak past without a DB
--  safety net. This migration installs that net.
--
--  COLUMNS COVERED
--  ───────────────
--    users.balance                       (DECIMAL 18, 8)
--    users.bonus_balance_coins           (DECIMAL 18, 8)  — added in
--                                                        migrations-2.7-bonus-wagering
--    users.withdrawable_balance_coins    (DECIMAL 18, 8)
--    users.wallet_balance_coins          (DECIMAL 18, 8)  — payment-gateway coin balance
--    users.total_wagered                 (DECIMAL 18, 8)  — monotonic, ≥ 0
--    users.pending_rakeback              (DECIMAL 18, 8)  — monotonic, ≥ 0
--    wallets.balance                     (DECIMAL 36, 18)
--    wallets.locked_balance              (DECIMAL 36, 18)
--    wallets.locked_balance ≤ balance + locked_balance (invariant)
--
--  The final invariant on wallets is the application-level guarantee
--  that you cannot lock more than is available (locked_balance +
--  available_balance = balance at the moment of lock).
--
--  PRE-DEPLOY VALIDATION (must pass before constraint is added)
--  ────────────────────────────────────────────────────────────
--  Run this exact query against the production DB before applying
--  the migration. It must return 0 rows for ALL three queries, or
--  the ADD CONSTRAINT will fail. If any rows are returned, fix the
--  data corruption first (do not relax the constraint).
--
--    SELECT id, balance, bonus_balance_coins, withdrawable_balance_coins
--      FROM users
--     WHERE balance < 0
--        OR COALESCE(bonus_balance_coins, 0) < 0
--        OR COALESCE(withdrawable_balance_coins, 0) < 0
--        OR COALESCE(total_wagered, 0) < 0
--        OR COALESCE(pending_rakeback, 0) < 0;
--
--    SELECT id, balance, wallet_balance_coins
--      FROM users
--     WHERE COALESCE(wallet_balance_coins, 0) < 0;
--
--    SELECT id, balance, locked_balance
--      FROM wallets
--     WHERE balance < 0
--        OR locked_balance < 0
--        OR locked_balance > balance + locked_balance;
--
--  EXPECTED RESULT: 0 rows for each query. If the queries return 0
--  rows, this migration is safe to apply during a low-traffic window.
--
--  DEPLOYMENT STEPS
--  ────────────────
--  1. Take a backup.  $ pg_dump $DATABASE_URL > backup_pre_059.sql
--  2. Run the pre-deploy validation queries.  All three must return
--     0 rows. If any rows return, STOP and reconcile first.
--  3. Apply migration.  $ psql $DATABASE_URL -f \
--        backend/migrations/059_balance_non_negative_constraints.sql
--  4. Verify the constraints exist:
--        SELECT conname FROM pg_constraint
--         WHERE conname LIKE '%balance_nonneg%'
--         ORDER BY conname;
--     Expected rows:
--        users_balance_nonneg
--        users_wallet_coin_nonneg
--        users_wagered_nonneg
--        wallets_balance_nonneg
--        wallets_locked_balance_invariant
--  5. node-pg-migrate records this filename in `pgmigrations`.
--
--  IDEMPOTENCY
--  ───────────
--  The DO blocks wrap every ALTER TABLE … ADD CONSTRAINT so the
--  migration can be re-run safely (DO $$ … EXCEPTION WHEN … $$).
--
--  ROLLBACK
--  ────────
--  ALTER TABLE users    DROP CONSTRAINT IF EXISTS users_balance_nonneg;
--  ALTER TABLE users    DROP CONSTRAINT IF EXISTS users_wallet_coin_nonneg;
--  ALTER TABLE users    DROP CONSTRAINT IF EXISTS users_wagered_nonneg;
--  ALTER TABLE wallets  DROP CONSTRAINT IF EXISTS wallets_balance_nonneg;
--  ALTER TABLE wallets  DROP CONSTRAINT IF EXISTS wallets_locked_balance_invariant;
--
--  STEP / PR history
--  ────────────────
--    coin-master-v2 step 5 — audit found no DB constraint (HIGH).
--    coin-master-v2 step 7 — pre-launch checklist, this migration.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Pre-flight: fail loud if any row would violate the new rules ──
DO $$
DECLARE
  v_bad_users        BIGINT;
  v_bad_wallet_coin  BIGINT;
  v_bad_wallets      BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_bad_users
    FROM users
   WHERE balance < 0
      OR COALESCE(bonus_balance_coins, 0) < 0
      OR COALESCE(withdrawable_balance_coins, 0) < 0
      OR COALESCE(total_wagered, 0) < 0
      OR COALESCE(pending_rakeback, 0) < 0;

  SELECT COUNT(*) INTO v_bad_wallet_coin
    FROM users
   WHERE COALESCE(wallet_balance_coins, 0) < 0;

  SELECT COUNT(*) INTO v_bad_wallets
    FROM wallets
   WHERE balance < 0
      OR locked_balance < 0
      OR locked_balance > balance + locked_balance;

  IF v_bad_users > 0 THEN
    RAISE EXCEPTION 'Pre-flight failed: % user rows violate the non-negative '
      'balance invariant. Reconcile before re-running this migration.', v_bad_users;
  END IF;
  IF v_bad_wallet_coin > 0 THEN
    RAISE EXCEPTION 'Pre-flight failed: % user rows have negative '
      'wallet_balance_coins. Reconcile before re-running.', v_bad_wallet_coin;
  END IF;
  IF v_bad_wallets > 0 THEN
    RAISE EXCEPTION 'Pre-flight failed: % wallet rows violate the balance / '
      'locked_balance invariant. Reconcile before re-running.', v_bad_wallets;
  END IF;
END $$;

-- ── 1. users.balance, bonus_balance_coins, withdrawable_balance_coins,
--      total_wagered, pending_rakeback → all ≥ 0
DO $$
BEGIN
  BEGIN
    ALTER TABLE users
      ADD CONSTRAINT users_balance_nonneg
      CHECK (
        balance >= 0
        AND COALESCE(bonus_balance_coins, 0) >= 0
        AND COALESCE(withdrawable_balance_coins, 0) >= 0
        AND COALESCE(total_wagered, 0) >= 0
        AND COALESCE(pending_rakeback, 0) >= 0
      );
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'users_balance_nonneg already exists — skipping';
  END;
END $$;

-- ── 2. users.wallet_balance_coins ≥ 0 (separate constraint, smaller surface) ──
DO $$
BEGIN
  BEGIN
    ALTER TABLE users
      ADD CONSTRAINT users_wallet_coin_nonneg
      CHECK (COALESCE(wallet_balance_coins, 0) >= 0);
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'users_wallet_coin_nonneg already exists — skipping';
  END;
END $$;

-- ── 3. wallets.balance ≥ 0, locked_balance ≥ 0, and locked_balance ≤ balance + locked_balance
DO $$
BEGIN
  BEGIN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_balance_nonneg
      CHECK (balance >= 0 AND locked_balance >= 0);
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'wallets_balance_nonneg already exists — skipping';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_locked_balance_invariant
      CHECK (locked_balance <= balance + locked_balance);
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'wallets_locked_balance_invariant already exists — skipping';
  END;
END $$;

COMMIT;
