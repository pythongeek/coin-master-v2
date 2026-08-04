-- Migration 051: Seed group_min_user_deposit_history (Gap 6)
--
-- The existing 24 group-play admin settings (Day 8) include
-- `group_default_contribution_min` (the per-member stake floor). But
-- the lifetime-deposit eligibility gate in group-bet-create.ts was
-- reading that same key as a proxy for the lifetime-deposit floor.
-- Per Gap 6, that mismatch is wrong: a user with $0 lifetime deposits
-- could create a group as long as their per-member stake was above
-- the contribution min (which is 0.10 USD).
--
-- This migration seeds the NEW dedicated key
-- `group_min_user_deposit_history` (default 50). Operators can now
-- tune the lifetime-deposit floor independently from the per-member
-- stake minimum. The runtime code (group-bet-create.ts and
-- group-bet-join.ts) reads via `getGroupConfigKey('groupMinUserDepositHistory')`
-- with a hard-coded fallback of 50 if the key is missing.
--
-- Idempotency: INSERT ... ON CONFLICT (key) DO NOTHING so re-running
-- the migration is safe.

INSERT INTO admin_settings (key, value)
VALUES ('group_min_user_deposit_history', '50')
ON CONFLICT (key) DO NOTHING;
