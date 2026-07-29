-- ════════════════════════════════════════════════════════════════
--  MIGRATION — Group Play (Phase 1)
--  ══════════════════════════════════════════════════════════════
--
--  Adds 4 tables for the multiplayer group-bet feature on top of
--  the existing single-player CoinFlip:
--
--    group_bet          — the room itself (state machine, pool, stakes)
--    group_bet_member   — one row per participant (creator + members)
--    group_bet_invite   — shareable-link + channel attribution log
--    group_bet_audit    — every state transition + admin action
--
--  Design notes:
--    - All money movements live inside SERIALIZABLE transactions and
--      reference the existing `users` + `transactions` tables.
--    - All status mutations go through one helper
--      `transition_group_bet_status()` (mirrors `placeBet`'s pattern).
--    - All state transitions + admin actions write to BOTH
--      `group_bet_audit` (the new fine-grained ledger) AND `audit_log`
--      (the existing system-wide ledger).
--    - The audit_log mirror is performed by the service layer
--      (group-bet-state.ts) inside the same transaction, not by a
--      trigger — keeping the trigger surface small.
--
--  Apply to a live DB:
--      docker exec -i coin-master-postgres-1 \
--        psql -U cryptoflip -d cryptoflip \
--        < backend/src/db/migrations-group-play.sql
--
--  Fresh-DB path: include this file in the docker-entrypoint-initdb.d
--  chain (e.g. as 03-migrations-group-play.sql) so it auto-runs on a
--  brand-new container.
-- ════════════════════════════════════════════════════════════════

-- Ensure uuid generation is available (matches existing migrations)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ════════════════════════════════════════════════════════════════
-- TABLE: group_bet
-- The room. One row per group play session.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_bet (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Shareable link suffix. Short, unambiguous, uppercase alnum.
  short_code        VARCHAR(10) UNIQUE NOT NULL,

  -- Member who created the room. RESTRICT: cannot delete user
  -- without first resolving their open groups.
  creator_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Game type for future multi-game support. CoinFlip-only for the MVP.
  game_type         VARCHAR(20) NOT NULL DEFAULT 'coinflip'
                    CHECK (game_type IN ('coinflip','dice','crash')),

  -- Lobby flavor (informational at MVP):
  --   'wait'    — members join until threshold, then flip
  --   'lottery' — server picks a flipper weighted by contribution
  --   'auto'    — auto-flip after N seconds once threshold met
  --   'live'    — spectator mode + live broadcast
  mode              VARCHAR(20) NOT NULL DEFAULT 'wait'
                    CHECK (mode IN ('wait','lottery','auto','live')),

  -- 6-value state machine — managed exclusively by
  -- transition_group_bet_status() (defined below).
  --   pending    → not yet paid (reserved for future two-step create)
  --   open       → waiting for members to join
  --   ready      → threshold met, awaiting flip
  --   flipping   → flip in progress
  --   resolved   → terminal: winners credited, losers forfeited
  --   cancelled  → terminal: all members refunded
  --   expired    → terminal: TTL elapsed, all members refunded
  --   frozen     → admin freeze (admin can resume or force-cancel)
  status            VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN (
                      'pending','open','ready','flipping',
                      'resolved','cancelled','expired','frozen'
                    )),

  -- Creator's choice (heads/tails) at room-creation time.
  creator_choice    VARCHAR(10) NOT NULL
                    CHECK (creator_choice IN ('heads','tails')),

  -- Stakes (always positive).
  creator_stake     DECIMAL(18,8) NOT NULL CHECK (creator_stake > 0),
  per_member_stake  DECIMAL(18,8) NOT NULL CHECK (per_member_stake > 0),

  -- Aggregate pool. Maintained by join()/leave()/refund() helpers.
  total_pool        DECIMAL(18,8) NOT NULL DEFAULT 0 CHECK (total_pool >= 0),

  -- Member-count bounds. max_members is hard-capped at 10 by the
  -- application layer (admin setting: groupMaxMembersHardCap).
  min_members       SMALLINT NOT NULL DEFAULT 2
                    CHECK (min_members >= 2 AND min_members <= 10),
  max_members       SMALLINT NOT NULL DEFAULT 5
                    CHECK (max_members >= 2 AND max_members <= 10),

  -- Live member count (creator counts as 1).
  current_members   SMALLINT NOT NULL DEFAULT 1
                    CHECK (current_members >= 1 AND current_members <= 10),

  currency          VARCHAR(10) NOT NULL DEFAULT 'USD',

  -- Payout distribution mode (Phase 1 §6).
  --   equal           — split totalPool / winners.count
  --   proportional    — weighted by stake
  --   founder_boost   — 10% bonus to creator from pool, rest proportional
  payout_mode       VARCHAR(20) NOT NULL DEFAULT 'equal'
                    CHECK (payout_mode IN ('equal','proportional','founder_boost')),

  -- Turn-decision mode (Phase 1 §7).
  --   creator         — only the host flips
  --   auto_on_full    — countdown N seconds after group fills
  --   random_lottery  — server picks weighted by contribution
  turn_mode         VARCHAR(20) NOT NULL DEFAULT 'creator'
                    CHECK (turn_mode IN ('creator','auto_on_full','random_lottery')),

  -- For turn_mode='auto_on_full'. Default 5s (admin-configurable later).
  auto_flip_seconds INTEGER NOT NULL DEFAULT 5
                    CHECK (auto_flip_seconds >= 1 AND auto_flip_seconds <= 60),

  -- Signed token used by invite link — separate from short_code so the
  -- token can be rotated without changing the public URL.
  invite_token      VARCHAR(64) UNIQUE NOT NULL,

  -- 24h TTL. Sweep job turns stale rooms to 'expired'.
  expires_at        TIMESTAMPTZ NOT NULL,
  ready_at          TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,

  -- Provably-fair state (committed BEFORE the flip, revealed AFTER).
  -- Mirrors the existing single-player CoinFlip pattern (see
  -- game_seeds + provably-fair.ts for the canonical SHA-256 flow).
  winning_side      VARCHAR(10) CHECK (winning_side IN ('heads','tails')),
  server_seed_hash  VARCHAR(64),
  server_seed_reveal VARCHAR(64),
  client_seed       VARCHAR(64),
  nonce             BIGINT,
  result_hash       VARCHAR(64),

  -- Founder-boost bookkeeping.
  founder_boost_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00
                    CHECK (founder_boost_pct >= 0 AND founder_boost_pct <= 50),

  -- Anti-fraud hooks.
  fraud_score       INTEGER NOT NULL DEFAULT 0 CHECK (fraud_score >= 0 AND fraud_score <= 100),
  fraud_flags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_frozen         BOOLEAN NOT NULL DEFAULT FALSE,

  -- Cancellation reason (audit visibility).
  cancelled_reason  TEXT,

  -- Idempotency: same client_request_id cannot create a second room
  -- inside the 60s window enforced by Redis (see group-bet-create.ts).
  client_request_id VARCHAR(64),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_min_max_members CHECK (max_members >= min_members)
);

CREATE INDEX IF NOT EXISTS idx_group_bet_status
  ON group_bet(status);
CREATE INDEX IF NOT EXISTS idx_group_bet_creator
  ON group_bet(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_bet_expires_open
  ON group_bet(expires_at)
  WHERE status IN ('open','ready');
CREATE INDEX IF NOT EXISTS idx_group_bet_creator_idem
  ON group_bet(creator_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_bet_short_code
  ON group_bet(short_code);

-- ════════════════════════════════════════════════════════════════
-- TABLE: group_bet_member
-- One row per participant per group. UNIQUE(group_id, user_id)
-- prevents the same user from joining twice.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_bet_member (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role            VARCHAR(20) NOT NULL DEFAULT 'member'
                  CHECK (role IN ('creator','member')),
  choice          VARCHAR(10) NOT NULL CHECK (choice IN ('heads','tails')),
  stake           DECIMAL(18,8) NOT NULL CHECK (stake > 0),

  -- For proportional / founder_boost distribution. Default 1.0
  -- (weight = stake / per_member_stake).
  weight          NUMERIC(8,4) NOT NULL DEFAULT 1.0
                  CHECK (weight > 0),

  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Resolved impacts (set by group-bet-payout.ts at resolve time).
  payout_amount   DECIMAL(18,8) DEFAULT 0,
  is_winner       BOOLEAN,

  -- Balance snapshots at debit time — debug + auditor convenience.
  balance_before  DECIMAL(18,8),
  balance_after   DECIMAL(18,8),

  -- Per-member idempotency: one join per client_request_id.
  client_request_id VARCHAR(64),

  -- Lottery outcome (set only when turn_mode='random_lottery').
  lottery_winner  BOOLEAN,

  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gbm_user_recent
  ON group_bet_member(user_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbm_group
  ON group_bet_member(group_id);
CREATE INDEX IF NOT EXISTS idx_gbm_lottery
  ON group_bet_member(group_id, lottery_winner)
  WHERE lottery_winner IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbm_idempotency
  ON group_bet_member(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- TABLE: group_bet_invite
-- Logs every "share" action so we can attribute the first-time-deposit
-- bonus to the inviter (admin-configurable, default off in MVP).
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_bet_invite (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  inviter_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel         VARCHAR(20) NOT NULL
                  CHECK (channel IN (
                    'whatsapp','telegram','twitter','email','copy','qr','link'
                  )),
  invitee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  bonus_awarded   DECIMAL(18,8) NOT NULL DEFAULT 0,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gbi_group
  ON group_bet_invite(group_id);
CREATE INDEX IF NOT EXISTS idx_gbi_inviter_recent
  ON group_bet_invite(inviter_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- TABLE: group_bet_audit
-- Every state transition + admin action. The service layer mirrors
-- selected rows to the existing `audit_log` for system-wide visibility.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_bet_audit (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,

  -- NULL actor means "system" (expiry sweep, auto-flip, etc.)
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,

  action          VARCHAR(40) NOT NULL
                  CHECK (action IN (
                    'create',
                    'join',
                    'leave',
                    'ready',
                    'flip_start',
                    'flip_resolve',
                    'cancel',
                    'expire',
                    'refund',
                    'settle',
                    'lottery_pick',
                    'admin_force_cancel',
                    'admin_force_refund',
                    'admin_freeze',
                    'admin_unfreeze',
                    'admin_kick',
                    'admin_mark_fraud',
                    'admin_shadow',
                    'invite_share',
                    'bonus_award'
                  )),

  -- before/after delta, amounts, anything the operator needs.
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gba_group_recent
  ON group_bet_audit(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gba_actor_recent
  ON group_bet_audit(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- TRIGGER: keep updated_at fresh
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION group_bet_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_group_bet_updated_at ON group_bet;
CREATE TRIGGER trg_group_bet_updated_at
  BEFORE UPDATE ON group_bet
  FOR EACH ROW
  EXECUTE FUNCTION group_bet_set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- Migration marker — appended to the project-wide migrations log so
-- fresh-DB replays skip this file when not needed.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations (filename)
VALUES ('migrations-group-play.sql')
ON CONFLICT (filename) DO NOTHING;

-- ─── Extend audit_log.category enum to include 'group_play' ─────
-- The Phase-1 group-play service mirrors every state transition to
-- the system-wide audit_log. The existing audit_log_category_check
-- CHECK constraint was authored in 045 before group play existed,
-- so it doesn't allow 'group_play'. We drop + re-add here (same
-- constraint name) and add 'group_play' to the allowlist.
ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_category_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_category_check
  CHECK (category = ANY (ARRAY[
    'admin','auth','security','config','system','bonus','withdrawal',
    'wagering','rain','payment','affiliate','fraud','support','kyc',
    'group_play'
  ]::varchar[]));
