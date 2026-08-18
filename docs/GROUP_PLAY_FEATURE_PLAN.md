# CryptoFlip — Group Play Feature — Complete Operator Plan

**Author:** Hermes Agent
**Date:** 2026-07-28
**Status:** Draft for operator review. No code changes yet. Implementation begins after operator approval.
**Working title:** "Group Play" (replaces the current "Squad Flip" UX; the data model is rewritten; the feature is industry-standard by Stake.us / Rollbit / Roobet / BC.Game / Gamdom benchmark).
**Replaces:** `backend/src/services/socket-squad.ts` (319 lines), `frontend/components/game/SquadFlip.tsx` (351 lines), `squads` + `squad_members` tables.

---

## Table of Contents

- **Phase 0 — Why People Play in Groups (the human motivation)**
- **Phase 1 — System Design (data, services, API, sockets)**
- **Phase 2 — Admin Configuration (every knob the operator can turn)**
- **Phase 3 — Group Deposit & Withdraw (the money flow)**
- **Phase 4 — Fraud Cases (every threat, every defense)**
- **Phase 5 — Integration with Existing Systems**
- **Phase 6 — Player-Facing UI (screens + flows)**
- **Phase 7 — Test Plan**
- **Phase 8 — Migration Path & Rollout**
- **Phase 9 — Open Questions for the Operator**

---

## Phase 0 — Why People Play in Groups (the human motivation)

This section is the most important. If the operators don't understand *why* users will group-play, the rest of the design is just code. I've grouped motivations into 5 user archetypes and the system benefits they unlock.

### 0.1 The 5 archetypes

#### A. The Social Butterfly ("I play because friends play")

**Profile:** 22-yo Telegram user, 3-5 friends in a Whatsapp group, swings between CoinFlip and Crash. Plays 30-60 min/day.

**Motivation:** Wants to *share the experience*, not just play. Today he screenshots wins and pastes to the group chat. He'd rather play a single round together and have a story to tell.

**System feature he needs:**
- Share link via WhatsApp / Telegram / Twitter (one tap, native dialog)
- Group chat inside the round (so conversation stays in app)
- Group result broadcast back to the WhatsApp group (`"We just won $50 in CryptoFlip"`)

**If we don't build this:** He continues to play solo, screenshots, and we lose the **viral loop**.

**Why he'll come back tomorrow:** *"Will my friends join my next round?"*

#### B. The High-Roller ("I want to coordinate with other whales")

**Profile:** 30-yo crypto trader, $500-2000 per bet, plays Crash + Dice. Time-poor (15 min/day).

**Motivation:** He's read about Dice strategies and wants to compare exit-points with another whale. Or he wants to pool a big-bet with friends to **hedge against variance**.

**System feature he needs:**
- **Asymmetric stakes** — he wants to bet $1000, his friend bets $50, the payouts split proportionally
- **Multi-game support** — Dice, Crash, Plinko, not just CoinFlip
- **Private groups** — only with people he trusts (fraud-score low)

**If we don't build this:** He treats CryptoFlip as a single-player game and never tells his friends. We lose the **whale migration narrative**.

**Why he'll come back tomorrow:** *"I want to test my strat with a partner."*

#### C. The Casual Player ("I don't want to lose alone")

**Profile:** 35-yo office worker, sticks to $1-5 bets, plays 5 min/day, doesn't read docs.

**Motivation:** He's afraid of solo losing streaks. Group play feels **safer** because:
- Other members dilute the risk
- A group win is a *shared* win, even if his share is small
- He can copy his friend's choice (signal > noise)

**System feature he needs:**
- **Minimum-group-deposit guarantee** — he can see "you'll need $0.50 to join" before clicking
- **Easy invite** — single button, no copy-paste
- **Default equal split** — he doesn't need to think about distribution modes

**If we don't build this:** He plays solo, doesn't tell anyone, churns after 2 weeks.

**Why he'll come back tomorrow:** *"My friend joined. Let's roll together."*

#### D. The Streamer ("I want content")

**Profile:** 21-yo Twitch streamer, plays for an audience. Already plays Stake shared bets on stream.

**Motivation:** Solo play is unrewarding for content. **Group play with visible stakes is content.**

**System feature he needs:**
- **Spectator mode** — viewers can watch the round live without betting
- **Public history** — viewers can see past group wins
- **Group leaderboard** — "Top 10 groups by win rate" he can flaunt
- **Share card** — pre-formatted `🎉 @nox won $200 with 4 friends in CryptoFlip!` for Twitter

**If we don't build this:** He plays solo, his stream shows nothing new, we lose the **streamer organic marketing**.

**Why he'll come back tomorrow:** *"I want to top the leaderboard."*

#### E. The Coach / Tipster ("I bet on others' choices")

**Profile:** 28-yo old-school gambler, has a Telegram channel "CryptoFlip Tips", 5000 followers. Doesn't want to bet himself.

**Motivation:** He wants to **lead** a group of followers, watching them play his strategy. He takes a **founder-boost** for the visibility.

**System feature he needs:**
- **Founder-boost mode** — he gets 10% extra of the pool
- **Multi-member caps** — up to 50 followers per group (vs solo 5)
- **Public group page** — followers can find him
- **Optional invite-only** — only followers with the token can join

**If we don't build this:** He runs his predictions on Twitter and never integrates with our platform. We lose the **influencer-network effect**.

**Why he'll come back tomorrow:** *"My follower count is growing."*

### 0.2 The 5 system benefits we unlock (the business case)

For every archetype above, the **business side** wins:

| Benefit | How it arises |
|---|---|
| **Viral coefficient > 1** | Each new user adds 2-5 friends via invite link. Without group play, our growth is purely paid acquisition. |
| **Higher average deposit** | Groups pool money. A group of 5 friends each depositing $100 effects a $500 round, vs 5 solo $100 rounds. |
| **Lower churn** | Group players have social obligation (friend is waiting); solo players churn after a loss. |
| **Higher LTV** | Group creators (archetype E) become retainers. Streamers (D) bring their audience. |
| **Reduced fraud per dollar** | Group play is harder to multi-account because the co-members know each other. The peers are the fraud filter. |

### 0.3 Gamification we explicitly will and will NOT add

#### Will add (because it's proven to retain)
- **Group XP** — every finished round adds XP to the group; groups level up; cosmetics unlock
- **Group streak** — consecutive wins rack up; 3-win streak = bonus confetti
- **Founder kudos** — creator gets a "Top Founder" badge for founding 10+ groups
- **Member badges** — "veteran" (50 rounds played together), "good vibes" (positive chat sentiment)

#### Will NOT add (out of scope or anti-pattern)
- NFT-based group avatars (Speculative, gambling-adjacent)
- Voice chat (P2P complexity, fraud risk)
- Crypto-pooled groups (regulatory nightmare)
- Cross-platform group discovery (privacy risk)

---

## Phase 1 — System Design

### 1.1 Data model (migration 051)

```sql
-- 051_group_play_v2.sql
-- The full schema. The old `squads`/`squad_members` tables stay
-- as read-only history for 60 days (migration 052).

-- Replaces: squads, squad_members
-- New: group_bet, group_bet_member, group_bet_invite, group_bet_audit
-- Total: 4 new tables, 22 indexes, 8 CHECK constraints.

CREATE TABLE group_bet (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code             VARCHAR(10) UNIQUE NOT NULL,         -- 8-char base32, shareable
  name                   VARCHAR(60) NOT NULL,
  description            VARCHAR(500),
  creator_id             UUID NOT NULL REFERENCES users(id),
  game_type              VARCHAR(20) NOT NULL
                         CHECK (game_type IN ('coinflip','dice','crash','plinko','limbo')),
  game_params            JSONB NOT NULL,                      -- {target: 50, multiplier: 1.96}
  min_members            INTEGER NOT NULL DEFAULT 2 CHECK (min_members BETWEEN 2 AND 10),
  max_members            INTEGER NOT NULL DEFAULT 5 CHECK (max_members BETWEEN 2 AND 10),
  total_pool             NUMERIC(18,8) NOT NULL DEFAULT 0,
  status                 VARCHAR(20) NOT NULL DEFAULT 'waiting'
                         CHECK (status IN ('waiting','ready','playing','finished','cancelled','expired')),
  -- Distribution & turn
  payout_distribution    VARCHAR(20) NOT NULL DEFAULT 'proportional'
                         CHECK (payout_distribution IN ('equal','proportional','founder_boost')),
  founder_share_pct      NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (founder_share_pct BETWEEN 0 AND 30),
  turn_decision          VARCHAR(20) NOT NULL DEFAULT 'creator'
                         CHECK (turn_decision IN ('creator','auto_on_full','random_lottery')),
  -- Stake constraints
  contribution_min       NUMERIC(18,8) NOT NULL DEFAULT 0.10,
  contribution_max       NUMERIC(18,8) NOT NULL DEFAULT 10000,
  contribution_total_max NUMERIC(18,8) NOT NULL DEFAULT 50000,  -- max sum of all members
  -- Lifecycle
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at             TIMESTAMPTZ,
  finished_at            TIMESTAMPTZ,
  flip_actor_id          UUID REFERENCES users(id),
  flip_method            VARCHAR(20) CHECK (flip_method IN ('manual','auto','lottery')),
  -- Provably-fair random
  server_seed            VARCHAR(64),
  server_seed_hash       VARCHAR(64),
  client_seed            VARCHAR(64),
  result                 VARCHAR(20),
  result_raw             JSONB,
  won                    BOOLEAN,
  per_member_payout_avg  NUMERIC(18,8),
  audit_log_id           UUID REFERENCES audit_log(id),
  -- Mode flags (admin-configurable)
  is_private             BOOLEAN NOT NULL DEFAULT FALSE,
  is_featured            BOOLEAN NOT NULL DEFAULT FALSE,
  metadata               JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_group_bet_status ON group_bet(status);
CREATE INDEX idx_group_bet_creator ON group_bet(creator_id);
CREATE INDEX idx_group_bet_created ON group_bet(created_at DESC);
CREATE INDEX idx_group_bet_game_type ON group_bet(game_type) WHERE status IN ('waiting','ready');
CREATE INDEX idx_group_bet_finished ON group_bet(finished_at) WHERE status = 'finished';
CREATE INDEX idx_group_bet_lobby ON group_bet(status, game_type, max_members, created_at DESC)
  WHERE status IN ('waiting','ready');

CREATE TABLE group_bet_member (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  contribution    NUMERIC(18,8) NOT NULL CHECK (contribution > 0),
  weight          NUMERIC(8,4) NOT NULL DEFAULT 1.0,         -- contribution / sum(contrib)
  payout          NUMERIC(18,8) NOT NULL DEFAULT 0,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_via      VARCHAR(20) NOT NULL DEFAULT 'direct'
                  CHECK (joined_via IN ('direct','invite_link','invite_token','qr','share_link')),
  invite_token_id UUID REFERENCES group_bet_invite(id),
  left_at         TIMESTAMPTZ,
  is_creator      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Anti-fraud
  joined_ip       INET,
  joined_fingerprint VARCHAR(64),
  UNIQUE (group_id, user_id)
);
CREATE INDEX idx_member_group ON group_bet_member(group_id);
CREATE INDEX idx_member_user ON group_bet_member(user_id);

CREATE TABLE group_bet_invite (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token           VARCHAR(32) UNIQUE NOT NULL,             -- 16-char base32
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  invited_user_id UUID REFERENCES users(id),
  invitee_fingerprint VARCHAR(64),
  invitee_ip      INET,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  redeemed_at     TIMESTAMPTZ,
  -- Rewards: inviter + invitee
  inviter_bonus_coins  NUMERIC(18,8) DEFAULT 0,
  invitee_bonus_coins  NUMERIC(18,8) DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID NOT NULL REFERENCES users(id),
  -- Campaign tracker (for marketing attribution)
  campaign        VARCHAR(40) DEFAULT 'organic'
);
CREATE INDEX idx_invite_token ON group_bet_invite(token);
CREATE INDEX idx_invite_group ON group_bet_invite(group_id);
CREATE INDEX idx_invite_user ON group_bet_invite(invited_user_id);

CREATE TABLE group_bet_audit (
  id              BIGSERIAL PRIMARY KEY,
  group_id        UUID NOT NULL REFERENCES group_bet(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  action          VARCHAR(40) NOT NULL
                  CHECK (action IN ('created','invited','joined','left','started','flipped','finished','cancelled','expired','refunded','admin_force')),
  details         JSONB NOT NULL DEFAULT '{}',
  ip_address      INET,
  user_agent      VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_group ON group_bet_audit(group_id, created_at);
```

### 1.2 State machine

```
                    ┌────────────────┐
                    │  WAITING       │  ← creator + 0..N-1 members
                    │  (anytime)     │
                    └────────┬───────┘
                             │ N >= min_members AND all members confirmed stakes
                             ▼
                    ┌────────────────┐
                    │  READY         │
                    │  (locked)      │
                    └────────┬───────┘
                             │ flip event triggered (creator | auto_countdown | lottery)
                             ▼
                    ┌────────────────┐
                    │  PLAYING       │
                    │  (commit lock) │
                    │  spin anim     │
                    └────────┬───────┘
                             │ owner decides result (server reveals seed)
                             ▼
                    ┌────────────────┐
                    │  FINISHED      │  (terminal)
                    │  payout split  │
                    └────────────────┘

  EDGES:
  WAITING → EXPIRED    (expires_at < NOW() before PLAYING)
  WAITING → CANCELLED   (creator only)
  READY → CANCELLED     (creator or last-member-out)
  PLAYING → FINISHED    (commit)
  EDGE → REFUNDED       (admin_force during WAITING/READY)
```

### 1.3 Service layer (8 new files)

```
backend/src/services/group-bet/
├── index.ts                              # public exports
├── group-bet.service.ts                  # CRUD on group_bet
├── group-bet-invite.service.ts           # token gen + redemption
├── group-bet-flip.service.ts             # the actual flip (refactor of socket-squad.ts)
├── group-bet-distribution.service.ts     # payout math (equal | proportional | founder_boost)
├── group-bet-deposit.service.ts          # member stake handling (Phase 3)
├── group-bet-withdraw.service.ts         # group-level withdraw (Phase 3)
├── group-bet-lobby.service.ts            # browse open groups
├── group-bet-audit.service.ts            # writes to group_bet_audit
├── group-bet-rules.ts                    # business rules (rate limits, validation)
└── group-bet-fraud.service.ts            # fraud detection (Phase 4)
```

### 1.4 REST endpoints (15 — new file `/api/groups/`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/groups` | user | Create group |
| GET | `/api/groups/:id` | user | Fetch group detail |
| GET | `/api/groups/:id/members` | user | List members + contributions |
| POST | `/api/groups/:id/join` | user | Join with `{ contribution: number }` |
| DELETE | `/api/groups/:id/members/:userId` | user | Leave (only if status='waiting') |
| POST | `/api/groups/:id/invite` | user | Create invite token |
| GET | `/api/groups/invites/:token` | public | Resolve token (returns group summary) |
| POST | `/api/groups/:id/cancel` | user | Cancel (creator only) |
| POST | `/api/groups/:id/flip` | user | Trigger flip |
| GET | `/api/groups/lobby?game=coinflip` | user | Browse open groups |
| GET | `/api/groups/user/active` | user | My active groups |
| GET | `/api/groups/user/history?limit=50` | user | My history |
| GET | `/api/groups/friends/active` | user | Friends' active groups |
| POST | `/api/groups/:id/confirm-stake` | user | Confirm stake (after join) |
| GET | `/api/groups/:id/audit` | user | Group audit log (creator only) |

### 1.5 Socket events (new namespace `group:*`)

| Direction | Event | Payload |
|---|---|---|
| C→S | `group:create` | full group config |
| C→S | `group:join` | `{ groupId, contribution }` |
| C→S | `group:leave` | `{ groupId }` |
| C→S | `group:flip` | `{ groupId }` |
| C→S | `group:cancel` | `{ groupId }` |
| S→C | `group:created` | `{ groupId, groupCode, ...summary }` |
| S→C | `group:update` | `{ members, totalPool, status }` |
| S→C | `group:invite:redeemed` | `{ groupId, newMemberId }` |
| S→C | `group:spinning` | `{ groupId, flipActorId, serverSeedHash, clientSeed, flipMethod }` |
| S→C | `group:result` | `{ groupId, result, won, payouts: {userId: amount}, verification }` |
| S→C | `group:error` | `{ code, message }` |

---

## Phase 2 — Admin Configuration (every knob the operator can turn)

### 2.1 The 24 settings the operator gets

These extend the existing `admin-game-config.ts` (which already has `squadEnabled`, `squadHouseEdgePercent`, `maxSquadSize`). They follow the same `{ label, description, type, category, min, max }` shape.

| # | Setting Key | Type | Default | Min | Max | Category | Description |
|---|---|---|---|---|---|---|---|
| 1 | `groupPlayEnabled` | `boolean` | `false` | — | — | Group Play | Master toggle — kills all groups if off |
| 2 | `groupPlayAllowedCountries` | `string[]` | `*` | — | — | Group Play | ISO country codes; "*" = everyone |
| 3 | `groupPlayBlockedCountries` | `string[]` | `[sanctioned]` | — | — | Group Play | Hard-blocked (regulatory) |
| 4 | `groupDefaultMinMembers` | `number` | `2` | `2` | `10` | Group Play | Default min players when group is created |
| 5 | `groupDefaultMaxMembers` | `number` | `5` | `2` | `10` | Group Play | Default max players |
| 6 | `groupAbsoluteMaxMembers` | `number` | `10` | `2` | `10` | Group Play | Hard cap (overrides user choice) |
| 7 | `groupDefaultContributionMin` | `number` | `0.10` | `0.01` | `1000` | Group Play | Default min stake per member |
| 8 | `groupDefaultContributionMax` | `number` | `10000` | `1` | `50000` | Group Play | Default max stake per member |
| 9 | `groupAbsolutePoolCap` | `number` | `50000` | `100` | `1000000` | Group Play | Hard cap on total pool |
| 10 | `groupExpiryMinutes` | `number` | `30` | `5` | `1440` | Group Play | Default time-to-live before WAITING → EXPIRED |
| 11 | `groupAutoFlipCountdownSeconds` | `number` | `5` | `3` | `30` | Group Play | For `auto_on_full` turn mode |
| 12 | `groupDefaultPayoutDistribution` | `enum` | `proportional` | — | — | Group Play | `equal | proportional | founder_boost` |
| 13 | `groupDefaultTurnDecision` | `enum` | `creator` | — | — | Group Play | `creator | auto_on_full | random_lottery` |
| 14 | `groupDefaultFounderSharePct` | `number` | `10` | `0` | `30` | Group Play | For `founder_boost` mode |
| 15 | `groupHouseEdgePercent` | `number` | `1.0` | `0.1` | `5` | Group Play | House edge on group wins (decoupled from solo % so group can be promoted) |
| 16 | `groupLossHouseEdgePercent` | `number` | `0` | `0` | `1` | Group Play | Sometimes you want to take a tiny edge on losses too (e.g. for plinko) |
| 17 | `groupInviterBonusCoins` | `number` | `0` | `0` | `100` | Group Play | Coins credited to inviter when invitee joins via token |
| 18 | `groupInviteeBonusCoins` | `number` | `0` | `0` | `100` | Group Play | Coins credited to invitee when they join via token |
| 19 | `groupInviterBonusCapPerUserPerDay` | `number` | `50` | `0` | `500` | Group Play | Anti-fraud cap on inviter bonuses |
| 20 | `groupInviteMaxRedemptionsDefault` | `number` | `1` | `1` | `100` | Group Play | How many times a single invite token can be redeemed |
| 21 | `groupInviteExpiryHoursDefault` | `number` | `168` | `1` | `720` | Group Play | Default invite token TTL (7 days default) |
| 22 | `groupSpectatorModeEnabled` | `boolean` | `true` | — | — | Group Play | Toggle spectator view of in-progress groups |
| 23 | `groupPrivateAllowed` | `boolean` | `true` | — | — | Group Play | Allow `is_private=true` groups |
| 24 | `groupMinHouseEdgeSpreadVsSolo` | `number` | `0.5` | `0` | `2` | Group Play | Minimum extra house edge for groups (vs solo) to prevent arb |

These are inserted into `admin_settings` (existing table) via migration 053 or directly via `squad` → `group` rename to `group_play` category.

### 2.2 Admin UI — new `/admin/groups` page

```
┌─────────────────────────────────────────────────────────────┐
│ Group Play — Admin Console                  [logout] [user]   │
├─────────────────────────────────────────────────────────────┤
│ ┌─Tabs─┐ ┌────────────────────────────────────────────────────┐  │
│ │ Live │ │ Active groups (47)        |  Filter by: game [▼] |  │
│ │ Hist │ │ ─────────────────────────────────────────────────  │  │
│ │ Config │  Group #4X7K  · coinflip · 3/5 · $15 pool · 2m ago│  │
│ │ Fraud │  [view] [force-cancel] [refund] [audit] [shadow]   │  │
│ │ Lead │                                                    │  │
│ └─────┘  Group #9P2M  · crash · 4/4 · $200 pool · 5m ago     │  │
│          [view] [force-cancel] [refund] [audit] [shadow]    │  │
│          ...                                                 │  │
│                                                              │
│          HOUSE EDGE TODAY: $234.50   INVITES REDEEMED: 127  │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Admin actions per group (the operator's toolkit)

| Action | When | What it does |
|---|---|---|
| **view** | always | Full group detail (members, flips, stakes, audit) |
| **force-cancel** | WAITING or READY | Cancels group, refunds all members |
| **refund** | FINISHED with dispute | Reverses the payout, credits back the original stakes |
| **audit** | always | Full event log with IP, fingerprint, timestamps |
| **shadow** | suspected fraud | Joins the group as a silent observer (read-only) |
| **kick** | READY only | Removes a member (refunds their contribution) |
| **freeze** | any | Locks group (no further state transitions) |
| **mark-fraud** | confirmed bad | Adds to `fraud_signals` + forces refund + bans members |

### 2.4 Admin actions per user (group-specific)

| Action | What it does |
|---|---|
| **view groups** | All groups the user is in (active + history) |
| **block from groups** | User can no longer create or join groups (solo play still works) |
| **set group deposit limit** | Per-user cap on how much they can put in a single group |
| **set group daily limit** | Per-user daily total (sum of contributions) |
| **reverse group winnings** | For confirmed fraud — reverses the credit |

### 2.5 Configuration change audit

Every change to any of the 24 settings writes an `audit_log` row with `category='config'`, `action='group_config_change'`, `details={key, old_value, new_value, admin_id}`. This is enforced by the existing `admin-config.ts` update path.

---

## Phase 3 — Group Deposit & Withdraw

### 3.1 The money flow (what users actually do)

#### Group Deposit (= "stake" or "contribution")

A "group deposit" is **each member's individual contribution to the group pool**. There's no single "group deposit" — each member contributes their own amount.

```
Member A (creator):     $50 contribution  ─┐
Member B (invitee):     $50 contribution   ├─→ group_bet.total_pool = $150
Member C (invitee):     $50 contribution  ─┘
```

The creator's stake is debited at group creation. Other members' stakes are debited at join time. The group is "READY" only when min_members have all confirmed contribution.

#### Group Withdraw (when a group is cancelled before flipping)

If a group is cancelled (status `WAITING` → `CANCELLED`) or expired (`WAITING` → `EXPIRED`):
- All members' contributions are **refunded** to their `users.balance`
- Each member's `group_bet_member.payout` is set to 0
- A `group_bet_audit` row is written: `action='cancelled'`, `details={reason: 'creator' | 'expired' | 'admin'}`

#### Group Payout (when a group wins)

When the group wins:
- `total_pool` is calculated from sum of contributions
- House edge is subtracted: `payout_pool = total_pool × (1 - houseEdge/100)`
- Distribution is applied per `payout_distribution` mode (see §3.3)
- Each member's `users.balance` is credited with their calculated payout
- Each member's `group_bet_member.payout` is updated
- `audit_log` row written: `action='finished', details={won: true, total_payout, distribution: 'proportional'}`

#### Group Loss (when the group loses)

When the group loses:
- All members' contributions are debited (already done at JOIN) — the **pool goes to the house**
- Each member's `payout` is 0
- No balance changes at flip time (debit already happened at join)
- A loss is recorded in `house_ledger` for accounting (Phase 3 of the previous redesign doc)

### 3.2 The "minimum deposit" feature

The user explicitly asked: **"group minimum deposit"**. This means:

**Per-group rules** (creator sets):
- `contribution_min` — floor for any member
- `contribution_max` — ceiling for any member
- `contribution_total_max` — ceiling for the sum

**Per-user rules** (admin sets):
- `group_min_house_balance` — user must have at least this much `balance` to join
- `group_min_deposit_history` — user must have deposited at least this much historically (e.g. $50 lifetime deposits)

The user's intent is: **"don't let brand-new accounts with $0 balance spam group play"**. A minimum deposit gate is the simplest way to enforce this.

Implementation:
```ts
// In group-bet.service.ts
async function validateJoin(userId: UUID, groupId: UUID, contribution: number) {
  const user = await getUser(userId);
  const group = await getGroup(groupId);
  const config = await getAdminConfig();

  // 1. Per-group rules
  if (contribution < group.contribution_min) throw new Error(`Below minimum (${group.contribution_min})`);
  if (contribution > group.contribution_max) throw new Error(`Above maximum (${group.contribution_max})`);
  if (group.total_pool + contribution > group.contribution_total_max) throw new Error('Group pool would exceed cap');

  // 2. Per-user rules
  if (user.balance < contribution) throw new Error('Insufficient balance');
  if (user.balance < config.group_min_house_balance) throw new Error(`Need at least ${config.group_min_house_balance} balance`);

  // 3. Lifetime deposit gate
  const lifetimeDeposits = await query(
    `SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'confirmed'`,
    [userId]
  );
  if (parseFloat(lifetimeDeposits.rows[0].sum) < config.group_min_user_deposit_history) {
    throw new Error(`Lifetime deposit must be ≥ ${config.group_min_user_deposit_history}`);
  }

  return true;
}
```

### 3.3 The 3 distribution modes (math)

#### Equal
```
total_pool = sum(member.contribution)
payout_pool = total_pool × (1 - houseEdge/100)
payout_per_member = payout_pool / member_count
```

#### Proportional (Stake-based)
```
weight_i = member_i.contribution / total_pool
payout_i = weight_i × payout_pool
```

#### Founder-boost
```
founder_payout = founder_share_pct/100 × payout_pool  +  (creator.contribution / total_pool) × remainder
non_founder_pool = payout_pool - founder_payout
non_founder_payout_each = non_founder_pool / (member_count - 1)
```

(Where `remainder = payout_pool - (founder_share_pct/100 × payout_pool)`)

### 3.4 Group-withdraw / Refund (admin + auto)

When a group is cancelled or expired:
- Server triggers `group_bet_withdraw.service.ts:cancelAndRefund(groupId)`
- Iterates members, credits their `users.balance` with `contribution`
- Writes `audit_log` row (category='group', action='refund') for each refund
- Updates `group_bet.status = 'cancelled'`
- Updates `group_bet_member.payout = 0`

When admin marks a group as fraud:
- Same as above BUT only credits to `users.balance` of CONFIRMED good actors
- Confirmed fraudsters get nothing (their contribution is forfeit)
- House edge is recovered

### 3.5 Example flow (real numbers)

**Setup:**
- Creator: Alice wants to play with 2 friends
- Bob and Carol are invited via Telegram
- Game: CoinFlip
- Mode: Proportional
- Each wants to bet $100

**Timeline:**
1. Alice creates group → `group_bet.total_pool = 0` (not yet)
2. Alice's $100 is debited, `group_bet_member(Alice, contribution=100, payout=0)`, `total_pool = 100`
3. Alice shares invite link via Telegram
4. Bob clicks link → `/game?group=X7K9P2M4`
5. Bob logs in (or already logged in) → joins with $100 → `total_pool = 200`
6. Carol clicks link → joins with $100 → `total_pool = 300`
7. Group is now READY (3 of min 2)
8. Alice clicks FLIP (creator mode) → server reveals seed
9. Result: HEADS (Alice's choice) → WIN
10. House edge: 1.0% → payout_pool = 300 × 0.99 = $297
11. Proportional: each gets $99 (since each contributed 1/3)

**Without group play, 3 separate solo games:
- 3 × $100 = $300 risked
- Each wins $99 (assuming same 1% edge)
- Same payout BUT no shared experience, no chat, no story

The difference is **social**, not monetary. **That's the entire product.**

---

## Phase 4 — Fraud Cases (every threat, every defense)

Fraud is the most important non-feedback component of group play. Solo fraud is bounded by 1 user = 1 fraud. Group fraud can involve **N users conspiring** to defraud the house. This section enumerates every realistic threat and the corresponding defense.

### 4.1 Threat matrix

| # | Threat | Severity | Likelihood | Detection | Response |
|---|---|---|---|---|---|
| F1 | **Sybil multi-account** — one person creates 5 accounts, joins own group, wins | HIGH | HIGH | Same IP cluster, same device fingerprint, same email pattern | Force-refund + permanent ban |
| F2 | **Invite farming** — bot creates 1000 groups/hour, shares links, gets bonus | MED | HIGH | Rate-limit per IP, per fingerprint, per device | Limit bonuses, freeze bot |
| F3 | **Front-group collusion** — A, B, C all share a wallet/withdrawal, play in groups only | HIGH | MED | Co-withdrawal detection, shared 2FA analysis | Flag for review, freeze withdrawals |
| F4 | **Fraud founder** — creator invites bots, gets founder-boost, all bots lose intentionally | HIGH | LOW | Founder win rate analysis, invitee churn rate | Block founder mode for new accounts |
| F5 | **Auto-flip exploit** — auto-flip's 5s countdown is too short for the creator to cancel a losing bet | MED | MED | Add 10s grace + countdown notification | Default to creator mode |
| F6 | **Payout sniping** — once a group is created, large funds are deposited to crash the pool | MED | LOW | `contribution_total_max` + creation-time check | Already mitigated by pool cap |
| F7 | **Mid-flip cashout** — leave a group between READY and PLAYING | MED | MED | Lock members at READY transition | Don't allow leave after READY |
| F8 | **False refund claims** — user claims "I never got credited" → admin refunds → user double-credits | HIGH | MED | Idempotency keys + audit timestamps | Show audit to admin |
| F9 | **Provably-fair evasion** — server picks unflipped result | HIGH | LOW | Server seed hash shown BEFORE flip, revealed AFTER | Already done by existing `provably-fair` module |
| F10 | **Withdraw timing attack** — group win → fast withdraw before balance is "settled" | MED | MED | Withdrawal cooldown after large group win | 24h hold for groups > $5000 |
| F11 | **Loss chargeback** — large group loss → user chargebacks deposit | HIGH | LOW | Limited to crypto-only funds | Crypto-only deposit (no fiat) |
| F12 | **Multi-fingerprint abuse** — same hardware, multiple users | HIGH | MED | Device fingerprint (already P1-12) | Cap to 3 accounts per fingerprint |
| F13 | **Group chat spam** — group chat becomes phishing vector | MED | MED | Profanity filter, link block, admin mute | Emit fraud signal if pattern matches |
| F14 | **Group name abuse** — using group name for advertising / slurs | MED | MED | Profanity filter, manual review | Block name + admin nudge |
| F15 | **Bootstrapping via invite** — create group → invite yourself → play alone | HIGH | MED | min_members enforcement + reject group if creator leaves before READY | Already enforced |
| F16 | **Geo-block bypass** — VPN to circumvent country restrictions | HIGH | MED | GeoIP + VPN detection | Auto-block + flag |
| F17 | **Money laundering** — split large deposit across many groups, lose intentionally, withdraw cleanly | HIGH | MED | Loss-after-large-deposit pattern + cluster analysis | Delay withdrawals, manual review |
| F18 | **Fake founder** — creator claims to be Tipster X, but isn't | LOW | MED | Optional identity verification | Soft gate (badge) |
| F19 | **Compromised creator** — attacker takes over creator's account, creates group, drains invitees | HIGH | LOW | 2FA on group creation > $1000 | Enforce 2FA threshold |
| F20 | **Internal fraud** — admin creates group with friends, fraud-claims refund | HIGH | LOW | 4-eyes principle for refunds > $5000 | Already enforced (admin needs 2FA) |

### 4.2 Specific fraud cases (the big 5)

#### Case A — Sybil multi-account ("Sibylla")

**Scenario:** A creates 5 accounts. A invites B (`a1@x.com`), C (`a2@x.com`), D (`a3@x.com`), E (`a4@x.com`). All from same IP `203.0.113.42`, same fingerprint `abc123`. They all join Alice's group. Alice flips. They all win. Alice's 5 accounts each cash out $100. Total: $500 withdrawn from a single person.

**Defense:**
1. **At join time:** Detect IP cluster with 2+ other members → emit `fraud_signals` row, severity=`high`, `signal_type='group_sybil_suspected'`
2. **At invite time:** Cap to 3 invites per IP per 24h
3. **At withdraw time:** If `group_bet_member` has a co-located fingerprint, force-2FA + manual review (1-3 day hold)
4. **At settlement:** If group has 3+ members from same IP/fingerprint, automatic `category='group', action='refund_fraud'`, all members refunded, group owner banned

**Operator dashboard:** New `/admin/groups/fraud` page shows realtime list of suspected sybil groups.

#### Case B — Invite farming ("Botto")

**Scenario:** Bot creates 1000 groups/hour, shares invite links to its own bots, each bot joins, the inviter bonus is credited. Bot's 1000 accounts each get +5 coins = 5000 coins/hour.

**Defense:**
1. `groupInviterBonusCoins = 0` by default (operator can enable for campaigns)
2. `groupInviterBonusCapPerUserPerDay = 50` (admin-configurable)
3. If `redemption_count > 10` per token per hour → freeze token
4. If `redemptions > 100` per `created_by` user per day → freeze account

#### Case C — Founder collusion ("The Wolves")

**Scenario:** Three friends agree to always play together with founder-boost. They always choose the lowest-multiplier game. Long-run, founder-boost gives them 10% extra, but they also lose 90% of their stake. If they deposit $1000 and play 100 rounds, they "lose" $90,000 but the founder gets $9000 free. They withdraw the original $1000 + the $9000 = $10,000. House loses $0... unless they ALL cash out, then house has lost $9000.

**Math:** If 3 players each bet $100 with 10% founder boost:
- Pool: $300
- Loss: all 3 lose → house takes $300 (no founder boost on loss)
- Win: pool pays $297 → founder gets $29.70 (10% boost) + own share $99 = $128.70, others get $84.15 each

Win rate 50%: House expected value per round = $1.50 (1% edge on solo) × 3 members = $4.50 per round. With founder boost, expected loss = $0.045 per round (negligible). So founder boost is **not** a fraud enabler — it's a retention feature.

**Defense:** Monitor `founder_win_rate` stats. If founder's win rate > 60% over 100+ rounds → flag for review.

#### Case D — Withdrawal timing attack ("The Quicker")

**Scenario:** Group wins $50,000. Winner tries to withdraw immediately. If we don't have a hold, the funds leave the house hot-wallet before we can reverse if fraud is detected.

**Defense:**
- `groupWithdrawalHoldHours = 24` for groups with `total_pool > $5000`
- `groupWithdrawalHoldHours = 0` for groups with `total_pool < $100`
- Linear: `hold = clamp(total_pool / 1000, 0, 168)` (in hours, max 7 days)
- User is shown: "Your group win can be withdrawn after [hold time]"

#### Case E — Mid-flip exit ("The Quitter")

**Scenario:** Group is READY. Alice (creator) realizes she's about to lose. She tries to leave the group to recover her stake. If she can leave, the group has 4 members but the creator got refunded.

**Defense:**
- Lock at READY transition: `group_bet_member.left_at IS NULL` once `status='ready'`
- A forced mid-flip exit by admin refunds the whole group (admin_force action)

### 4.3 Real-time fraud signals (emitted to `fraud_signals` table)

The group-bet service emits these signals automatically:

| Signal type | Trigger | Severity |
|---|---|---|
| `group_sybil_suspected` | 3+ members share IP OR fingerprint | high |
| `group_invite_farm_suspected` | token redeemed > 10 times in 1 hour | medium |
| `group_founder_collusion` | founder_win_rate > 60% over 50+ rounds | medium |
| `group_withdraw_hold` | group_pool > $5000 | info |
| `group_unusual_pattern` | 5+ groups joined in 1 hour from same IP | high |
| `group_vpn_suspected` | 2+ members from VPN/proxy range | high |
| `group_compromised_creator` | group created from new device + 2FA + > $5000 | high |
| `group_admin_force` | admin triggered refund | info |

Each signal:
- Writes a `fraud_signals` row (existing table)
- Cross-references with `admin-fraud-config.ts` thresholds
- Slack/Discord notification if severity >= medium (uses existing `fraud-alerts.ts`)
- Visible on `/admin/groups/fraud` page

### 4.4 Settlement rules (the "what happens when X")

| Scenario | Outcome |
|---|---|
| Group wins, no fraud signal | All members credited per distribution mode |
| Group wins, sybil signal, < 50% linked | Process normally, manual review later |
| Group wins, sybil signal, ≥ 50% linked | Force refund all members, ban linked accounts |
| Group loses, no fraud signal | Pool goes to house edge (1% retained) |
| Group loses, fraud signal | Pool already gone, accounts banned |
| Group cancelled before READY | All contributions refunded |
| Group cancelled after READY (by admin) | All contributions refunded (admin_force) |
| Group expired (30 min no flip) | All contributions refunded |
| Group finished, fraud detected within 24h | Reverse credits, debit balances, redistribute |
| Group finished, fraud detected after 24h | Manual review, possible partial reclaim |

---

## Phase 5 — Integration with Existing Systems

### 5.1 Schema integration

The new `group_bet` table integrates with:
- `users` (creator_id, members, audit) — FK refs already in place
- `audit_log` (every group action) — already wired
- `fraud_signals` (group fraud signals) — already wired
- `transactions` (NOT used — group activity is in `group_bet_member.contribution` only; the actual balance changes are on `users.balance`)
- `house_ledger` (NEW from the previous §4 design) — group wins/losses count as house edge

### 5.2 Service integration

| Existing service | Integration |
|---|---|
| `admin-game-config.ts` | Add the 24 settings (Phase 2) |
| `admin-config.ts` (domain splitter) | `group-bet-config.ts` as new domain module |
| `bonus.ts` | Bonus wagering still applies; group wins count as "bet" for clearing |
| `withdrawal-risk.service.ts` | New source: `groupRecentWinAmount` |
| `fraud-alerts.ts` | New channel: `group_fraud` |
| `device-fingerprint.ts` | Group members' fingerprints join on group |
| `ip-whitelist.ts` | Group creators on the IP whitelist |
| `cohort-analysis.ts` | Group play as a new cohort dimension |
| `metrics.ts` | 9 new prometheus metrics (Phase 1 §1.4 from previous doc) |
| `socket-shared.ts` | `onlineUsers` already tracks member presence (good) |
| `componehf/socket-squad.ts` | **REPLACED** by `socket-group.ts` |
| `frontend/components/game/SquadFlip.tsx` | **REPLACED** by `frontend/components/group/GroupLobby.tsx` |

### 5.3 Configuration changes

The `admin_settings` table gets 24 new rows (Phase 2). Migration 053 inserts them with current defaults. The existing `squadEnabled`, `squadHouseEdgePercent`, `maxSquadSize` get DEPRECATED (keep for 60 days as read-only, then archived).

### 5.4 Observability

```
NEW Prometheus metrics:
- group_bets_created_total{game_type, mode, payout_distribution}
- group_bets_joined_total{via, game_type}
- group_bet_invites_issued_total{campaign}
- group_bet_invites_redeemed_total
- group_bets_finished_total{game_type, won, mode}
- group_bet_house_edge_earned_coins{currency}
- group_bet_pool_size_coins histogram
- group_bet_duration_seconds histogram
- group_bet_active gauge
- group_fraud_signals_total{signal_type, severity}

NEW admin dashboard:
- /admin/groups (live + history + config + fraud + leaderboard)
- /admin/groups/config (the 24 settings)
- /admin/groups/fraud (real-time fraud signals)
- /admin/groups/leaderboard (top creators, top groups)
```

---

## Phase 6 — Player-Facing UI

### 6.1 Main game page (revised)

```
┌─────────────────────────────────────────────────────────────┐
│ Logo  Header  Balance  [Group]  [History]  [User]            │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────┐  ┌──────────────────────────┐  │
│ │  LIVE COIN FLIP          │  │  🎲 GROUP PLAY            │  │
│ │  (existing solo UI)      │  │  [Create group]          │  │
│ │                          │  │  [Join with code]        │  │
│ │                          │  │                          │  │
│ │                          │  │  ──── ACTIVE GROUPS ──── │  │
│ │                          │  │  Group #4X7K  3/5  $15   │  │
│ │                          │  │  Group #9P2M  4/4  $200  │  │
│ │                          │  │  Group #K3LR  2/5  $2    │  │
│ │                          │  │  [Browse all 47 →]      │  │
│ │                          │  │                          │  │
│ │                          │  │  ──── FRIENDS' GROUPS ── │  │
│ │                          │  │  Bob joined #4X7K 2m ago │  │
│ │                          │  │  Carol won #K3LR 5m ago │  │
│ │                          │  │                          │  │
│ └─────────────────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Create group wizard (4 steps)

```
┌─────────────────────────────────────────────────────────────┐
│ Create a Group                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Step 1: Pick a game          Step 2: Configure parameters │
│  ┌────────┐ ┌────────┐ ┌────────┐  (game-specific)         │
│  │ 🪷     │ │ 🎲     │ │ 📈     │  ─────────────────────   │
│  │ CoinFlip│ │ Dice  │ │ Crash │  Target: [50]            │
│  │ 50/50   │ │ target│ │ multiplier│  Max members: [5]      │
│  └────────┘ └────────┘ └────────┘  Min stake: [$1]         │
│                                   Max stake: [$1000]      │
│                                                             │
│ Step 3: Distribution         Step 4: Turn decision        │
│  ─────────────────────       ─────────────────────       │
│  ⦿ Proportional              ⦿ Creator flips             │
│  ○ Equal split                ○ Auto when full            │
│  ○ Founder boost (10%+)       ○ Random lottery           │
│                                                             │
│  Group name: [My Squad vs The World]                      │
│  Description (optional): [                                  │
│  ]                                                          │
│                                                             │
│                    [CREATE GROUP →]                         │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Share modal (after creation)

```
┌─────────────────────────────────────────────────────────────┐
│ 🎉 Group created!                                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [QR CODE]                  Group code: X7K9P2M4           │
│                              https://cf.bet/g/X7K9P2M4       │
│                                                             │
│  Share via:                 [WhatsApp] [Telegram]          │
│  [WhatsApp] [Telegram]      [Twitter]  [Email]             │
│  [Twitter] [Email]          [Copy]    [QR]                │
│                                                             │
│  Invite bonuses: 🪙 +5 coins for them, +5 for you          │
│  (until your daily cap: 50 coins)                          │
│                                                             │
│                          [DONE]                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 Group lobby (while waiting/playing)

```
┌─────────────────────────────────────────────────────────────┐
│  My Squad vs The World           [leave] [cancel] [share]    │
├─────────────────────────────────────────────────────────────┤
│  Code: X7K9P2M4  ·  🎲 CoinFlip  ·  3 of 5 members          │
│  Pool: $150.00  ·  expires in 23:42                         │
│  ──────────────────────────────────────────────────         │
│  Members:                                                    │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐                     │
│  │ 👤 │  │ 👤 │  │ 👤 │  │ ?  │  │ ?  │                     │
│  │ alice│  │ bob │  │ carol│  │     │  │                     │
│  │ $50 │  │ $50 │  │ $50 │  │     │  │                     │
│  └────┘  └────┘  └────┘  └────┘  └────┘                     │
│  ──────────────────────────────────────────────────         │
│  Distribution: Proportional (each gets 1/3 of pool)         │
│  Turn: Creator flips (Alice)                                │
│  ──────────────────────────────────────────────────         │
│  Recent activity: ← scroll                                  │
│  · Carol joined 30s ago                                      │
│  · Bob joined 1m ago                                         │
│  · Alice created 2m ago                                      │
│  ──────────────────────────────────────────────────         │
│                          [ FLIP ]                           │
│  (only Alice can flip until group is full)                  │
└─────────────────────────────────────────────────────────────┘
```

### 6.5 Flip animation (group view)

```
┌─────────────────────────────────────────────────────────────┐
│  My Squad vs The World                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    🪷 ← spinning → 🪷                       │
│                                                             │
│  Alice is flipping... (server seed: 7a3f...b91d)             │
│  Mode: Manual                                                │
│                                                             │
│  Pool: $150.00  ·  3 members                                │
│  Potential payout: $148.50 each (if HEADS, after 1% edge)   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.6 Result screen

```
┌─────────────────────────────────────────────────────────────┐
│  🎉 SQUAD WON!                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Cloud: HEADS won                                            │
│                                                             │
│  Pool: $150.00      House edge: $1.50      Payout: $148.50 │
│                                                             │
│  ──────── Payouts (proportional) ────────                   │
│  alice:    $49.50  ←creator                                │
│  bob:      $49.50                                            │
│  carol:    $49.50                                            │
│                                                             │
│  ──────── Provably Fair ────────                             │
│  Server seed: 7a3f9bf2...b91d                                │
│  Server seed hash: a8c2... matched the one shown before flip  │
│  Client seed: squad_X7K9P2M4_3                              │
│                                                             │
│  [Play again]  [Share result]  [Back to game]              │
└─────────────────────────────────────────────────────────────┘
```

### 6.7 Deep-link landing page

**User clicks link → not logged in:**
```
┌─────────────────────────────────────────────────────────────┐
│  Alice invited you to play!                                  │
│  "My Squad vs The World" — CoinFlip, 3 of 5 players       │
│  Pool: $150.00                                               │
│  ──────────────────────────────────────────────────         │
│                                                             │
│  [Log in]      [Register]                                   │
│                                                             │
│  🪙 +5 coins free when you join!                            │
└─────────────────────────────────────────────────────────────┘
```

**User clicks link → logged in:**
```
┌─────────────────────────────────────────────────────────────┐
│  Alice invited you to play!                                  │
│  "My Squad vs The World" — CoinFlip, 3 of 5 players       │
│  Pool: $150.00  ·  3 of 5 already joined                    │
│  ──────────────────────────────────────────────────         │
│                                                             │
│  Your contribution:                                         │
│  Min: $1.00    Max: $1000                                  │
│  Recommended: $50.00                                        │
│  [+] [-]  $ 50.00                                           │
│                                                             │
│  Distribution: Proportional (each gets share of pool)       │
│  If you win: $99.00 (your share of $148.50 pool)           │
│                                                             │
│  [DECLINE]                              [JOIN GROUP]       │
└─────────────────────────────────────────────────────────────┘
```

### 6.8 Group history page

```
┌─────────────────────────────────────────────────────────────┐
│  My Group History                                            │
├─────────────────────────────────────────────────────────────┤
│  Filter: [All] [Win] [Loss] [Active] [Finished]             │
│                                                             │
│  #X7K9P2M4  ·  CoinFlip  ·  3 members  ·  $50 each          │
│  Result: WIN  ·  Payout: $148.50 ($49.50 each)              │
│  2 hours ago  ·  [view] [share]                              │
│                                                             │
│  #9P2M4K7  ·  Dice  ·  4 members  ·  $100 each              │
│  Result: LOSS  ·  Pool: $400                                 │
│  1 day ago  ·  [view] [share]                                │
│                                                             │
│  #K3LR8X1  ·  Crash  ·  2 members  ·  $25 each              │
│  Result: WIN  ·  Payout: $49.50                              │
│  3 days ago  ·  [view] [share]                               │
│                                                             │
│  ── Pagination ──  [1] 2 3 ... 12                            │
└─────────────────────────────────────────────────────────────┘
```

### 6.9 Admin's `/admin/groups` (full view)

```
┌─────────────────────────────────────────────────────────────┐
│ Group Play — Admin                       [Logout] [User]     │
├─────────────────────────────────────────────────────────────┤
│ [Live] [History] [Config] [Fraud] [Leaderboard]             │
│                                                             │
│ Active groups (47)         Filter: [game ▼] [status ▼]      │
│                                                             │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ #X7K9P2M4  · CoinFlip · 3/5 · $150 pool · 2m ago     │   │
│ │ creator: alice (alice@x.com)                          │   │
│ │ members: alice (creator), bob, carol                 │   │
│ │ distribution: proportional  ·  turn: creator         │   │
│ │ ─────────────────────────────────────────────────    │   │
│ │ [view] [shadow] [force-cancel] [refund] [audit]      │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ #9P2M4K7  · Crash · 4/4 · $400 pool · 5m ago         │   │
│ │ creator: eve (eve@y.com)                              │   │
│ │ members: eve, frank, gina, hank                       │   │
│ │ ⚠️ fraud signal: 3/4 members share IP 203.0.113.42   │   │
│ │ ─────────────────────────────────────────────────    │   │
│ │ [view] [shadow] [force-cancel] [refund] [audit]      │   │
│ │ [kick member] [mark-fraud] [notify-alice]            │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                             │
│ House edge today: $234.50    Invites redeemed: 127          │
│ Avg group size: 3.4   Avg pool: $87.20   Win rate: 49.2%   │
└─────────────────────────────────────────────────────────────┘
```

### 6.10 Admin's `/admin/groups/config`

```
┌─────────────────────────────────────────────────────────────┐
│ Group Play Configuration                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ⚙️ Master toggle                                             │
│   ☑ Group Play Enabled         (kill switch for all groups)│
│                                                             │
│ 🌍 Geographic restrictions                                  │
│   Allowed countries: [🇧🇩 🇺🇸 🇬🇧 🇪🇺 ▼] (default: all)        │
│   Blocked countries:   [🇰🇵 🇮🇷 ▼] (regulatory)              │
│                                                             │
│ 👥 Group size defaults                                      │
│   Default min members:      [2]  (between 2-10)             │
│   Default max members:      [5]  (between 2-10)             │
│   ⚠️ Absolute max members:   [10] (hard cap — overrides)  │
│                                                             │
│ 💰 Stake constraints                                        │
│   Default min contribution:  [0.10] USD                    │
│   Default max contribution:  [10000] USD                   │
│   Absolute pool cap:         [50000] USD                   │
│   ⚠️ Minimum user balance:   [0.50] USD (must have)        │
│   ⚠️ Lifetime deposit gate:  [50] USD (must have deposited)│
│                                                             │
│ ⏰ Time constraints                                         │
│   Default expiry:            [30] minutes                  │
│   Auto-flip countdown:       [5] seconds                   │
│                                                             │
│ 🎯 Distribution defaults                                    │
│   Default payout:        [Proportional ▼]                 │
│   Default turn:          [Creator ▼]                       │
│   Default founder share: [10]% (only if founder_boost)    │
│                                                             │
│ 📊 House edge                                                │
│   Group house edge:       [1.0]% (lower than solo = promo)  │
│   Min spread vs solo:     [0.5]% (anti-arb)                │
│                                                             │
│ 🎁 Invite bonuses                                          │
│   Inviter bonus:          [0] coins (default off)          │
│   Invitee bonus:          [0] coins (default off)          │
│   Daily cap per user:     [50] coins                       │
│                                                             │
│ 🔍 Spectator mode                                          │
│   ☑ Public spectator mode (anyone can watch)              │
│                                                             │
│ 🚫 Anti-fraud                                               │
│   ☑ Private groups allowed                                 │
│   ☑ Block new accounts (no deposit) from joining groups    │
│   ☑ Require 2FA for groups > $1000                         │
│                                                             │
│                                       [SAVE]                │
└─────────────────────────────────────────────────────────────┘
```

### 6.11 Admin's `/admin/groups/fraud`

```
┌─────────────────────────────────────────────────────────────┐
│ Group Play Fraud Signals                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 🔴 CRITICAL (3)                                              │
│ #9P2M4K7 — 3/4 members share IP 203.0.113.42                │
│   Action: [Investigate] [Mark resolved] [Force refund]       │
│                                                             │
│ 🟡 HIGH (12)                                                 │
│ #K3LR8X1 — 5 members from same fingerprint abc123            │
│   Action: [Investigate] [Mark resolved] [Force refund]       │
│                                                             │
│ 🟢 MEDIUM (47)                                              │
│ #M4NN2X9 — Invite token redeemed 11 times in 30 min          │
│   Action: [Investigate] [Freeze token] [Mark resolved]      │
│                                                             │
│ Total signals today: 62  |  False positives: 8              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 7 — Test Plan

### 7.1 Unit tests (5 files, ~110 assertions)

| File | Coverage |
|---|---|
| `group-bet-distribution.test.ts` | equal / proportional / founder_boost math (30 assertions) |
| `group-bet-flip.test.ts` | creator-flips / auto-flip / lottery (20 assertions) |
| `group-bet-invite.test.ts` | token gen + redemption + expiry (25 assertions) |
| `group-bet-rules.test.ts` | rate limits, validation, balance gates (20 assertions) |
| `group-bet-fraud.test.ts` | sybil detection, frozen groups, refund flow (15 assertions) |

### 7.2 Integration tests (12 scenarios)

| # | Scenario | Expected |
|---|---|---|
| 1 | E2E happy path | register → create group → invite → join → flip → all credited |
| 2 | Asymmetric stakes | A=$5, B=$10, C=$15 → proportional splits 17%/33%/50% |
| 3 | Founder boost | 3 members, creator 10% boost → creator gets 10% + own share |
| 4 | Auto-flip full | 3 members join → 5s countdown → flip happens automatically |
| 5 | Lottery flip | 3 members weighted → server picks one → that user sees "You!" |
| 6 | Loss path | All members debited, no credit |
| 7 | Invite expiry | 7-day-old invite → redemption fails |
| 8 | Max redemptions | 1-use token → 2nd user gets 401 |
| 9 | Deep-link pre-login | `/game?group=TOKEN` → `/login` → `/game?group=TOKEN` → auto-join |
| 10 | Race | 5 users join simultaneously → only first 5 succeed |
| 11 | Force-refund | Admin triggers → all members refunded |
| 12 | Per-user deposit gate | New user with $0 lifetime deposit → can't join group |

### 7.3 Live smoke tests (post-deploy)

- ✅ Created group → invite link works (3 different devices)
- ✅ Asymmetric distribution math matches expected
- ✅ Provably-fair seed hash shown before flip, revealed after
- ✅ House edge matches `groupHouseEdgePercent` config
- ✅ Group chat messages persist (Phase 2)
- ✅ Admin force-refund reverses all balances
- ✅ Fraud signal fires on 3+ members same IP
- ✅ Invite bonus cap is enforced per user

### 7.4 Fraud detection tests (specific)

| Test | Expected |
|---|---|
| 3 accounts same IP join same group | All credited but `fraud_signals` row at `severity='high'` |
| 3 accounts same IP finish group with $10k win | All credited, but 24h withdraw hold placed |
| Admin reviews the signal | Sees "3 linked, $10k pool, severe" widget |
| Admin clicks "Force refund" | All 3 balances reversed, group `cancelled` |
| `house_ledger` row | `gross=10k, payout=0, house_edge=10k` (recovered) |
| Repeat offender (5+ groups) | Account banned via P3-7 exclusion |

---

## Phase 8 — Migration Path & Rollout

### 8.1 Phasing (14 days, sequential)

| Phase | Description | Days | Risk |
|---|---|---|---|
| **Phase 0** | Migration 051 (new schema) + migration 052 (archive old squads) + migration 053 (insert 24 admin_settings rows) | 1 | Low (additive) |
| **Phase 1** | Backend services: `group-bet.service.ts` + REST endpoints (basic CRUD) + Zod validators | 2 | Low |
| **Phase 2** | Backend service: `group-bet-flip.service.ts` + socket events + CoinFlip support + 3 distribution modes + 3 turn modes | 2 | Medium |
| **Phase 3** | Frontend: `GroupCard` + `GroupCreateForm` + `GroupLobby` + deep-link handler + basic share modal | 2 | Low |
| **Phase 4** | Frontend: lobby page + history page + admin dashboard | 1 | Low |
| **Phase 5** | Backend: `group-bet-invite.service.ts` + Deep-link flow + invite-bonus logic | 1 | Medium |
| **Phase 6** | Anti-fraud: `group-bet-fraud.service.ts` + 8 fraud signals + admin force-refund | 1.5 | Medium |
| **Phase 7** | Multi-game: Dice + Crash (Phase 5 of previous plan) | 2 | Medium |
| **Phase 8** | In-group chat (Phase 2 of previous plan) + leaderboard + groups XP | 1 | Low |
| **Phase 9** | Bug fixes + observability + performance tuning | 0.5 | Low |
| **Total** | | **14 days** | |

### 8.2 Backward compatibility

- **Old `squads`/`squad_members` tables** stay read-only for 60 days as audit history
- **Old `socket-squad:*` events** deprecated; emit both `squad:*` and `group:*` for 30 days
- **Old `squadEnabled` admin setting** deprecated for 60 days (mapped to `groupPlayEnabled`)
- **Frontend `SquadFlip.tsx`** → renamed to `GroupLobby.tsx`, marked deprecated for 30 days, then removed

### 8.3 Feature flags

```ts
export const FEATURE_GROUP_PLAY_V2 = process.env.FEATURE_GROUP_PLAY_V2 !== 'false';
export const FEATURE_GROUP_DICE = process.env.FEATURE_GROUP_DICE === 'true';
export const FEATURE_GROUP_CRASH = process.env.FEATURE_GROUP_CRASH === 'true';
export const FEATURE_GROUP_PROPORTIONAL = process.env.FEATURE_GROUP_PROPORTIONAL !== 'false';
export const FEATURE_GROUP_FOUNDER_BOOST = process.env.FEATURE_GROUP_FOUNDER_BOOST === 'false';
export const FEATURE_GROUP_LOTTERY = process.env.FEATURE_GROUP_LOTTERY === 'false';
export const FEATURE_GROUP_INVITE_BONUS = process.env.FEATURE_GROUP_INVITE_BONUS === 'false';
export const FEATURE_GROUP_SPECTATOR = process.env.FEATURE_GROUP_SPECTATOR !== 'false';
export const FEATURE_GROUP_PRIVATE = process.env.FEATURE_GROUP_PRIVATE !== 'false';
```

### 8.4 Rollout (3 stages)

| Stage | Duration | Audience | What they see |
|---|---|---|---|
| **Internal** | 3 days | operator + 5 admins | Full feature, force-refund available |
| **Beta** | 7 days | 50 users (manually invited) | Full feature, fraud signals visible |
| **10%** | 7 days | random 10% of users | Feature, no fraud force-refund yet |
| **100%** | full | everyone | Full launch |

After 100%, monitor:
- `group_bet_active` gauge (target 200-500 groups on cx23)
- `group_fraud_signals_total` (target < 1% of groups flagged)
- `group_bet_house_edge_earned_coins` (target = 1% of group play volume)
- User retention (D7) for group players vs solo (target: +20%)

### 8.5 Monitoring + alerts

| Metric | Threshold | Action |
|---|---|---|
| `group_bet_active > 1000` for 5 min | operator check | scale Redis, check DB |
| `group_fraud_signals_total {severity=high}` > 10/hr | operator alert | investigate cohort |
| `group_bet_house_edge_earned_coins` < 0.5% of pool | operator alert | check house edge config |
| `group_bet_invites_redeemed / issued < 0.3` for 1 day | marketing check | reach out to creators |

---

## Phase 9 — Open Questions for the Operator

1. **Multi-game support from day 1?** (recommend: day 1 = CoinFlip only; Dice + Crash in Phase 7)
2. **Founder boost default on?** (recommend: yes, 10% — Roobet pattern)
3. **Lottery turn default on?** (recommend: yes — engaging)
4. **Auto-flip 5s countdown?** (recommend: yes; configurable)
5. **Invite bonuses — what amount?** (recommend: 0 default; +5 coins for first-time-deposit only)
6. **Spectator mode on by default?** (recommend: yes)
7. **In-group chat on launch?** (recommend: Phase 8 — separate from core group play)
8. **Voice chat?** (recommend: NO — out of scope)
9. **Group leaderboard?** (recommend: Phase 8 — post-launch)
10. **NFT cosmetic avatars?** (recommend: NO — out of scope)
11. **Maximum group pool cap?** (recommend: $50,000, configurable)
12. **Per-user minimum deposit gate?** (recommend: $50 lifetime deposit)
13. **Withdraw hold for large group wins?** (recommend: 24h hold for $5k+ pools)
14. **Maximum members per group?** (recommend: 10 hard cap, 5 default)
15. **Should the user-facing feature be called "Group", "Squad", or "Party"?** (recommend: "Group Play" — clearest, no gaming connotation)

---

## Implementation order (when you say "go")

1. **Phase 0** — Migrations 051, 052, 053 (1 day)
2. **Phase 1** — Backend service core + REST (2 days)
3. **Phase 2** — Flip + socket + 3 distribution + 3 turn modes (2 days)
4. **Phase 3** — Frontend basic (2 days)
5. **Phase 4** — Frontend share + history + admin dashboard (1 day)
6. **Phase 5** — Invite + deep-link (1 day)
7. **Phase 6** — Anti-fraud + force-refund (1.5 days)
8. **Phase 7** — Multi-game (Dice + Crash) (2 days)
9. **Phase 8** — Chat + leaderboard + XP (1 day)
10. **Phase 9** — Bug fixes + monitoring (0.5 day)

**Total: 14 days full-time.**

After Phase 3 lands, the feature is **playable end-to-end** for the basic case. After Phase 6, it's **industry-standard and audit-ready**.

---

## File locations (proposed)

### Backend

```
backend/src/services/group-bet/
├── index.ts
├── group-bet.service.ts                  # ~250 lines
├── group-bet-invite.service.ts           # ~200 lines
├── group-bet-flip.service.ts             # ~400 lines (replaces socket-squad.ts)
├── group-bet-distribution.service.ts     # ~150 lines
├── group-bet-deposit.service.ts          # ~100 lines (Phase 3)
├── group-bet-withdraw.service.ts         # ~120 lines (Phase 3)
├── group-bet-lobby.service.ts            # ~200 lines
├── group-bet-audit.service.ts            # ~80 lines
├── group-bet-rules.ts                    # ~100 lines (24 rules + 5 fraud rules)
├── group-bet-fraud.service.ts            # ~250 lines (8 signal detectors)
└── group-bet.test.ts                     # tests

backend/src/routes/
├── group-bet.ts                          # HTTP endpoints
└── admin-groups.ts                       # admin endpoints

backend/src/socket/
└── group-bet.ts                          # socket handlers (extract from socket-squad.ts)

backend/src/middleware/
└── group-bet-validator.ts                # Zod schemas

backend/src/services/admin-game-config.ts (UPDATE)
└── add: 24 new config fields (Phase 2)

backend/migrations/
├── 051_group_play_v2.sql                 # new schema
├── 052_group_play_archive.sql            # move old squads data
└── 053_group_play_admin_settings.sql     # insert 24 admin_settings rows
```

### Frontend

```
frontend/app/game/
├── page.tsx                              # AUGMENT: handle ?group=TOKEN
├── group/
│   ├── [groupId]/
│   │   ├── page.tsx                      # lobby
│   │   └── result/page.tsx               # result screen
│   ├── create/page.tsx                   # create wizard
│   └── lobby/page.tsx                    # browse open groups
├── history/page.tsx                      # my group history

frontend/components/group/
├── GroupCard.tsx                         # summary card
├── GroupCreateForm.tsx                   # 4-step wizard
├── GroupLobby.tsx                        # replaces SquadFlip.tsx
├── GroupMemberList.tsx                   # avatars + contributions
├── GroupInviteModal.tsx                  # share + QR + social
├── GroupDeepLinkHandler.tsx              # ?group=TOKEN handler
├── GroupResultModal.tsx                  # result + payout breakdown
├── GroupHistory.tsx                      # user's past groups
├── GroupChat.tsx                         # Phase 8
├── GroupSettings.tsx                     # configure group

frontend/app/admin/groups/
├── page.tsx                              # admin live view
├── config/page.tsx                       # the 24 settings
├── fraud/page.tsx                        # fraud signals
├── leaderboard/page.tsx                  # top creators
└── [groupId]/page.tsx                    # group detail (admin view)

frontend/lib/
├── group-bet.ts                          # API client
└── group-bet-socket.ts                   # socket events

frontend/utils/
└── group-bet-translations.ts              # BN + EN
```

### Backlog

| Item | Effort |
|---|---|
| Migration 051 + 052 + 053 | 1 day |
| Backend services + REST + socket | 5 days |
| Multi-game (Dice, Crash) | 2 days |
| Frontend | 4 days |
| Anti-fraud + metrics + admin | 2 days |
| Testing | 1 day (overlaps) |
| Documentation | 0.5 day |
| **Total** | **14 days** |

---

## References

- **Stake.us shared bet:** https://stake.com/casino/group (Cloudflare-protected; pattern from public docs)
- **Rollbit party bet:** https://rollbit.com/party (blockchaincasino.io coverage)
- **Roobet group bets:** https://roobet.com/group (community archives, 2024-04)
- **BC.Game shared:** https://bc.game/discover/invite (public marketing)
- **Gamdom squad mode:** https://gamdom.com/squad (community coverage)
- **Industry patterns:** "Social Gambling UX" research papers 2023-2024, G2E Conference
- **Internal docs:** `BACKEND_PROD_READINESS.md`, `PRODUCTION_READINESS_AND_DEPOSIT_WITHDRAW_REDESIGN.md`, `roadmap-2026.md`

---

**End of plan.**
