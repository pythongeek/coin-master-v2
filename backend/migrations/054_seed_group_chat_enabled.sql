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

-- Migration row so node-pg-migrate (and the migrate container) record
-- this as applied. ON CONFLICT DO NOTHING makes it idempotent.
INSERT INTO pgmigrations (name, run_on)
  VALUES ('054_seed_group_chat_enabled', NOW())
  ON CONFLICT (name) DO NOTHING;
