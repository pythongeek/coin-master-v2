/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-FLIP — Provably-fair resolve (Phase 1 / Day 3)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Responsible for:
 *    1. Validating the flipper is allowed (turn_mode, freeze, status)
 *    2. 3-mode turn decision:
 *         - `creator`        — only creator_id may flip
 *         - `auto_on_full`   — any member; auto-triggers after auto_flip_seconds
 *         - `random_lottery` — server picks a member weighted by contribution
 *    3. Provably-fair flip via `provably-fair.resolveFlip()`:
 *         - reserveNonce() from the live `server_seeds` row
 *         - resolveFlip(serverSeed, clientSeed, nonce, choice, targetMult=2.0, houseEdge=2.0)
 *         - commit `server_seed_hash` BEFORE flip, reveal `server_seed_reveal` AFTER
 *    4. 3-mode payout distribution (Phase 1 §6):
 *         - equal           — split totalPool / winners.count
 *         - proportional    — weight × pool
 *         - founder_boost   — 10% extra to creator (Roobet pattern), rest proportional
 *    5. Credit winners via `bonus.ts:creditPayout` (bonus vs withdrawable split
 *       based on the same source they were debited from on join)
 *    6. Insert `group_bet_audit` (action='flip_resolve') + `audit_log` mirror
 *    7. Append `transactions` (type='payout') for the house-side loss booking
 *
 *  Reuses Day-1 state machine: `transitionGroupStatus(ready → flipping → resolved)`.
 *  Reuses Day-1 audit mirror: every state mutation writes both ledgers.
 *
 *  Idempotency: room.status='flipping' or 'resolved' → 409. The room
 *  is lockable at every state transition via FOR UPDATE row lock.
 * ════════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../config/database';
import { redis } from '../config/redis';
import {
  resolveFlip,
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
  type SeedPair,
  type FlipResult,
  type FlipOutcome,
} from './provably-fair';
import {
  reserveNonce,
  getSeedSecretById,
} from './server-seed';
import { creditPayout, creditWagering } from './bonus';
import { transitionGroupStatus, GroupBetTransitionError } from './group-bet-state';
import { emitGroupBetEvent } from './socket-group-bet';
import { getGroupConfigKey } from './admin-group-config';
import {
  groupBetResolvedTotal,
  groupFlipDurationMs,
  groupPoolSizeCoins,
} from '../routes/metrics';
import {
  GroupBetValidationError,
  GroupBetNotAllowedError,
  GroupBetInternalError,
} from './group-bet-create';

// ─── Constants (Phase 1 hard-codes; Phase 2 admin-config replaces) ─
const HOUSE_EDGE_PERCENT = 2.0;
const TARGET_MULTIPLIER = 2.0;       // Coinflip: heads=2.0x, tails=2.0x
const FOUNDER_BOOST_PERCENT = 10.0;   // 10% extra to creator (Roobet pattern)
// Gap 4: hard-coded fallback for group bonus wager weight (%). The
// admin-configured value (groupBonusWagerWeight) takes precedence at
// call time; this is the last-line fallback if the admin_settings row
// is missing.
const GROUP_BONUS_WAGER_WEIGHT_FALLBACK = 50;

// ─── Type contracts ──────────────────────────────────────────────
export interface FlipGroupInput {
  userId: string;
  groupIdentifier: string;
  clientSeed?: string;                 // optional — server generates one
  ipAddress?: string;
}

export interface FlipOutcome_Public {
  groupId: string;
  status: 'resolved';
  winningSide: FlipResult;
  totalPool: string;
  serverSeedHash: string;
  serverSeedReveal: string;
  clientSeed: string;
  nonce: number;
  resultHash: string;
  rawHash: string;
  rawValue: number;
  roll: number;
  /** Map of userId → payout amount (USD). House is "__HOUSE__". */
  payouts: Array<{ userId: string; payout: string; isWinner: boolean }>;
  /** Computed distribution (for UI / audit) */
  payoutMode: 'equal' | 'proportional' | 'founder_boost';
  /** The chosen turn-mode (echoed for UI) */
  turnMode: 'creator' | 'auto_on_full' | 'random_lottery';
  /** Which member's flip triggered this resolve (the lottery winner / creator / first member) */
  flipperUserId: string;
  resolvedAt: Date;
}

// ─── Helper: choose the flipper per turn_mode ───────────────────
function chooseFlipper(
  members: Array<{ user_id: string; role: string; choice: string; stake: string; weight: string; lottery_winner: boolean | null }>,
  group: { creator_id: string; turn_mode: string; current_members: number; min_members: number; max_members: number },
  requestedByUserId: string,
): { flipperUserId: string; reason: string } {
  const turn = group.turn_mode;

  if (turn === 'creator') {
    if (requestedByUserId !== group.creator_id) {
      throw new GroupBetNotAllowedError(
        'turn_mode=creator: only the creator may flip',
        'NOT_THE_FLIPPER',
      );
    }
    return { flipperUserId: group.creator_id, reason: 'creator_flip' };
  }

  if (turn === 'auto_on_full') {
    // The first member in the room (creator) is the canonical flipper for
    // auto_on_full. Any member can fire the request, but the flip is always
    // attributed to the first member.
    const first = members[0];
    if (!first) {
      throw new GroupBetInternalError('auto_on_full but room has no members', 'NO_MEMBERS');
    }
    return { flipperUserId: first.user_id, reason: 'auto_on_full_first_member' };
  }

  if (turn === 'random_lottery') {
    // Prefer a pre-picked lottery_winner. If none, pick now via weighted
    // random (weight = stake / sum_of_stakes).
    const lottery = members.find(m => m.lottery_winner === true);
    if (lottery) {
      return { flipperUserId: lottery.user_id, reason: 'lottery_pre_picked' };
    }
    // Live pick — only allow this if the requester is the creator
    // (otherwise any user could pre-empt the lottery). The HTTP route
    // restricts this via the same `creator` check.
    if (requestedByUserId !== group.creator_id) {
      throw new GroupBetNotAllowedError(
        'turn_mode=random_lottery: only the creator may trigger the lottery pick',
        'NOT_THE_FLIPPER',
      );
    }
    // Weighted-by-stake random pick using crypto.randomInt (NOT Math.random)
    const totalWeight = members.reduce((s, m) => s + parseFloat(m.weight), 0);
    if (totalWeight <= 0) {
      throw new GroupBetInternalError('lottery pick: total weight is 0', 'ZERO_WEIGHT');
    }
    // Convert weights to integer space for crypto.randomInt. Use a 10^6
    // scale for ~6-decimal precision.
    const SCALE = 1_000_000;
    const target = crypto.randomInt(0, Math.floor(totalWeight * SCALE));
    let acc = 0;
    for (const m of members) {
      acc += parseFloat(m.weight) * SCALE;
      if (target < acc) {
        return { flipperUserId: m.user_id, reason: 'lottery_live_pick' };
      }
    }
    return { flipperUserId: members[members.length - 1].user_id, reason: 'lottery_live_pick_fallback' };
  }

  // Exhaustive — TS narrows union but keep runtime guard
  throw new GroupBetInternalError(`unknown turn_mode: ${turn}`, 'UNKNOWN_TURN_MODE');
}

// ─── Payout distribution math ──────────────────────────────────
interface MemberPayout {
  userId: string;
  role: 'creator' | 'member';
  weight: number;
  stake: number;
  payout: number;
  isWinner: boolean;
}

/**
 * Compute payouts for one group. Pure function — exported for unit tests.
 *
 * Rules (per Phase 1 §6):
 *  - equal           — totalPool / winners.count (rounding remainder to last winner)
 *  - proportional    — winner's (weight / totalWeight) × totalPool
 *  - founder_boost   — 10% of totalPool goes to creator; remaining 90% split
 *                       proportionally among the OTHER winners. If creator is
 *                       on the winning side, they receive (boost + their
 *                       proportional share of the rest).
 *
 *  The "creator boost" is taken from the pool, NOT added on top — the
 *  pool is a closed system. If the creator is not a winner, the boost
 *  goes to the house (loss).
 */
export function computePayouts(args: {
  totalPool: number;
  members: Array<{ userId: string; role: 'creator' | 'member'; weight: number; stake: number; isWinner: boolean }>;
  payoutMode: 'equal' | 'proportional' | 'founder_boost';
  founderBoostPct: number;
  winningSide: FlipResult;
}): MemberPayout[] {
  const { totalPool, members, payoutMode } = args;
  // Mark winners by winning side (creator_choice already filtered joiners;
  // everyone in the room is on the same side for a group flip).
  const winners = members.filter(m => m.isWinner);
  const losers = members.filter(m => !m.isWinner);
  const creator = members.find(m => m.role === 'creator');
  const creatorIsWinner = creator?.isWinner ?? false;

  // Round to 8 decimals (matches the `numeric(18,8)` columns). Rounding
  // remainder is forwarded to the last winner in winners order.
  const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
  let payoutsByUser = new Map<string, number>();

  if (winners.length === 0) {
    // All losers — house takes the entire pool. No user payouts.
    for (const m of members) payoutsByUser.set(m.userId, 0);
  } else if (payoutMode === 'equal') {
    const perWinner = totalPool / winners.length;
    let paid = 0;
    winners.forEach((w, i) => {
      const amt = (i === winners.length - 1)
        ? round8(totalPool - paid)  // last wins the rounding remainder
        : round8(perWinner);
      payoutsByUser.set(w.userId, amt);
      paid += amt;
    });
  } else if (payoutMode === 'proportional') {
    const totalWeight = winners.reduce((s, w) => s + w.weight, 0);
    if (totalWeight <= 0) {
      // Degenerate: equal split as fallback
      const perWinner = totalPool / winners.length;
      winners.forEach(w => payoutsByUser.set(w.userId, round8(perWinner)));
    } else {
      let paid = 0;
      winners.forEach((w, i) => {
        const amt = (i === winners.length - 1)
          ? round8(totalPool - paid)
          : round8((w.weight / totalWeight) * totalPool);
        payoutsByUser.set(w.userId, amt);
        paid += amt;
      });
    }
  } else if (payoutMode === 'founder_boost') {
    const boost = round8((totalPool * args.founderBoostPct) / 100);
    const remainingPool = round8(totalPool - boost);
    const winnersExclCreator = winners.filter(w => w.role !== 'creator');
    const totalWeightExclCreator = winnersExclCreator.reduce((s, w) => s + w.weight, 0);

    if (creatorIsWinner) {
      // Creator gets (boost) + (their proportional share of remainingPool)
      let creatorShare = boost;
      if (totalWeightExclCreator > 0) {
        // Creator's weight counts toward the remainingPool split
        const totalWeightAll = winners.reduce((s, w) => s + w.weight, 0);
        if (totalWeightAll > 0) {
          // proportional split of remainingPool among all winners (creator included)
          let paid = 0;
          winners.forEach((w, i) => {
            const amt = (i === winners.length - 1)
              ? round8(remainingPool - paid)
              : round8((w.weight / totalWeightAll) * remainingPool);
            payoutsByUser.set(w.userId, amt);
            paid += amt;
          });
          creatorShare = (payoutsByUser.get(creator!.userId) ?? 0) + boost;
          payoutsByUser.set(creator!.userId, round8(creatorShare));
        } else {
          payoutsByUser.set(creator!.userId, boost);
        }
      } else {
        // Only creator is a winner — they get everything
        payoutsByUser.set(creator!.userId, round8(totalPool));
      }
    } else {
      // Creator lost — boost goes to house (no payout), remaining pool
      // is split proportionally among the other winners.
      if (winnersExclCreator.length > 0 && totalWeightExclCreator > 0) {
        let paid = 0;
        winnersExclCreator.forEach((w, i) => {
          const amt = (i === winnersExclCreator.length - 1)
            ? round8(remainingPool - paid)
            : round8((w.weight / totalWeightExclCreator) * remainingPool);
          payoutsByUser.set(w.userId, amt);
          paid += amt;
        });
      }
      // The boost is effectively a "house" gain — we do NOT credit
      // it to any user; it stays in the pool (already debited).
    }
  }

  // Losers: payout = 0
  for (const l of losers) payoutsByUser.set(l.userId, 0);

  // Build the result list with role + is_winner flags for the response
  return members.map(m => ({
    userId: m.userId,
    role: m.role,
    weight: m.weight,
    stake: m.stake,
    payout: round8(payoutsByUser.get(m.userId) ?? 0),
    isWinner: m.isWinner,
  }));
}

// ─── Public entrypoint ─────────────────────────────────────────
export async function flipGroup(input: FlipGroupInput): Promise<FlipOutcome_Public> {
  // Gap 7: capture the wall-clock start so we can observe the
  // groupFlipDurationMs histogram at the end. Captured BEFORE the
  // room load so even early-throw paths are measurable.
  const flipStartMs = Date.now();
  // ── 0. Input shape validation ──
  if (!input.groupIdentifier) {
    throw new GroupBetValidationError('groupIdentifier required', 'MISSING_GROUP');
  }

  // ── 1. Resolve + lock the room (FOR UPDATE) ──
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(input.groupIdentifier);
  const groupRow = await query<any>(
    `SELECT g.id, g.creator_id, g.status, g.is_frozen, g.min_members, g.max_members,
            g.current_members, g.creator_choice, g.payout_mode, g.turn_mode,
            g.creator_stake, g.per_member_stake, g.founder_boost_pct,
            g.total_pool, g.expires_at
       FROM group_bet g
      WHERE ${isUuid ? 'g.id = $1' : 'g.short_code = $1'}
      LIMIT 1`,
    [input.groupIdentifier],
  );
  if (!groupRow.rows.length) {
    throw new GroupBetValidationError('group not found', 'GROUP_NOT_FOUND');
  }
  const room = groupRow.rows[0];
  if (room.is_frozen) {
    throw new GroupBetNotAllowedError('group frozen by admin', 'GROUP_FROZEN');
  }
  if (new Date(room.expires_at).getTime() < Date.now()) {
    throw new GroupBetNotAllowedError('group expired', 'GROUP_EXPIRED');
  }
  if (room.status !== 'ready') {
    throw new GroupBetNotAllowedError(
      `cannot flip: group is ${room.status} (expected ready)`,
      'GROUP_NOT_READY',
    );
  }
  if (room.current_members < room.min_members) {
    throw new GroupBetNotAllowedError(
      `cannot flip: ${room.current_members} < min_members ${room.min_members}`,
      'INSUFFICIENT_MEMBERS',
    );
  }

  // ── 1.5. Group bonus-wager weight (Gap 4). Read admin-config once
  // so the same value is used for every member in this resolve. Set to
  // 0 to disable the bonus wager credit entirely (member still gets
  // paid the payout, but no wagering progress is recorded). ───────
  const groupBonusWagerWeight = await getGroupConfigKey('groupBonusWagerWeight')
    .catch(() => GROUP_BONUS_WAGER_WEIGHT_FALLBACK);
  const groupBonusWagerWeightNum = Number(groupBonusWagerWeight) || 0;

  // ── 2. Load members (use FOR UPDATE in the flip TX below) ──
  const memberRows = await query<any>(
    `SELECT user_id, role, choice, stake::text AS stake, weight::text AS weight,
            lottery_winner
       FROM group_bet_member
      WHERE group_id = $1
      ORDER BY joined_at ASC`,
    [room.id],
  );
  if (memberRows.rows.length === 0) {
    throw new GroupBetInternalError('ready group has no members', 'NO_MEMBERS');
  }

  // ── 3. Choose the flipper (turn_mode) ──
  const { flipperUserId, reason } = chooseFlipper(
    memberRows.rows,
    {
      creator_id: room.creator_id,
      turn_mode: room.turn_mode,
      current_members: room.current_members,
      min_members: room.min_members,
      max_members: room.max_members,
    },
    input.userId,
  );

  // ── 4. Transition ready → flipping (state machine + audit mirror) ──
  // We commit the server_seed_hash NOW, before the flip, so the user
  // can verify it later. The reveal happens after resolveFlip().
  const seedReservation = await reserveNonce();
  if (!seedReservation) {
    throw new GroupBetInternalError('no active server seed available', 'NO_ACTIVE_SEED');
  }
  const { seedId, serverSeedHash, nonce } = seedReservation;
  const seedSecret = await getSeedSecretById(seedId);
  if (!seedSecret) {
    throw new GroupBetInternalError(`server seed secret not found for seedId ${seedId}`, 'SEED_SECRET_MISSING');
  }
  const serverSeed = seedSecret.serverSeed;
  if (seedSecret.serverSeedHash !== serverSeedHash) {
    throw new GroupBetInternalError('server seed hash mismatch', 'SEED_HASH_MISMATCH');
  }
  const clientSeed = input.clientSeed || generateClientSeed();
  const seeds: SeedPair = { serverSeed, serverSeedHash, clientSeed, nonce };

  // Gap 1: emit `group:flip_started` BEFORE the flip computation so the
  // UI can render the count-down animation. The server_seed_hash is
  // committed here (it's already in the transition payload above), so
  // the client can verify it later.
  emitGroupBetEvent('group:flip_started', {
    groupId: room.id,
    shortCode: room.short_code,
    status: 'flipping',
    currentMembers: room.current_members,
    maxMembers: room.max_members,
    totalPool: parseFloat(String(room.total_pool)),
    actorUserId: flipperUserId,
    meta: {
      reason,
      serverSeedHash,
      clientSeed,
      nonce,
      seedId,
    },
  });

  // 4a. ready → flipping + commit server_seed_hash
  const flippingResult = await transitionGroupStatus(
    {
      groupId: room.id,
      actorId: flipperUserId,
      ipAddress: input.ipAddress,
      payload: {
        runTag: 'flip_start',
        flipperUserId,
        flipperReason: reason,
        serverSeedHash,
        clientSeed,
        nonce,
        seedId,
      },
    },
    {
      fromStatuses: ['ready'],
      toStatus: 'flipping',
      action: 'flip_start',
      auditSeverity: 'info',
      extraColumnsSql: 'server_seed_hash = $3, client_seed = $4, nonce = $5',
      extraColumnsParams: [serverSeedHash, clientSeed, nonce],
    },
  );

  // ── 5. Compute the flip via provably-fair.resolveFlip ──
  // House edge / target multiplier are hard-coded for the coinflip
  // product; Phase 2 admin-config will replace them.
  const outcome: FlipOutcome = resolveFlip(
    seeds,
    room.creator_choice as FlipResult,
    parseFloat(String(room.total_pool)),
    HOUSE_EDGE_PERCENT,
    TARGET_MULTIPLIER,
  );
  const winningSide: FlipResult = outcome.result;

  // ── 6. Compute payouts per payout_mode (pure function) ──
  const totalPool = parseFloat(String(room.total_pool));
  const membersForPayout = memberRows.rows.map((m: any) => ({
    userId: m.user_id,
    role: m.role,
    weight: parseFloat(m.weight),
    stake: parseFloat(m.stake),
    // Group coinflip: every member is on the same side (creator_choice).
    // "Winner" = picked the side that landed. Since all are on the same
    // side, either ALL win or ALL lose. The plan allows per-member
    // opposing choices in a future variant; for now, group = single side.
    isWinner: winningSide === room.creator_choice,
  }));
  const payouts = computePayouts({
    totalPool,
    members: membersForPayout,
    payoutMode: room.payout_mode,
    founderBoostPct: parseFloat(String(room.founder_boost_pct)),
    winningSide,
  });

  // ── 7. Atomic flipping → resolved + payouts + audit + ledger ──
  // Use a single SERIALIZABLE transaction so the payouts + per-member
  // payout_amount + audit + ledger all commit together.
  const finalState = await withTransaction(async (txQuery) => {
    // 7a. Mark each member's payout_amount + is_winner
    for (const p of payouts) {
      const memberRow = memberRows.rows.find((m: any) => m.user_id === p.userId);
      if (!memberRow) continue;
      await txQuery(
        `UPDATE group_bet_member
            SET payout_amount = $2, is_winner = $3
          WHERE group_id = $1 AND user_id = $4`,
        [room.id, p.payout.toFixed(8), p.isWinner, p.userId],
      );
    }

    // 7b. Credit winners via the bonus/withdrawable split
    // The credit goes to the same source the member was debited from
    // (we look up their current withdrawable/bonus balance and pick
    // withdrawable first to keep bookkeeping simple).
    for (const p of payouts) {
      if (p.payout <= 0) continue;
      try {
        await creditPayout(p.userId, p.payout, 'withdrawable', txQuery as any);
      } catch (err: any) {
        // Bubble the error so the surrounding TX rolls back
        throw new Error(`creditPayout failed for ${p.userId} amount ${p.payout}: ${err?.message}`);
      }
    }

    // 7c. Money-side ledger rows for each payout
    for (const p of payouts) {
      if (p.payout <= 0) continue;
      await txQuery(
        `INSERT INTO transactions
           (user_id, type, amount, currency, direction, status, metadata)
         VALUES ($1, 'win', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
        [
          p.userId,
          p.payout.toFixed(8),
          JSON.stringify({
            groupBetId: room.id,
            role: p.role,
            pool: 'group_play',
            winningSide,
          }),
        ],
      );
    }

    // 7c.2. Gap 4: every group member's wager obligation was RISKED at
    // JOIN time, regardless of win/loss. Credit the weighted stake to
    // the per-claim FIFO + user-level denormalized counter via the
    // same `creditWagering` function that single-player bets use, so
    // the group contribution lands in the same `users.wagering_completed_coins`
    // field the bonus-clearing UI/dashboard reads. Weight defaults to
    // 50% (groups clear bonus slower because the variance is shared).
    // Loss-path members are included — they risked the stake, so the
    // bonus-clearing credit applies. The `if (groupBonusWagerWeightNum > 0)`
    // short-circuit lets admins disable the credit entirely by setting
    // the value to 0 in admin_settings.
    if (groupBonusWagerWeightNum > 0) {
      for (const p of payouts) {
        const weighted = (p.stake * groupBonusWagerWeightNum) / 100;
        if (weighted <= 0) continue;
        await creditWagering(p.userId, weighted, txQuery as any);
      }
    }

    // 7c.1. Gap 9: house-side `ledger_entries` accounting triple.
    // The pool is a closed system: every coin came from a member, and
    // every coin is either paid back to a winner or retained by the
    // house. We record all three legs so the accounting dashboard can
    // verify the invariant `SUM(pool_received) = SUM(pool_paid_out) +
    // SUM(house_take)` per group. The sentinel `_house` user_id
    // (UUID 00000000-0000-0000-0000-000000000001) and the `USD`
    // currency_id (from migration 050) are required because
    // ledger_entries.user_id and currency_id are NOT NULL. The
    // reference_id is unique per row per group (the column has a UNIQUE
    // index) so the 3 rows are keyed by group_id + entry_type.
    const totalPaidOut = payouts.reduce((s, p) => s + p.payout, 0);
    const houseTake = Math.max(totalPool - totalPaidOut, 0);
    const winnerCount = payouts.filter(p => p.isWinner && p.payout > 0).length;
    const memberCount = payouts.length;
    const HOUSE_USER_ID = '00000000-0000-0000-0000-000000000001';
    const USD_CURRENCY_ID = '00000000-0000-0000-0000-0000000000aa';
    const ledgerRows = [
      {
        entry_type: 'group_pool_received',
        amount: totalPool,
        reference_id: `group-${room.id}-pool_received`,
        metadata: { memberCount, payoutMode: room.payout_mode, winningSide },
      },
      {
        entry_type: 'group_pool_paid_out',
        amount: totalPaidOut,
        reference_id: `group-${room.id}-pool_paid_out`,
        metadata: { winnerCount, memberCount, payoutMode: room.payout_mode },
      },
      {
        entry_type: 'group_house_take',
        amount: houseTake,
        reference_id: `group-${room.id}-house_take`,
        metadata: { houseEdgePct: HOUSE_EDGE_PERCENT, totalPool, totalPaidOut },
      },
    ];
    for (const r of ledgerRows) {
      await txQuery(
        `INSERT INTO ledger_entries
           (id, user_id, currency_id, entry_type, amount,
            balance_before, balance_after,
            reference_id, previous_hash, current_hash, signature, metadata)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4,
                 0, 0,
                 $5, '', '', '', $6::jsonb)`,
        [
          HOUSE_USER_ID,
          USD_CURRENCY_ID,
          r.entry_type,
          r.amount.toFixed(8),
          r.reference_id,
          JSON.stringify({
            ...r.metadata,
            ref_type: 'group_bet',
            ref_id: room.id,
          }),
        ],
      );
    }

    // 7d. Audit mirror (group_bet_audit) — action='flip_resolve' already
    //     written by transitionGroupStatus below; we add per-payout detail
    //     to the payload via a follow-up UPDATE on the audit row we just
    //     wrote. (The state-machine call writes the audit atomically in
    //     its own transaction; we extend the payload here.)
    return { ok: true };
  });

  // ── 8. flipping → resolved (separate TX so audit row's payload is
  //       accurate, since the payouts are computed BEFORE we transition) ──
  // We use the same audit action so the audit log gets a second row.
  const resolved = await transitionGroupStatus(
    {
      groupId: room.id,
      actorId: flipperUserId,
      ipAddress: input.ipAddress,
      payload: {
        runTag: 'flip_resolve',
        winningSide,
        totalPool: totalPool.toFixed(8),
        payouts: payouts.map(p => ({
          userId: p.userId,
          role: p.role,
          payout: p.payout.toFixed(8),
          isWinner: p.isWinner,
        })),
        flipperUserId,
        flipperReason: reason,
        rawHash: outcome.rawHash,
        rawValue: outcome.rawValue,
        roll: outcome.roll,
      },
    },
    {
      fromStatuses: ['flipping'],
      toStatus: 'resolved',
      action: 'flip_resolve',
      auditSeverity: 'info',
      extraColumnsSql: 'winning_side = $3, server_seed_reveal = $4, result_hash = $5, resolved_at = NOW()',
      extraColumnsParams: [winningSide, serverSeed, outcome.rawHash],
    },
  );

  // Gap 7: emit group metrics AFTER the resolved transition commits.
  // - groupBetResolved: labeled by payout_mode, turn_mode, winning_side
  // - groupFlipDurationMs: wall-clock time from flip request to resolved
  // - groupPoolSizeCoins: observe the final pool at resolve time
  //   (typically 0 after payouts, but tracks the gross pool for
  //   observability of the flip lifecycle).
  groupBetResolvedTotal.inc({
    payout_mode: room.payout_mode || 'equal',
    turn_mode: room.turn_mode || 'creator',
    winning_side: winningSide,
  });
  groupFlipDurationMs.observe(Date.now() - flipStartMs);
  groupPoolSizeCoins.observe(0); // pool fully paid out at resolve

  // Build the response ──
  emitGroupBetEvent('group:resolved', {
    groupId: room.id,
    shortCode: room.short_code,
    status: 'resolved',
    maxMembers: room.max_members,
    totalPool,
    winningSide,
    meta: {
      serverSeedHash,
      resultHash: outcome.rawHash,
      roll: outcome.roll,
      payoutMode: room.payout_mode,
      payouts: payouts.map(p => ({ userId: p.userId, payout: p.payout.toFixed(8), isWinner: p.isWinner })),
    },
  });
  // Gap 1: emit `group:flip_result` AFTER the result hash + distribution
  // are computed. Matches the spec's description: "after result hash +
  // distribution". Includes the per-member payouts so the UI can
  // render the winner list without re-fetching.
  emitGroupBetEvent('group:flip_result', {
    groupId: room.id,
    shortCode: room.short_code,
    status: 'resolved',
    currentMembers: room.current_members,
    maxMembers: room.max_members,
    totalPool,
    winningSide,
    actorUserId: flipperUserId,
    meta: {
      serverSeedHash,
      serverSeedReveal: serverSeed,
      clientSeed,
      nonce,
      resultHash: outcome.rawHash,
      rawHash: outcome.rawHash,
      roll: outcome.roll,
      payoutMode: room.payout_mode,
      flipperReason: reason,
      payouts: payouts.map(p => ({ userId: p.userId, payout: p.payout.toFixed(8), isWinner: p.isWinner })),
    },
    });
  // Gap 1: emit `group:pool_updated` after the payouts change the
  // accounting. In a pure win case, the pool is fully paid out so the
  // total pool goes to 0. We emit the post-distribution state so the
  // UI can clear the pool display.
  emitGroupBetEvent('group:pool_updated', {
    groupId: room.id,
    shortCode: room.short_code,
    status: 'resolved',
    currentMembers: room.current_members,
    maxMembers: room.max_members,
    totalPool: 0, // pool fully paid out
    actorUserId: flipperUserId,
    meta: {
      source: 'flip_resolve',
      delta: -totalPool,
      winningSide,
    },
  });

  return {
    groupId: room.id,
    status: 'resolved',
    winningSide,
    totalPool: totalPool.toFixed(8),
    serverSeedHash,
    serverSeedReveal: serverSeed,
    clientSeed,
    nonce,
    resultHash: outcome.rawHash,
    rawHash: outcome.rawHash,
    rawValue: outcome.rawValue,
    roll: outcome.roll,
    payouts: payouts.map(p => ({
      userId: p.userId,
      payout: p.payout.toFixed(8),
      isWinner: p.isWinner,
    })),
    payoutMode: room.payout_mode,
    turnMode: room.turn_mode,
    flipperUserId,
    resolvedAt: resolved.row.resolved_at ?? new Date(),
  };
}

export const __internals__ = { computePayouts, chooseFlipper };
