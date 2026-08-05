-- Migration 053: Add spectator_count to group_bet (Gap 11)
--
-- A non-member "spectator" view is now exposed via
-- GET /api/group-bet/:id/spectate and POST /api/group-bet/:id/spectate/leave.
-- The count lives on group_bet (not group_bet_member) because spectators
-- aren't members of the room and we don't want to pollute the member
-- table with non-bettor rows. The counter is updated via atomic
-- `UPDATE group_bet SET spectator_count = spectator_count + 1` which
-- is concurrency-safe at the PostgreSQL row level (no race).
--
-- Reasonable defaults:
--   - DEFAULT 0 so existing rows backfill to 0 spectators
--   - NOT NULL so the +/- arithmetic always has a valid base

ALTER TABLE group_bet
  ADD COLUMN IF NOT EXISTS spectator_count INTEGER NOT NULL DEFAULT 0;

-- Optional index: lets the lobby/spectator UI filter rooms with at least
-- one watcher without scanning the full table. Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_group_bet_has_spectators
  ON group_bet (id)
  WHERE spectator_count > 0;

-- Insert migration row so node-pg-migrate (and the migrate container)
-- record this as applied. ON CONFLICT DO NOTHING makes it idempotent.
INSERT INTO pgmigrations (name, run_on) VALUES ('053_group_spectator_count', NOW())
  ON CONFLICT (name) DO NOTHING;
