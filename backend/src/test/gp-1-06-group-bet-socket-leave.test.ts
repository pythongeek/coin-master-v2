/**
 * ════════════════════════════════════════════════════════════════
 *  gp-1-06: group-bet-leave + socket emit (Day 6)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies (against LIVE Postgres):
 *    1. leaveGroupBet — member leaves an OPEN room, gets refunded
 *    2. leaveGroupBet — creator can leave their own room (refund + decrement)
 *    3. leaveGroupBet — refuses if status !== 'open' (409)
 *    4. leaveGroupBet — refuses if user isn't a member (403)
 *    5. cancelGroupBet — creator cancels OPEN room, refunds ALL members
 *    6. cancelGroupBet — creator cancels READY room, refunds ALL members
 *    7. cancelGroupBet — refuses if non-creator (403)
 *    8. cancelGroupBet — refuses if room is resolved/expired (409)
 *    9. emitGroupBetEvent — direct DB sanity check (verify hook fired)
 *   10. socket handlers — register without error (server-side guard)
 *
 *  Run with:
 *    DATABASE_URL=... REDIS_HOST=127.0.0.1 CREATOR_ID=... MEMBER1=... MEMBER2=...
 *      bash scripts/test-group-bet-socket-leave.sh
 * ════════════════════════════════════════════════════════════════
 */

import { Client } from 'pg';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('PASS:', msg); }
  else { console.error('FAIL:', msg); failed = true; }
}

const DATABASE_URL = process.env.DATABASE_URL as string;
const _CREATOR_ID = process.env.TEST_CREATOR_ID as string;
const _MEMBER1_ID = process.env.TEST_MEMBER1_ID as string;
const _MEMBER2_ID = process.env.TEST_MEMBER2_ID as string;

if (!DATABASE_URL || !_CREATOR_ID || !_MEMBER1_ID || !_MEMBER2_ID) {
  console.error('FATAL: DATABASE_URL + 3 user IDs required.');
  process.exit(2);
}

const pg = new Client({ connectionString: DATABASE_URL });
let connected = false;

async function pgQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  if (!connected) { await pg.connect(); connected = true; }
  const r = await pg.query(text, params);
  return { rows: r.rows as T[] };
}

const RUN_TAG = `gp6-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const {
  leaveGroupBet,
  cancelGroupBet,
  GroupBetLeaveError,
} = require('../services/group-bet-leave');
const {
  emitGroupBetEvent,
  setGroupBetIo,
  getGroupBetIo,
} = require('../services/socket-group-bet');
const { io: socketIo } = require('socket.io-client');

// ─── Fake SocketIOServer for emit capture ──────────────────────
interface CapturedEmit {
  event: string;
  room: string;
  payload: any;
}
const captured: CapturedEmit[] = [];

class FakeIO {
  to(room: string) {
    const self = this;
    return {
      emit(event: string, payload: any) {
        captured.push({ event, room, payload });
        return self;
      },
    };
  }
}

async function cleanup(): Promise<void> {
  await pgQuery(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1 OR payload::text LIKE $2`,
    [`%${RUN_TAG}%`, `%"runTag":"gp6-%`]);
  await pgQuery(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM transactions WHERE metadata::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1 OR invite_token LIKE $2)`,
    [`${RUN_TAG.toUpperCase().slice(0,8)}%`, `${RUN_TAG}-%`]);
  await pgQuery(`DELETE FROM group_bet WHERE short_code LIKE $1 OR invite_token LIKE $2`,
    [`${RUN_TAG.toUpperCase().slice(0,8)}%`, `${RUN_TAG}-%`]);
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await pgQuery(`UPDATE users SET withdrawable_balance_coins = $1, bonus_balance_coins = 0 WHERE id = $2`, [balance.toFixed(8), userId]);
}

async function readBalance(userId: string): Promise<number> {
  const r = await pgQuery<{ b: string }>(`SELECT (COALESCE(withdrawable_balance_coins,0) + COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`, [userId]);
  return parseFloat(r.rows[0]?.b ?? '0');
}

async function createRoom(opts: {
  status: string;
  creatorId: string;
  creatorStake: number;
  perMemberStake: number;
  memberStakes?: Array<{ userId: string; stake: number }>;
  payoutMode?: string;
}): Promise<{ id: string; shortCode: string }> {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().slice(0, 4);
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  const shortCode = `${tag}${suffix}`.slice(0, 10);
  const memberStakes = opts.memberStakes ?? [];
  const totalPool = opts.creatorStake + memberStakes.reduce((s, m) => s + m.stake, 0);
  const currentMembers = 1 + memberStakes.length;
  const ins = await pgQuery<{ id: string; short_code: string }>(
    `INSERT INTO group_bet
       (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
        min_members, max_members, current_members, total_pool,
        payout_mode, turn_mode, auto_flip_seconds, invite_token,
        expires_at, status)
     VALUES ($1, $2, 'heads', $3, $4, $5, $6, $7, $8,
             $9, 'creator', 5, $10, NOW() + interval '24 hours', $11)
     RETURNING id, short_code`,
    [
      shortCode,
      opts.creatorId,
      opts.creatorStake.toFixed(8),
      opts.perMemberStake.toFixed(8),
      Math.max(2, currentMembers),
      Math.max(5, currentMembers + 2),
      currentMembers,
      totalPool.toFixed(8),
      opts.payoutMode || 'equal',
      `${RUN_TAG}-tk-${suffix}`,
      opts.status,
    ],
  );
  const roomId = ins.rows[0].id;
  await pgQuery(
    `INSERT INTO group_bet_member
       (group_id, user_id, role, choice, stake, weight, balance_before, client_request_id)
     VALUES ($1, $2, 'creator', 'heads', $3, 1.0, 100000, $4)`,
    [roomId, opts.creatorId, opts.creatorStake.toFixed(8), `${RUN_TAG}-create-${suffix}`],
  );
  for (let i = 0; i < memberStakes.length; i++) {
    const m = memberStakes[i];
    await pgQuery(
      `INSERT INTO group_bet_member
         (group_id, user_id, role, choice, stake, weight, balance_before, client_request_id)
       VALUES ($1, $2, 'member', 'heads', $3, 1.0, 100000, $4)`,
      [roomId, m.userId, m.stake.toFixed(8), `${RUN_TAG}-m${i}-${suffix}`],
    );
  }
  return { id: roomId, shortCode };
}

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    await setBalance(_CREATOR_ID, 100_000);
    await setBalance(_MEMBER1_ID, 100_000);
    await setBalance(_MEMBER2_ID, 100_000);

    // ── Install fake io so we can capture emitted events ──
    const fakeIo = new FakeIO();
    setGroupBetIo(fakeIo);
    assert(!!getGroupBetIo(), 'fake io registered');

    // ── Case 1: member leaves an OPEN room, gets refunded ──
    console.log('\n[1] member leaves OPEN room → refund + decrement');
    captured.length = 0;
    const room1 = await createRoom({
      status: 'open',
      creatorId: _CREATOR_ID,
      creatorStake: 20,
      perMemberStake: 20,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 20 }, { userId: _MEMBER2_ID, stake: 20 }],
    });
    const m1Before = await readBalance(_MEMBER1_ID);
    const out = await leaveGroupBet(room1.id, _MEMBER1_ID, '203.0.113.1');
    assert(out.refundedAmount === 20, `refunded 20 USD (got ${out.refundedAmount})`);
    assert(out.remainingMembers === 2, `remaining members 2 (got ${out.remainingMembers})`);
    assert(out.status === 'open', 'status unchanged (still open)');
    const m1After = await readBalance(_MEMBER1_ID);
    // Note: createRoom() helper bypasses createGroupBet so it doesn't debit.
    // leaveGroupBet() does credit, so net effect is +20 USD.
    assert(Math.abs(m1After - (m1Before + 20)) < 0.01, `m1 balance +20 USD (helper bypasses debit; got ${m1Before}→${m1After})`);
    const memberCheck = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_member WHERE group_id = $1 AND user_id = $2`,
      [room1.id, _MEMBER1_ID],
    );
    assert(memberCheck.rows[0].c === 0, `m1 member row deleted`);
    const auditCheck = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_audit WHERE group_id = $1 AND action = 'leave'`,
      [room1.id],
    );
    assert(auditCheck.rows[0].c === 1, `leave audit row written (got ${auditCheck.rows[0].c})`);
    const emitCheck = captured.find(c => c.event === 'group:leave' && c.room === `group_${room1.id}`);
    assert(!!emitCheck, `group:leave socket event emitted (got ${captured.length} events captured)`);

    // ── Case 2: creator can leave their own OPEN room ──
    console.log('\n[2] creator leaves own OPEN room → refund + decrement');
    captured.length = 0;
    const room2 = await createRoom({
      status: 'open',
      creatorId: _CREATOR_ID,
      creatorStake: 30,
      perMemberStake: 30,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 30 }],
    });
    const out2 = await leaveGroupBet(room2.id, _CREATOR_ID, '203.0.113.2');
    assert(out2.refundedAmount === 30, `creator refunded 30 USD`);
    assert(out2.wasCreator === true, `wasCreator=true`);
    const memberCheck2 = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_member WHERE group_id = $1 AND role = 'creator'`,
      [room2.id],
    );
    assert(memberCheck2.rows[0].c === 0, `creator member row deleted`);

    // ── Case 3: leave refuses if status !== 'open' ──
    console.log('\n[3] leave refuses if status is ready/flipping');
    const room3 = await createRoom({
      status: 'ready',
      creatorId: _CREATOR_ID,
      creatorStake: 50,
      perMemberStake: 50,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 50 }, { userId: _MEMBER2_ID, stake: 50 }],
    });
    let caughtError: any = null;
    try {
      await leaveGroupBet(room3.id, _MEMBER1_ID);
    } catch (e: any) {
      caughtError = e;
    }
    assert(caughtError instanceof GroupBetLeaveError, `threw GroupBetLeaveError`);
    assert(caughtError?.code === 'ROOM_NOT_OPEN', `code = ROOM_NOT_OPEN (got ${caughtError?.code})`);

    // ── Case 4: leave refuses if user isn't a member ──
    console.log('\n[4] leave refuses if user is not a member');
    caughtError = null;
    try {
      await leaveGroupBet(room1.id, _MEMBER2_ID);  // room1 was created above
    } catch (e: any) {
      caughtError = e;
    }
    // Note: _MEMBER2_ID may still be a member of room1 from case 1.
    // Test uses a different non-member user if possible — _MEMBER2_ID is in room1, so use a fresh user.
    // Simpler: try a user that's definitely not in any test room.
    if (caughtError && caughtError.code === 'NOT_A_MEMBER') {
      assert(true, `NOT_A_MEMBER thrown for user not in room`);
    } else {
      // _MEMBER2 was in room1; try a totally fake user id
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      try {
        await leaveGroupBet(room1.id, fakeUuid);
      } catch (e: any) {
        caughtError = e;
      }
      assert(caughtError?.code === 'NOT_A_MEMBER', `NOT_A_MEMBER for fake uuid (got ${caughtError?.code})`);
    }

    // ── Case 5: cancelGroupBet — creator cancels OPEN room ──
    console.log('\n[5] creator cancels OPEN room → refund all members + flip to cancelled');
    captured.length = 0;
    const room5 = await createRoom({
      status: 'open',
      creatorId: _CREATOR_ID,
      creatorStake: 40,
      perMemberStake: 40,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 40 }, { userId: _MEMBER2_ID, stake: 40 }],
    });
    let out5: any;
    try {
      out5 = await cancelGroupBet(room5.id, _CREATOR_ID, 'creator changed mind', '203.0.113.5');
    } catch (e: any) {
      console.error('[case5] cancelGroupBet threw:', e?.message);
      throw e;
    }
    assert(out5.refundedMembers === 3, `refundedMembers = 3 (got ${out5.refundedMembers})`);
    assert(out5.refundedTotal === 120, `refundedTotal = 120 USD (got ${out5.refundedTotal})`);
    assert(out5.status === 'cancelled', `status = cancelled (got ${out5.status})`);
    const cancelAudit = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_audit WHERE group_id = $1 AND action = 'creator_cancel'`,
      [room5.id],
    );
    assert(cancelAudit.rows[0].c >= 1, `creator_cancel audit row written (got ${cancelAudit.rows[0].c})`);
    const txnCheck = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM transactions WHERE metadata::text LIKE $1 AND type = 'admin_adjustment' AND direction = 'credit'`,
      [`%${room5.id}%`],
    );
    assert(txnCheck.rows[0].c === 3, `3 admin_adjustment refund rows (got ${txnCheck.rows[0].c})`);
    const cancelEmit = captured.find(c => c.event === 'group:cancelled' && c.room === `group_${room5.id}`);
    assert(!!cancelEmit, `group:cancelled socket event emitted`);

    // ── Case 6: cancelGroupBet — creator cancels READY room ──
    console.log('\n[6] creator cancels READY room → refund all members + flip');
    captured.length = 0;
    const room6 = await createRoom({
      status: 'ready',
      creatorId: _CREATOR_ID,
      creatorStake: 25,
      perMemberStake: 25,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 25 }, { userId: _MEMBER2_ID, stake: 25 }],
    });
    const out6 = await cancelGroupBet(room6.id, _CREATOR_ID, 'ready but changed mind');
    assert(out6.refundedMembers === 3, `refunded 3 members from READY`);
    assert(out6.status === 'cancelled', `cancelled`);

    // ── Case 7: cancelGroupBet refuses if non-creator ──
    console.log('\n[7] cancel refuses if non-creator');
    const room7 = await createRoom({
      status: 'open',
      creatorId: _CREATOR_ID,
      creatorStake: 10,
      perMemberStake: 10,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 10 }],
    });
    caughtError = null;
    try {
      await cancelGroupBet(room7.id, _MEMBER1_ID, 'not my room');
    } catch (e: any) {
      caughtError = e;
    }
    assert(caughtError?.code === 'NOT_CREATOR', `NOT_CREATOR thrown (got ${caughtError?.code})`);

    // ── Case 8: cancel refuses if room is resolved/expired ──
    console.log('\n[8] cancel refuses if room is resolved/expired');
    const room8 = await createRoom({
      status: 'resolved',
      creatorId: _CREATOR_ID,
      creatorStake: 15,
      perMemberStake: 15,
      memberStakes: [],
    });
    caughtError = null;
    try {
      await cancelGroupBet(room8.id, _CREATOR_ID, 'too late');
    } catch (e: any) {
      caughtError = e;
    }
    assert(caughtError?.code === 'ALREADY_RESOLVED', `ALREADY_RESOLVED thrown (got ${caughtError?.code})`);

    // ── Case 9: emitGroupBetEvent — sanity check (already verified above) ──
    console.log('\n[9] emitGroupBetEvent — fires from domain services');
    captured.length = 0;
    emitGroupBetEvent('group:updated', { groupId: room1.id, status: 'open' });
    assert(captured.length === 1, `1 event captured after direct emit (got ${captured.length})`);
    assert(captured[0].event === 'group:updated', `event name correct`);
    assert(captured[0].payload.ts, `payload has ISO timestamp`);

    // ── Case 10: socket handlers can be imported without crashing ──
    console.log('\n[10] socket handlers module imports cleanly');
    try {
      const { registerGroupBetHandlers } = require('../services/socket-group-bet');
      assert(typeof registerGroupBetHandlers === 'function', `registerGroupBetHandlers is a function`);
    } catch (e: any) {
      assert(false, `module import failed: ${e?.message}`);
    }

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-1-06 assertions failed.');
    else console.log('🎉 All gp-1-06 assertions passed.');
  } finally {
    console.log(`\n[cleanup] removing test rows for run-tag ${RUN_TAG}...`);
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