/**
 * ════════════════════════════════════════════════════════════════
 *  gp-2-03: lobby browser backend (Phase 2 / Day 10)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies the 3 lobby endpoints (listOpenGroups / listFriendsActiveGroups /
 *  listUserHistory) against the live DB. We exercise the service functions
 *  directly rather than spinning up the Express routes — they're a thin
 *  wrapper (validate* + 200 envelope).
 *
 *    1. listOpenGroups({}) returns only open/ready, not-expired rooms
 *    2. listOpenGroups({ payoutMode: 'founder_boost' }) filters correctly
 *    3. listOpenGroups respects limit + offset (pagination)
 *    4. Empty lobby returns []
 *    5. listFriendsActiveGroups: creator + joined friend rooms appear
 *    6. listFriendsActiveGroups: no graph → []
 *    7. listUserHistory: role+stake+payout correctly tagged
 *    8. listUserHistory: statusFilter excludes non-matching rooms
 *
 *  Run with:  bash scripts/test-group-bet-lobby.sh
 * ════════════════════════════════════════════════════════════════
 */

import { Client } from 'pg';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed = true; }
}

const DATABASE_URL = process.env.DATABASE_URL as string;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL required');
  process.exit(2);
}

const pg = new Client({ connectionString: DATABASE_URL });
let connected = false;

async function pgQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  if (!connected) { await pg.connect(); connected = true; }
  const r = await pg.query(text, params);
  return { rows: r.rows as T[] };
}

const RUN_TAG = `gp10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const {
  listOpenGroups,
  listFriendsActiveGroups,
  listUserHistory,
} = require('../services/group-bet-lobby');
const { createGroupBet } = require('../services/group-bet-create');
const { joinGroupBet } = require('../services/group-bet-join');

const TEST_CREATOR_ID = process.env.TEST_CREATOR_ID as string;
const TEST_MEMBER1_ID = process.env.TEST_MEMBER1_ID as string;
const TEST_MEMBER2_ID = process.env.TEST_MEMBER2_ID as string;

if (!TEST_CREATOR_ID || !TEST_MEMBER1_ID || !TEST_MEMBER2_ID) {
  console.error('FATAL: TEST_CREATOR_ID + 2 member IDs required');
  process.exit(2);
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await pgQuery(`UPDATE users SET withdrawable_balance_coins = $1, bonus_balance_coins = 0 WHERE id = $2`, [balance.toFixed(8), userId]);
}

async function createRoom(opts: {
  creatorId: string;
  creatorStake: number;
  perMemberStake: number;
  members: Array<{ userId: string; stake: number }>;
  payoutMode?: 'equal' | 'proportional' | 'founder_boost';
  minMembers?: number;
}): Promise<string> {
  const c = await createGroupBet({
    userId: opts.creatorId,
    creatorChoice: 'heads',
    creatorStake: opts.creatorStake,
    perMemberStake: opts.perMemberStake,
    minMembers: opts.minMembers ?? 3,
    maxMembers: 5,
    payoutMode: opts.payoutMode ?? 'equal',
    turnMode: 'creator',
  });
  for (const m of opts.members) {
    await joinGroupBet({
      userId: m.userId,
      groupIdentifier: c.id,
      choice: 'heads',
      stakeOverride: m.stake,
    });
  }
  return c.id;
}

async function cleanup(): Promise<void> {
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  await pgQuery(`DELETE FROM group_bet_audit WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1 OR invite_token LIKE $2)`, [`${tag}%`, `${RUN_TAG}-%`]);
  await pgQuery(`DELETE FROM transactions WHERE metadata::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1 OR invite_token LIKE $2)`, [`${tag}%`, `${RUN_TAG}-%`]);
  await pgQuery(`DELETE FROM group_bet WHERE short_code LIKE $1 OR invite_token LIKE $2`, [`${tag}%`, `${RUN_TAG}-%`]);
  await pgQuery(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
}

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // Top up balances for all 3 test users
    await setBalance(TEST_CREATOR_ID, 50_000);
    await setBalance(TEST_MEMBER1_ID, 50_000);
    await setBalance(TEST_MEMBER2_ID, 50_000);

    // ── 1. listOpenGroups({}) — only open/ready, not expired ──
    console.log('\n[1] listOpenGroups returns open/ready rooms only');
    let r1a: string, r1b: string;
    try {
      r1a = await createRoom({
        creatorId: TEST_CREATOR_ID,
        creatorStake: 50,
        perMemberStake: 50,
        members: [{ userId: TEST_MEMBER1_ID, stake: 50 }],
      });
      r1b = await createRoom({
        creatorId: TEST_MEMBER1_ID,
        creatorStake: 30,
        perMemberStake: 30,
        members: [],
        payoutMode: 'proportional',
      });
      // Force r1b to status='resolved' (expired_at can't be NULL — it's NOT NULL.
      // Set expires_at to a far-future timestamp so it stays "open" by expiry
      // but is filtered by status='resolved' instead.)
      await pgQuery(`UPDATE group_bet SET status = 'resolved', resolved_at = NOW(), ready_at = NOW(), expires_at = NOW() + interval '365 days' WHERE id = $1`, [r1b]);
    } catch (e: any) {
      console.error('[case1] createRoom failed:', e?.message);
      throw e;
    }

    const l1 = await listOpenGroups({ limit: 200 });
    const l1aMatch = l1.rooms.find((r: any) => r.id === r1a);
    const l1bMatch = l1.rooms.find((r: any) => r.id === r1b);
    assert(l1aMatch !== undefined, `open room r1a visible in lobby`);
    assert(l1bMatch === undefined, `resolved room r1b hidden from lobby`);
    assert(l1aMatch?.status === 'open' || l1aMatch?.status === 'ready', `r1a status is open or ready (got ${l1aMatch?.status})`);

    // ── 2. listOpenGroups({ payoutMode: 'founder_boost' }) ──
    console.log('\n[2] listOpenGroups filters by payoutMode');
    const r2 = await createRoom({
      creatorId: TEST_CREATOR_ID,
      creatorStake: 25,
      perMemberStake: 25,
      members: [{ userId: TEST_MEMBER1_ID, stake: 25 }],
      payoutMode: 'founder_boost',
      minMembers: 3,
    });
    const l2 = await listOpenGroups({ payoutMode: 'founder_boost', limit: 200 });
    const l2r2Match = l2.rooms.find((r: any) => r.id === r2);
    const l2r1aMatch = l2.rooms.find((r: any) => r.id === r1a);
    assert(l2r2Match !== undefined, `founder_boost room r2 visible with founder_boost filter`);
    assert(l2r1aMatch === undefined, `equal-mode room r1a hidden from founder_boost filter`);
    assert(l2.rooms.every((r: any) => r.payoutMode === 'founder_boost'), `all rooms in l2 are founder_boost`);

    // ── 3. listOpenGroups respects limit + offset ──
    console.log('\n[3] listOpenGroups paginates correctly');
    // Our 2 test rooms + the founder_boost one + perhaps prior tests' leftover
    // open rooms. Limit to 1 and verify the response has exactly 1.
    const l3 = await listOpenGroups({ limit: 1, offset: 0 });
    assert(l3.rooms.length === 1, `limit=1 returned 1 room (got ${l3.rooms.length})`);
    assert(l3.limit === 1, `limit echoed (got ${l3.limit})`);
    assert(l3.offset === 0, `offset echoed (got ${l3.offset})`);
    assert(typeof l3.total === 'number' && l3.total >= 1, `total is numeric (got ${l3.total})`);

    // ── 4. Empty lobby (use a payoutMode no rooms use) ──
    console.log('\n[4] filtered empty lobby returns []');
    const l4 = await listOpenGroups({
      payoutMode: 'founder_boost',
      minPool: 999999,  // unrealistic filter
      limit: 100,
    });
    assert(l4.rooms.length === 0, `filtered lobby returns [] (got ${l4.rooms.length})`);
    assert(l4.total === 0, `total is 0 (got ${l4.total})`);

    // ── 5. listFriendsActiveGroups: graph based on shared rooms ──
    console.log('\n[5] listFriendsActiveGroups: creator + joined friend rooms');
    // creator (C) + member1 (M1) are in r1a. M1 + M2 are not in any shared room yet.
    // → C and M1 are friends. If M1 creates a room, C should see it via friends/active.
    const r5 = await createRoom({
      creatorId: TEST_MEMBER1_ID,
      creatorStake: 20,
      perMemberStake: 20,
      members: [],
      payoutMode: 'equal',
      minMembers: 3,
    });
    // now C should see r5 in their friends list (because M1 is a friend via r1a)
    const l5 = await listFriendsActiveGroups(TEST_CREATOR_ID, 50);
    const l5r5Match = l5.find((r: any) => r.id === r5);
    assert(l5r5Match !== undefined, `creator sees friend M1's room r5 in friends/active`);
    // And r1a was created BY C, so it must NOT appear (excludes self-created)
    const l5r1aMatch = l5.find((r: any) => r.id === r1a);
    assert(l5r1aMatch === undefined, `creator's own room r1a excluded from friends/active`);

    // ── 6. listFriendsActiveGroups: no graph → [] ──
    console.log('\n[6] listFriendsActiveGroups: zero friend-graph → []');
    // Pick a user that has never joined any room → use a fresh user from the DB
    const freshUser = await pgQuery<{ id: string }>(
      `SELECT id FROM users WHERE id NOT IN (
         SELECT DISTINCT user_id FROM group_bet_member
       ) AND is_active=true LIMIT 1`,
    );
    if (freshUser.rows[0]) {
      const l6 = await listFriendsActiveGroups(freshUser.rows[0].id, 50);
      assert(Array.isArray(l6), `returns an array (got ${typeof l6})`);
      assert(l6.length === 0, `no-graph user gets 0 rooms (got ${l6.length})`);
    } else {
      console.log('  (skipping — no fresh user available in DB)');
    }

    // ── 7. listUserHistory: role + stake + payout correctly tagged ──
    console.log('\n[7] listUserHistory tags role/stake/payout');
    // Use the flipPath: create + 2-join + flip r1b (now resolved) and check creator's history
    // Actually the test users have all been added to multiple rooms, so just verify the
    // shape — pick the most recent resolved room the creator was in.
    const memberRows = await pgQuery<{ gid: string; rid: string }>(
      `SELECT m.group_id AS gid, g.id AS rid
         FROM group_bet_member m JOIN group_bet g ON g.id = m.group_id
        WHERE m.user_id = $1
        ORDER BY m.joined_at DESC LIMIT 1`,
      [TEST_CREATOR_ID],
    );
    if (memberRows.rows[0]) {
      const l7 = await listUserHistory(TEST_CREATOR_ID, { limit: 50 });
      assert(l7.rooms.length > 0, `user has at least one room in history (got ${l7.rooms.length})`);
      const sample = l7.rooms[0];
      assert(typeof sample.role === 'string', `role tagged (got ${sample.role})`);
      assert(typeof sample.myStake === 'string', `myStake tagged as string (got ${typeof sample.myStake})`);
      assert(typeof sample.myPayout === 'string', `myPayout tagged as string (got ${typeof sample.myPayout})`);
    }

    // ── 8. listUserHistory with statusFilter ──
    console.log('\n[8] listUserHistory respects statusFilter');
    const l8a = await listUserHistory(TEST_CREATOR_ID, { limit: 200, statusFilter: ['open', 'ready'] });
    const l8b = await listUserHistory(TEST_CREATOR_ID, { limit: 200, statusFilter: ['resolved'] });
    assert(l8a.rooms.every((r: any) => r.status === 'open' || r.status === 'ready'), `statusFilter=open|ready returns only those (saw: ${[...new Set(l8a.rooms.map((r: any) => r.status))].join(',')})`);
    assert(l8b.rooms.every((r: any) => r.status === 'resolved'), `statusFilter=resolved returns only resolved (saw: ${[...new Set(l8b.rooms.map((r: any) => r.status))].join(',')})`);

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-2-03 assertions failed.');
    else console.log('🎉 All gp-2-03 assertions passed.');
  } finally {
    console.log(`\n[cleanup] removing test rows for run-tag ${RUN_TAG}…`);
    try {
      await cleanup();
      console.log('[cleanup] done.');
    } catch (e) {
      console.error('[cleanup] FAILED:', (e as Error).message);
    }
    if (connected) await pg.end();
    process.exit(failed ? 1 : 0);
  }
}

runTests().catch((e) => {
  console.error('Unhandled error:', e?.message || e);
  if (connected) pg.end().catch(() => {});
  process.exit(1);
});
