# Group Play Rollout Tracker

**Status:** Phase A — Internal smoke only
**Last updated:** 2026-08-05
**Owner:** engineering on-call (Telegram @group-play-rollout)
**Live settings (from `admin_settings`):**

```
group_play_enabled            = false
group_play_allowed_countries  = *     (Phase A bypass — admin creates manually)
group_play_min_lifetime_deposit = 50  (used as the eligibility floor for all phases ≥ B)
```

> The rollout is a 4-phase ladder. **Do not skip phases.** Each phase
> must be promoted only after its **exit criteria** are met and the
> on-call has signed off in `#group-play-deploys`.

---

## Phase A — Internal smoke (current phase)

**Goal:** verify the entire group-bet stack end-to-end without exposing
it to real users. Only admins can create rooms.

**Configuration (DO NOT CHANGE without an audit):**

| Key | Value | Why |
|---|---|---|
| `group_play_enabled` | `false` | Master kill switch — non-admins cannot create/join/leave/flip |
| `group_play_allowed_countries` | `*` | Bypass for admin smoke; ignore for normal user-facing country check |
| `group_play_min_lifetime_deposit` | `50` | $50 floor, not yet enforced (we're not letting users in yet) |
| `group_bonus_wager_weight` | `50` | Group → bonus credit weight (50%) — testing in QA |
| `group_default_contribution_min` | `0.10` | Per-seat stake minimum (test-friendly) |
| `group_inviter_bonus_coins` | `0` | No refer-a-friend bonus while in smoke |
| `group_invitee_bonus_coins` | `0` | No first-redeem bonus while in smoke |
| `group_deep_link_first_deposit_bonus` | `5` | DEEP-LINK bonus, but inactive until Phase B (no user can use the link yet) |
| `group_leaderboard_enabled` | `true` | Internal leaderboard for QA sampling |

**Entry criteria:** N/A (this is the starting state)

**Exit criteria — ALL must be true:**

- [x] Migration 053 applied (Gap 11) — `spectator_count` column exists
- [x] Gap 1 (8 socket events) verified live
- [x] Gap 2 (`/api/group-bet/active`) verified live
- [x] Gap 3 (leaderboard) verified live
- [x] Gap 4 (bonus wagering) verified live
- [x] Gap 5 (deep-link first-deposit) verified live
- [x] Gap 6 (lifetime deposit gate) verified live
- [x] Gap 7 (9 Prometheus metrics) verified live
- [x] Gap 9 (house ledger) verified live
- [x] Gap 11 (spectator mode) verified live
- [x] Gap 15 (admin_actions audit) verified live
- [x] Sentry / error tracking enabled with `group_play` tag
- [x] 7-day soak window passed with **zero P0 incidents** in group-bet flow
- [x] Prometheus alerts wired: `group_bet_resolved_total` rate, `group_flip_duration_ms` p99, `group_fraud_signals_total` rate

**Kill switch:**

```sql
UPDATE admin_settings
   SET value = 'false',
       updated_at = NOW()
 WHERE key = 'group_play_enabled';
```

**Audit trail:** every group-room create/join/flip/leave writes to
`audit_log` with `category='group_play'`, plus `group_bet_audit` per
room. Admin actions (force-cancel, freeze, mark-fraud, refund, kick,
shadow) write to `admin_actions` (Gap 15) with `action_type='group_*'`.

---

## Phase B — Beta (50 admin-curated users, BD-only)

**Goal:** first real users, narrow geography, controlled user list.

**Configuration (apply in this order):**

1. Set country allowlist:

   ```sql
   UPDATE admin_settings SET value='BD', updated_at=NOW()
    WHERE key='group_play_allowed_countries';
   ```

2. Manually insert 50 hand-picked user IDs (Telegram handles the
   outreach). Stored in a new `group_play_beta_users` table — use the
   migration in `migrations/054_group_play_beta_users.sql` to create
   it.

3. Enable the master switch:

   ```sql
   UPDATE admin_settings SET value='true', updated_at=NOW()
    WHERE key='group_play_enabled';
   ```

4. Set the eligibility floor to a permissive $50 (already at this value).

5. Optional: enable refer-a-friend + first-deposit bonuses by setting
   `group_inviter_bonus_coins=2` and `group_invitee_bonus_coins=1`.

**Entry criteria:**

- [ ] Phase A exit criteria all check
- [ ] All 11 unit-test files for group-bet (`gp-1-*.test.ts` through
      `gp-3-*.test.ts`) pass in CI
- [ ] 50 beta-user invites drafted and sent
- [ ] Incident-response runbook reviewed

**Exit criteria — ALL must be true:**

- [ ] 7 days elapsed
- [ ] ≥ 30 of 50 beta users have created at least 1 group
- [ ] Zero fraud signals at `severity='critical'`
- [ ] `group_fraud_signals_total{severity="high"}` rate < 1/day
- [ ] `group_flip_duration_ms` p99 < 10s
- [ ] No P0 incident attributable to group-play
- [ ] Beta user NPS survey: ≥ 4/5 median

---

## Phase C — 10% (top depositors)

**Goal:** expand to ~10% of KYC-tier-1+ users, ranked by
`users.total_deposited_coins DESC`. Country allowlist = `*` (any).

**Configuration:**

1. Open up the country allowlist:

   ```sql
   UPDATE admin_settings SET value='*', updated_at=NOW()
    WHERE key='group_play_allowed_countries';
   ```

2. Bump the floor to discourage low-balance users from getting stuck:

   ```sql
   UPDATE admin_settings SET value='100', updated_at=NOW()
    WHERE key='group_play_min_lifetime_deposit';
   ```

3. Keep the master switch `true`.

4. The eligibility filter is **runtime-applied** in
   `group-bet-create.ts:runGates()`: `kyc_tier >= 1 AND lifetime_deposits >= 100`.
   We do NOT add a separate "top 10%" column — let the existing floor
   filter do its job. If cohort appears too narrow, the on-call can
   lower the floor back to 50.

**Entry criteria:**

- [ ] Phase B exit criteria all check
- [ ] SLO docs updated (`docs/SLO.md` or this doc's Phase C section)
- [ ] Customer-comms drafted (in-app banner: "Group play is now in
      10% rollout — thank you for being a top depositor")

**Exit criteria — ALL must be true:**

- [ ] 14 days elapsed
- [ ] `group_fraud_signals_total{severity="critical"}` rate = 0
- [ ] `group_flip_duration_ms` p99 < 8s
- [ ] ≥ 200 unique users have CREATED a group
- [ ] Total group volume > $50,000
- [ ] No P0 incident attributable to group-play

---

## Phase D — 100% (all KYC tier 1+)

**Goal:** enable group play for the entire eligible population.

**Configuration:**

1. Lower the floor (Phase C's $100 was the conservative choice for
   the early cohort):

   ```sql
   UPDATE admin_settings SET value='50', updated_at=NOW()
    WHERE key='group_play_min_lifetime_deposit';
   ```

2. Keep `group_play_enabled = true` and `group_play_allowed_countries = *`.

3. The `groupPlayEnabled` admin-config setting is now meaningful for
   `services/leaderboard.ts:getLeaderboard()` (Gap 3) and the UI's
   'Active groups' widget (Gap 2).

**Entry criteria:**

- [ ] Phase C exit criteria all check
- [ ] SLOs published
- [ ] Customer-comms scheduled (email + in-app banner)
- [ ] Marketing sign-off on launch

**Exit criteria:** N/A (this is GA — Phase D continues until a new
rollout supersedes it).

---

## Rollback procedure (applies to any phase)

If at any point a regression appears (P0 incident, fraud spike, etc.):

1. **Instant kill-switch** (5 minutes max impact):

   ```sql
   UPDATE admin_settings SET value='false', updated_at=NOW()
    WHERE key='group_play_enabled';
   ```

   This is the **only** change needed — all routes check this key
   inside the `runGates()` method and return `code: 'GROUP_PLAY_DISABLED'`.

2. **Granular rollback** (slower, for non-emergency fixes):

   | Knob | What it does | Use case |
   |---|---|---|
   | `group_play_enabled = false` | Full stop | P0 / fraud |
   | `group_play_allowed_countries = BD` (was `*`) | Re-narrow geography | Country-specific incident |
   | `group_play_min_lifetime_deposit = 100` (was `50`) | Tighten floor | Cheap-account abuse |
   | `group_bonus_wager_weight = 0` | Stop group-bet bonus credits | Bonus abuse |
   | `group_frozen=true` per room (via admin) | Single-room freeze | Specific room abuse |
   | `force-cancel` per room (via admin) | Refund and close | Specific room abuse |

3. **Verify the rollback** by polling `/metrics` for
   `group_bet_created_total` and `group_bet_resolved_total` — both
   should flatline at the rollback timestamp.

4. **Post-incident review** within 48 hours:
   - What setting failed? (fraud signal? perf? abuse?)
   - Could the next-phase criteria have caught it earlier?
   - Update the phase criteria in this doc if a new failure mode
     appeared.

---

## Audit trail

Every group-room action writes a row to one or more of:

| Table | When | Columns of interest |
|---|---|---|
| `audit_log` | every group op (create/join/flip/leave/cancel) | `category='group_play'`, `severity` |
| `group_bet_audit` | every room state transition | `action` ∈ {create, join, leave, ready, flip_start, flip_resolve, expire, cancel, force_cancel, freeze, mark_fraud, bonus_award, invite_share} |
| `admin_actions` | every admin op on a group (Gap 15) | `action_type` ∈ {group_force_cancel, group_freeze, group_unfreeze, group_mark_fraud, group_refund, group_kick, group_shadow} |
| `fraud_signals` | every fraud trigger | `signal_type` ∈ {group_sybil_suspected, group_invite_farm_suspected, group_founder_collusion, group_withdraw_hold, group_unusual_pattern, group_vpn_suspected, group_compromised_creator, group_admin_force} |
| `transactions` | every money-side event | `type='admin_adjustment'` + `metadata->>'reason'='group_*'` |
| `ledger_entries` | every house-side accounting triple (Gap 9) | `entry_type` ∈ {group_pool_received, group_pool_paid_out, group_house_take} |

Querying the unified timeline:

```sql
-- All group-related audit rows in the last 24h
SELECT created_at, 'audit_log' AS tbl, severity, action
  FROM audit_log
 WHERE category = 'group_play'
   AND created_at >= NOW() - INTERVAL '24 hours'
UNION ALL
SELECT created_at, 'group_bet_audit' AS tbl, NULL AS severity, action
  FROM group_bet_audit
 WHERE created_at >= NOW() - INTERVAL '24 hours'
UNION ALL
SELECT created_at, 'admin_actions' AS tbl, NULL AS severity, action_type AS action
  FROM admin_actions
 WHERE action_type LIKE 'group_%'
   AND created_at >= NOW() - INTERVAL '24 hours'
UNION ALL
SELECT created_at, 'fraud_signals' AS tbl, severity, signal_type AS action
  FROM fraud_signals
 WHERE signal_type LIKE 'group_%'
   AND detected_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

---

## Settings reference (all `admin_settings` rows that affect group play)

| Key | Default | Phase A | Phase B | Phase C | Phase D |
|---|---|---|---|---|---|
| `group_play_enabled` | `false` | `false` | `true` | `true` | `true` |
| `group_play_allowed_countries` | `*` | `*` | `BD` | `*` | `*` |
| `group_play_min_lifetime_deposit` | `50` | `50` | `50` | `100` | `50` |
| `group_bonus_wager_weight` | `50` | `50` | `50` | `50` | `50` |
| `group_default_contribution_min` | `0.10` | `0.10` | `0.10` | `0.10` | `0.10` |
| `group_inviter_bonus_coins` | `0` | `0` | `2` | `5` | `5` |
| `group_invitee_bonus_coins` | `0` | `0` | `1` | `3` | `3` |
| `group_inviter_bonus_cap_per_user_per_day` | `100` | `100` | `50` | `100` | `100` |
| `group_deep_link_first_deposit_bonus` | `5` | `5` | `5` | `5` | `5` |
| `group_leaderboard_enabled` | `true` | `true` | `true` | `true` | `true` |

All changes to the right of the divider (Phase B onwards) require an
on-call signoff in `#group-play-deploys` and a PR to
`backend/migrations/054_group_play_*.sql` with a `pgmigrations` row.

---

## References

- Feature spec: `docs/GROUP_PLAY_FEATURE_PLAN.md`
- Plan: `docs/P3-IMPLEMENTATION-PLAN.md`
- Decisions: `docs/P3-FINAL-DECISIONS.md`
- Production-readiness spec: `BACKEND_PROD_READINESS.md`
- Frontend: `frontend/lib/useGroupBetSocket.ts`, `useGroupStore.ts`
- Backend services: `backend/src/services/group-bet-*.ts`
- Admin routes: `backend/src/routes/admin-groups.ts`
- Live metrics: `http://localhost:4000/metrics` (IP allowlisted)
- Live leaderboard: `http://localhost:4000/api/admin/groups/leaderboard`
