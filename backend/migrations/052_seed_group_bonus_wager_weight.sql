-- Migration 052: Seed group_bonus_wager_weight (Gap 4)
--
-- Group bets share variance across multiple members, so the bonus
-- wagering credit is admin-tunable at less than 100% of the stake
-- (default 50%). Operators can dial it up to 100% (groups clear bonus
-- as fast as solo) or to 0 (groups do not count toward bonus
-- clearance at all).
--
-- The runtime code reads via
-- getGroupConfigKey('groupBonusWagerWeight') with a hard-coded
-- fallback of 50 if the key is missing, so the migration is
-- technically optional — but seeding it makes the operator's intent
-- explicit and audit-friendly.
--
-- Idempotency: INSERT ... ON CONFLICT (key) DO NOTHING.

INSERT INTO admin_settings (key, value)
VALUES ('group_bonus_wager_weight', '50')
ON CONFLICT (key) DO NOTHING;
