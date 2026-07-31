-- ════════════════════════════════════════════════════════════════
--  MIGRATION — Invite-token redemption flow (Phase 2 / Day 11)
--  ═══════════════════════════════════════════════════════════════
--
--  Adds `group_bet_invite_link` — a shareable, expirable, multi-use
--  invite token. Distinguishes from the existing `group_bet.invite_token`
--  (which is a static per-room share slug) and the existing
--  `group_bet_invite` table (which is an event-log for share actions).
--
--  Each link carries:
--    - token (random 32-char base32)
--    - group_id (FK)
--    - inviter_id (FK to users)
--    - max_redemptions (default 1; can be > 1 for group-share links)
--    - redemption_count (counter; SELECT FOR UPDATE on redeem)
--    - expires_at (default +7 days; configurable via groupInviteExpiryHoursDefault)
--    - optional campaign string (utm-style attribution)
--  ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS group_bet_invite_link (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  token             varchar(48) UNIQUE NOT NULL,
  group_id          uuid NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  inviter_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  max_redemptions   int NOT NULL DEFAULT 1 CHECK (max_redemptions >= 1 AND max_redemptions <= 100),
  redemption_count  int NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at        timestamptz NOT NULL,
  campaign          varchar(64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  redeemed_count     int NOT NULL DEFAULT 0,
  first_redeemed_at timestamptz,
  last_redeemed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_gbil_token ON group_bet_invite_link(token);
CREATE INDEX IF NOT EXISTS idx_gbil_group ON group_bet_invite_link(group_id);
CREATE INDEX IF NOT EXISTS idx_gbil_inviter_recent ON group_bet_invite_link(inviter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbil_expires_open ON group_bet_invite_link(expires_at) WHERE redemption_count < max_redemptions;

-- Track per-user-per-day inviter bonus cap enforcement via a new query
-- helper column on the existing transactions table — already permits
-- admin_adjustment direction='credit' which is what bonus credits are.
-- The cap check is done in the service layer using a sum-aggregate
-- query against the same row type.

-- Mark as applied (Phase 2 / Day 11)
INSERT INTO schema_migrations (filename) VALUES ('migration-invite-link.sql')
  ON CONFLICT (filename) DO NOTHING;
