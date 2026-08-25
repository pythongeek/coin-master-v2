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

-- node-pg-migrate records this migration's row automatically after the
-- SQL above completes without errors (see
-- node-pg-migrate/dist/bundle/index.js line 3016). The original 053
-- file (in origin/fix/gap-11-spectator-mode) ended with an explicit
-- `INSERT INTO pgmigrations (name, run_on) ... ON CONFLICT (name) DO
-- NOTHING` for itself, but the WO-2.1 baseline adds a UNIQUE INDEX
-- pgmigrations_name_key on pgmigrations(name) to satisfy 053/054's
-- own ON CONFLICT(name) clauses. With that UNIQUE in place, the
-- runner's plain INSERT (no ON CONFLICT) would fail with 23505 on a
-- fresh DB because both 053's explicit INSERT and the runner's
-- automatic INSERT target the same name. Removing the explicit
-- INSERT lets the runner record the row exactly once; subsequent
-- runs are filtered out by getMigrationsToRun (no re-insert).
