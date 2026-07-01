-- ═══════════════════════════════════════════════════════════════
--  RECONCILE BACKFILL — add bonus transactions for legacy users
-- ═══════════════════════════════════════════════════════════════
--
-- The merged reconciliation engine compares
--   expected = deposits + bonus - withdrawals + (payout-amount for bets)
--   actual   = users.balance
-- and freezes any user where these differ. Users created BEFORE
-- the merged code's register endpoint wrote a 'bonus' transaction
-- have a balance that isn't backed by any ledger row, so the
-- reconcile flags them as compromised.
--
-- This script backfills a synthetic 'bonus' transaction for every
-- such user, covering the exact diff. After running, the
-- reconciliation should pass for all users with a balance > 0
-- unless they have other integrity issues.
--
-- Run once. Idempotent: re-running produces 0 inserts (the diff
-- is now 0).
--
DO $$
DECLARE
  rec RECORD;
  diff NUMERIC;
  tx_id UUID;
  users_backfilled INT := 0;
  users_negative   INT := 0;
BEGIN
  FOR rec IN
    SELECT u.id, u.username, u.balance,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('deposit','bonus') AND t.status IN ('completed','confirmed')), 0) AS deposits,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type='withdrawal' AND t.status IN ('pending','confirming','completed','confirmed','failed','cancelled')), 0) AS withdrawals,
           COALESCE(SUM(b.payout - b.amount), 0) AS bets
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id
    LEFT JOIN bets b ON b.user_id = u.id AND b.status='resolved'
    GROUP BY u.id, u.username, u.balance
  LOOP
    diff := rec.balance - (rec.deposits - rec.withdrawals + rec.bets);
    IF diff > 0.001 THEN
      tx_id := gen_random_uuid();
      INSERT INTO transactions
        (id, user_id, wallet_id, type, amount, currency, direction, status,
         related_user_id, metadata, completed_at)
      VALUES
        (tx_id, rec.id, NULL, 'bonus', diff, 'USDT', 'credit', 'confirmed',
         rec.id, jsonb_build_object('source', 'reconcile_backfill',
                                    'note', 'Pre-merge backfill to reconcile legacy balance',
                                    'original_balance', rec.balance,
                                    'migrated_at', NOW()), NOW());
      users_backfilled := users_backfilled + 1;
    ELSIF diff < -0.001 THEN
      -- Negative diff: user has less than expected. Log it.
      RAISE WARNING 'User % (%) has negative diff: balance=%, expected=%, diff=% — review needed',
        rec.username, rec.id, rec.balance, (rec.deposits - rec.withdrawals + rec.bets), diff;
      users_negative := users_negative + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Backfilled bonus tx for % user(s). % user(s) have negative diff (operator review).',
    users_backfilled, users_negative;
END
$$;
