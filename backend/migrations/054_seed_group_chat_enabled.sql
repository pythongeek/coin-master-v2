-- Migration 054: Seed group_chat_enabled (Gap 12)
--
-- The in-group chat toggle is master-gated by an admin_settings row
-- so the operator can disable chat at any time without a code deploy.
-- Default = false (chat is opt-in during Phase A smoke; flip to true in
-- Phase B per docs/GROUP_PLAY_ROLLOUT.md).
--
-- This is intentionally simple — no schema changes, just a row insert.
-- The setting is read by:
--   - admin-group-config.ts:getGroupConfigKey('groupChatEnabled')
--   - socket-game.ts:chat:message handler (returns group:error{CHAT_DISABLED}
--     when set to false)
--   - frontend/components/dashboard/AdminGroupConfig.tsx (renders the toggle)

INSERT INTO admin_settings (key, value, updated_at)
  VALUES ('group_chat_enabled', 'false', NOW())
  ON CONFLICT (key) DO NOTHING;

-- node-pg-migrate records this migration's row automatically after the
-- SQL above completes without errors (see
-- node-pg-migrate/dist/bundle/index.js line 3016). The original 054
-- file (in origin/fix/gap-12-chat-toggle) ended with an explicit
-- `INSERT INTO pgmigrations (name, run_on) ... ON CONFLICT (name) DO
-- NOTHING` for itself, but the WO-2.1 baseline adds a UNIQUE INDEX
-- pgmigrations_name_key on pgmigrations(name) to satisfy 054's own
-- ON CONFLICT(name) clause. With that UNIQUE in place, the runner's
-- plain INSERT (no ON CONFLICT) would fail with 23505 on a fresh
-- DB because both 054's explicit INSERT and the runner's automatic
-- INSERT target the same name. Removing the explicit INSERT lets
-- the runner record the row exactly once; subsequent runs are
-- filtered out by getMigrationsToRun (no re-insert).
