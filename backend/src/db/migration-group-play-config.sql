-- ════════════════════════════════════════════════════════════════
--  MIGRATION — Group Play admin-config thresholds (Phase 2 / Day 8)
--  ════════════════════════════════════════════════════════════════
--
--  Seeds the 24 group_play admin-config thresholds from the Phase 2
--  §2.1 spec into the existing `admin_settings` table. The service
--  layer (`backend/src/services/admin-group-config.ts`) reads these
--  keys via `getRawSetting()` and `setRawSetting()` from
--  `admin-fraud-config.ts`.
--
--  Apply to a live DB:
--      docker exec -i coin-master-postgres-1 \
--        psql -U cryptoflip -d cryptoflip \
--        < backend/src/db/migration-group-play-config.sql
--
--  Fresh-DB path: include this file in the docker-entrypoint-initdb.d
--  chain so it auto-runs on a brand-new container.
--
--  Idempotent: every INSERT uses ON CONFLICT (key) DO UPDATE so the
--  migration can be re-applied safely (e.g. to roll forward defaults
--  after the code changes).
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Master toggles
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_play_enabled', 'false', 'Master toggle — kills all groups if off', NOW()),
  ('group_play_allowed_countries', '*', 'ISO country codes (CSV); "*" = everyone', NOW()),
  ('group_play_blocked_countries', 'KP,IR,SY,CU', 'Hard-blocked (regulatory); CSV of ISO codes', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 2. Member caps
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_default_min_members', '2', 'Default min players when group is created', NOW()),
  ('group_default_max_members', '5', 'Default max players', NOW()),
  ('group_absolute_max_members', '10', 'Hard cap (overrides user choice)', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 3. Stake caps
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_default_contribution_min', '0.10', 'Default min stake per member', NOW()),
  ('group_default_contribution_max', '10000', 'Default max stake per member', NOW()),
  ('group_absolute_pool_cap', '50000', 'Hard cap on total pool', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 4. Timing
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_expiry_minutes', '30', 'Default time-to-live before WAITING → EXPIRED', NOW()),
  ('group_auto_flip_countdown_seconds', '5', 'For auto_on_full turn mode', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 5. Distribution & turn defaults
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_default_payout_distribution', 'proportional', 'equal | proportional | founder_boost', NOW()),
  ('group_default_turn_decision', 'creator', 'creator | auto_on_full | random_lottery', NOW()),
  ('group_default_founder_share_pct', '10', 'For founder_boost mode (0-30)', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 6. House edge
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_house_edge_percent', '1.0', 'House edge on group wins (decoupled from solo)', NOW()),
  ('group_loss_house_edge_percent', '0', 'Sometimes you want a tiny edge on losses too', NOW()),
  ('group_min_house_edge_spread_vs_solo', '0.5', 'Minimum extra house edge for groups (vs solo) to prevent arb', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 7. Invites & bonuses
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_inviter_bonus_coins', '0', 'Coins credited to inviter when invitee joins via token', NOW()),
  ('group_invitee_bonus_coins', '0', 'Coins credited to invitee when they join via token', NOW()),
  ('group_inviter_bonus_cap_per_user_per_day', '50', 'Anti-fraud cap on inviter bonuses', NOW()),
  ('group_invite_max_redemptions_default', '1', 'How many times a single invite token can be redeemed', NOW()),
  ('group_invite_expiry_hours_default', '168', 'Default invite token TTL (7 days default)', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

-- 8. Feature flags
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES
  ('group_spectator_mode_enabled', 'true', 'Toggle spectator view of in-progress groups', NOW()),
  ('group_private_allowed', 'true', 'Allow is_private=true groups', NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();

COMMIT;

-- ── Verification ───────────────────────────────────────────────
-- 24 rows expected in admin_settings WHERE key LIKE 'group_%'
SELECT count(*) AS group_play_setting_count
FROM admin_settings
WHERE key LIKE 'group_%' OR key LIKE 'group_play_%';