-- =============================================================
--  Migration 042: add streak + lightning columns to bets (P3-5/6 follow-up)
-- =============================================================
--
--  BUG FOUND during P3-5 verification: backend/src/services/game-engine.ts
--  INSERTs columns `streak_before`, `streak_after`, `streak_rung_multiplier`,
--  `streak_ladder_bonus`, `streak_at_risk`, `streak_banked`, `streak_lost`,
--  `lightning_triggered`, `lightning_multiplier`, `lightning_extra_payout`
--  on the bets table — but those columns never had a migration.
--  Every placeBet call was crashing at the INSERT step.
--
--  This migration adds the columns with NULL allowed + sensible defaults
--  so we can backfill old rows (with defaults) without breaking existing
--  data. Numeric(18,8) for the streak money columns (consistent with
--  payout / amount columns), boolean for lightning_triggered, numeric(8,4)
--  for lightning_multiplier / streak_rung_multiplier (consistent with
--  target_multiplier / actual_multiplier).
--
--  Defensive: add columns one at a time inside a DO block so a partial
--  migration doesn't leave the table in a bad state.
-- =============================================================

BEGIN;

DO $$
BEGIN
  -- Streak columns (push-your-luck ladder from Phase 3 game engine)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_before') THEN
    ALTER TABLE bets ADD COLUMN streak_before integer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_after') THEN
    ALTER TABLE bets ADD COLUMN streak_after integer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_rung_multiplier') THEN
    ALTER TABLE bets ADD COLUMN streak_rung_multiplier numeric(12,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_ladder_bonus') THEN
    ALTER TABLE bets ADD COLUMN streak_ladder_bonus numeric(18,8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_at_risk') THEN
    ALTER TABLE bets ADD COLUMN streak_at_risk numeric(18,8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_banked') THEN
    ALTER TABLE bets ADD COLUMN streak_banked numeric(18,8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='streak_lost') THEN
    ALTER TABLE bets ADD COLUMN streak_lost numeric(18,8);
  END IF;

  -- Lightning columns (rare multiplier bonus when triggered)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='lightning_triggered') THEN
    ALTER TABLE bets ADD COLUMN lightning_triggered boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='lightning_multiplier') THEN
    ALTER TABLE bets ADD COLUMN lightning_multiplier numeric(8,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bets' AND column_name='lightning_extra_payout') THEN
    ALTER TABLE bets ADD COLUMN lightning_extra_payout numeric(18,8);
  END IF;

  -- bonus_claims.per-claim wagering counter (the creditWagering service
  -- tracks per-claim wagering completion in a column called
  -- wagering_completed, but the bonus_claims table only has
  -- wagering_required today). Without this column the bonus wagering
  -- subsystem can never mark any bonus claim as 'completed'.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='bonus_claims' AND column_name='wagering_completed') THEN
    ALTER TABLE bonus_claims ADD COLUMN wagering_completed numeric(18,8) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Audit row
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.streak_lightning_columns', 'info',
        jsonb_build_object('migration', '042',
                           'note', 'Added streak_* + lightning_* columns to bets table (was failing every placeBet call)',
                           'columns_added', ARRAY['streak_before','streak_after','streak_rung_multiplier',
                                                  'streak_ladder_bonus','streak_at_risk','streak_banked',
                                                  'streak_lost','lightning_triggered','lightning_multiplier',
                                                  'lightning_extra_payout']));

COMMIT;