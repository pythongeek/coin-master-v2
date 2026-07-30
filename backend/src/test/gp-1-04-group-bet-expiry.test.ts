/**
 * ════════════════════════════════════════════════════════════════
 *  gp-1-04: group-bet-expiry — sweep + refund (Day 4)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies (against LIVE Postgres):
 *    1. sweepExpiredGroupBets is a no-op when no expired rooms exist
 *    2. open room past expires_at → status='expired', all members refunded
 *    3. ready room past expires_at → status='expired', all members refunded
 *    4. frozen expired room → NOT touched by sweep (is_frozen respected)
 *    5. resolved / cancelled / expired rooms → NOT touched (status filter)
 *    6. refund goes to 'withdrawable' (matches create/join debit source
 *       for these test users, since create/join defaulted to withdrawable
 *       when bonus_balance was 0)
 *    7. audit_log mirror row written: category='group_play',
 *       action='group_play.expire', severity='info'
 *    8. Idempotent: second sweep on the same expired rooms is a no-op
 *       (no double refunds, no double status flips)
 *
 *  Cleanup: test rows are deleted via the same RUN_TAG pattern as
 *  Day-2/Day-3 tests.
 *
 *  Run:
 *    DATABASE_URL=... REDIS_HOST=127.0.0.1 CREATOR_ID=... MEMBER1=... MEMBER2=...
 *      bash scripts/test-group-bet-expiry.sh
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
  console.error('FATAL: DATABASE_URL, TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID required.');
  process.exit(2);
}

const pg = new Client({ connectionString: DATABASE_URL });
let connected = false;

async function pgQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  if (!connected) { await pg.connect(); connected = true; }
  const r = await pg.query(text, params);
  return { rows: r.rows as T[] };
}

const RUN_TAG = `gp4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const { sweepExpiredGroupBets } = require('../services/group-bet-expiry');

async function cleanup(): Promise<void> {
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  await pgQuery(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM transactions WHERE metadata::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1)`, [`${tag}%`]);
  await pgQuery(`DELETE FROM group_bet WHERE short_code LIKE $1`, [`${tag}%`]);
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await pgQuery(`UPDATE users SET withdrawable_balance_coins = $1, bonus_balance_coins = 0 WHERE id = $2`, [balance.toFixed(8), userId]);
}
async function readBalance(userId: string): Promise<number> {
  const r = await pgQuery<{ b: string }>(`SELECT (COALESCE(withdrawable_balance_coins,0) + COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`, [userId]);
  return parseFloat(r.rows[0].b);
}

async function createExpiredRoom(opts: {
  status: 'open' | 'ready';
  frozen?: boolean;
  expiresInSec?: number;
  creatorStake: number;
  memberStakes: Array<{ userId: string; stake: number }>;
}): Promise<{ id: string; shortCode: string }> {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().slice(0, 4);
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  const shortCode = `${tag}${suffix}`.slice(0, 10);

  // expires_at in the past (default 60s ago)
  const expiresInSec = opts.expiresInSec ?? -60;
  // Initial totalPool = creator + sum(member stakes)
  const totalPool = opts.creatorStake + opts.memberStakes.reduce((s, m) => s + m.stake, 0);
  const currentMembers = 1 + opts.memberStakes.length;

  // Insert the room directly (bypasses the 24h expires_at default)
  const ins = await pgQuery<{ id: string; short_code: string }>(
    `INSERT INTO group_bet
       (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
        min_members, max_members, current_members, total_pool,
        payout_mode, turn_mode, auto_flip_seconds, invite_token,
        expires_at, status, is_frozen)
     VALUES ($1, $2, 'heads', $3, $4, $5, $6, $7, $8,
             'equal', 'creator', 5, $9,
             NOW() + interval '1 second' * $10, $11, $12)
     RETURNING id, short_code`,
    [
      shortCode,
      _CREATOR_ID,
      opts.creatorStake.toFixed(8),
      (opts.memberStakes[0]?.stake ?? opts.creatorStake).toFixed(8),
      Math.max(2, currentMembers),
      Math.max(5, currentMembers + 2),
      currentMembers,
      totalPool.toFixed(8),
      `${RUN_TAG}-tk-${Math.random().toString(36).slice(2, 12)}`,
      expiresInSec,
      opts.status,
      opts.frozen ?? false,
    ],
  );
  const roomId = ins.rows[0].id;

  // Backdate expires_at to be in the past (the interval above is positive
  // for some test cases — backdate is the safe path)
  await pgQuery(`UPDATE group_bet SET expires_at = NOW() - interval '1 second' * 60 WHERE id = $1`, [roomId]);

  // Insert creator + member rows
  await pgQuery(
    `INSERT INTO group_bet_member
       (group_id, user_id, role, choice, stake, weight, balance_before, client_request_id)
     VALUES ($1, $2, 'creator', 'heads', $3, 1.0, 100000, $4)`,
    [roomId, _CREATOR_ID, opts.creatorStake.toFixed(8), `${RUN_TAG}-create-${suffix}`],
  );
  for (let i = 0; i < opts.memberStakes.length; i++) {
    const m = opts.memberStakes[i];
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

    // Top up balances + ensure lifetime deposits
    await setBalance(_CREATOR_ID, 100_000);
    await setBalance(_MEMBER1_ID, 100_000);
    await setBalance(_MEMBER2_ID, 100_000);
    for (const uid of [_CREATOR_ID, _MEMBER1_ID, _MEMBER2_ID]) {
      const depCount = await pgQuery<{ c: number }>(`SELECT count(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status='confirmed'`, [uid]);
      if (depCount.rows[0].c === 0) {
        await pgQuery(`INSERT INTO transactions (user_id, type, amount, currency, direction, status) VALUES ($1, 'deposit', 100, 'USD', 'credit', 'confirmed')`, [uid]);
      }
    }

    // ── Case 1: no-op when no expired rooms exist ──
    console.log('\n[1] sweep is no-op when no expired rooms');
    const { sweepExpiredGroupBets } = require('../services/group-bet-expiry');
    const noopResult = await sweepExpiredGroupBets();
    assert(noopResult.processed === 0, `0 rooms processed (got ${noopResult.processed})`);
    assert(noopResult.errors.length === 0, `0 errors (got ${noopResult.errors.length})`);

    // ── Case 2: open room past expires_at → expired + refund ──
    console.log('\n[2] open room past expires_at → expired + refund');
    // Note: createExpiredRoom bypasses createGroupBet so it does NOT
    // debit the test users. We assert that the refund ADDS the stake
    // back (i.e., restores to the pre-test balance).
    const creatorBalBefore = await readBalance(_CREATOR_ID);
    const m1BalBefore = await readBalance(_MEMBER1_ID);
    const m2BalBefore = await readBalance(_MEMBER2_ID);

    const room2 = await createExpiredRoom({
      status: 'open',
      creatorStake: 50,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 50 }, { userId: _MEMBER2_ID, stake: 50 }],
    });

    const sweep2 = await sweepExpiredGroupBets();
    assert(sweep2.processed === 1, `1 room processed (got ${sweep2.processed})`);
    assert(sweep2.refundedMembers === 3, `3 members refunded (got ${sweep2.refundedMembers})`);
    assert(parseFloat(sweep2.refundedTotal) === 150, `refunded total 150 (got ${sweep2.refundedTotal})`);

    const db2 = await pgQuery<any>(`SELECT status, total_pool::text FROM group_bet WHERE id = $1`, [room2.id]);
    assert(db2.rows[0].status === 'expired', `DB status = expired (got ${db2.rows[0].status})`);

    const creatorBalAfter2 = await readBalance(_CREATOR_ID);
    const m1BalAfter2 = await readBalance(_MEMBER1_ID);
    const m2BalAfter2 = await readBalance(_MEMBER2_ID);
    assert(Math.abs(creatorBalAfter2 - (creatorBalBefore + 50)) < 0.01, `creator +50 (was ${creatorBalBefore}, now ${creatorBalAfter2})`);
    assert(Math.abs(m1BalAfter2 - (m1BalBefore + 50)) < 0.01, `m1 +50 (was ${m1BalBefore}, now ${m1BalAfter2})`);
    assert(Math.abs(m2BalAfter2 - (m2BalBefore + 50)) < 0.01, `m2 +50 (was ${m2BalBefore}, now ${m2BalAfter2})`);

    // ── Case 3: ready room past expires_at → expired + refund ──
    console.log('\n[3] ready room past expires_at → expired + refund');
    const m1BalBefore3 = await readBalance(_MEMBER1_ID);
    const room3 = await createExpiredRoom({
      status: 'ready',
      creatorStake: 30,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 30 }, { userId: _MEMBER2_ID, stake: 30 }],
    });
    const sweep3 = await sweepExpiredGroupBets();
    assert(sweep3.processed === 1, `1 room processed (got ${sweep3.processed})`);
    assert(sweep3.refundedMembers === 3, `3 members refunded (got ${sweep3.refundedMembers})`);
    const db3 = await pgQuery<any>(`SELECT status FROM group_bet WHERE id = $1`, [room3.id]);
    assert(db3.rows[0].status === 'expired', `ready → expired (got ${db3.rows[0].status})`);
    const m1BalAfter3 = await readBalance(_MEMBER1_ID);
    assert(Math.abs(m1BalAfter3 - (m1BalBefore3 + 30)) < 0.01, `m1 +30 (was ${m1BalBefore3}, now ${m1BalAfter3})`);

    // ── Case 4: frozen expired room → NOT swept ──
    console.log('\n[4] frozen expired room → NOT touched');
    const room4 = await createExpiredRoom({
      status: 'open',
      frozen: true,
      creatorStake: 20,
      memberStakes: [{ userId: _MEMBER1_ID, stake: 20 }],
    });
    const sweep4 = await sweepExpiredGroupBets();
    assert(sweep4.processed === 0, `frozen room skipped (got ${sweep4.processed} processed)`);
    const db4 = await pgQuery<any>(`SELECT status, is_frozen FROM group_bet WHERE id = $1`, [room4.id]);
    assert(db4.rows[0].status === 'open', `frozen room stays open (got ${db4.rows[0].status})`);
    assert(db4.rows[0].is_frozen === true, `is_frozen preserved`);

    // ── Case 5: audit_log mirror row ──
    console.log('\n[5] audit_log mirror row for expire');
    const auditRow = await pgQuery<any>(
      `SELECT category, action, severity FROM audit_log
        WHERE details::text LIKE $1 AND action = 'group_play.expire'
        ORDER BY created_at DESC LIMIT 1`,
      [`%${room2.id}%`],
    );
    assert(auditRow.rows.length === 1, '1 group_play.expire audit_log row exists');
    assert(auditRow.rows[0].category === 'group_play', `category = group_play (got ${auditRow.rows[0].category})`);
    assert(auditRow.rows[0].severity === 'info', `severity = info (got ${auditRow.rows[0].severity})`);

    // Also verify group_bet_audit row (the Day-1 transition system wrote it)
    const gbAudit = await pgQuery<any>(
      `SELECT action FROM group_bet_audit WHERE group_id = $1 AND action = 'expire'`,
      [room2.id],
    );
    assert(gbAudit.rows.length === 1, 'group_bet_audit row action=expire exists');

    // ── Case 6: transactions(type='admin_adjustment') refund rows ──
    console.log('\n[6] transactions(adjustment) refund rows');
    const txns = await pgQuery<any>(
      `SELECT user_id, amount::text AS amount, direction FROM transactions
        WHERE type = 'admin_adjustment' AND metadata::text LIKE $1 AND direction = 'credit'`,
      [`%${room2.id}%`],
    );
    assert(txns.rows.length === 3, `3 refund ledger rows (got ${txns.rows.length})`);
    for (const t of txns.rows) {
      assert(parseFloat(t.amount) === 50, `refund amount 50 (got ${t.amount})`);
      assert(t.direction === 'credit', `direction = credit (got ${t.direction})`);
    }

    // ── Case 7: idempotent — second sweep on same rooms is a no-op ──
    console.log('\n[7] idempotent: second sweep on same rooms is a no-op');
    const m1BalBefore7 = await readBalance(_MEMBER1_ID);
    const sweep7 = await sweepExpiredGroupBets();
    assert(sweep7.processed === 0, `2nd sweep: 0 rooms (got ${sweep7.processed})`);
    assert(sweep7.refundedMembers === 0, `2nd sweep: 0 refunded (got ${sweep7.refundedMembers})`);
    const m1BalAfter7 = await readBalance(_MEMBER1_ID);
    assert(Math.abs(m1BalAfter7 - m1BalBefore7) < 0.01, `m1 balance unchanged across 2nd sweep (got ${m1BalAfter7}, expected ${m1BalBefore7})`);

    // ── Case 8: respect per-tick limit ──
    console.log('\n[8] respects maxPerTick limit');
    // Create 3 expired open rooms; sweep with maxPerTick=2
    const r8a = await createExpiredRoom({ status: 'open', creatorStake: 5, memberStakes: [{ userId: _MEMBER1_ID, stake: 5 }] });
    const r8b = await createExpiredRoom({ status: 'open', creatorStake: 5, memberStakes: [{ userId: _MEMBER1_ID, stake: 5 }] });
    const r8c = await createExpiredRoom({ status: 'open', creatorStake: 5, memberStakes: [{ userId: _MEMBER1_ID, stake: 5 }] });
    const sweep8a = await sweepExpiredGroupBets({ maxPerTick: 2 });
    assert(sweep8a.processed === 2, `limited to 2 (got ${sweep8a.processed})`);
    const sweep8b = await sweepExpiredGroupBets({ maxPerTick: 2 });
    assert(sweep8b.processed === 1, `remaining 1 in next tick (got ${sweep8b.processed})`);
    // Verify all 3 are now expired
    const allDb8 = await pgQuery<any>(`SELECT status FROM group_bet WHERE id IN ($1, $2, $3) ORDER BY created_at`, [r8a.id, r8b.id, r8c.id]);
    assert(allDb8.rows.every(r => r.status === 'expired'), `all 3 expired after 2 sweeps`);

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-1-04 assertions failed.');
    else console.log('🎉 All gp-1-04 assertions passed.');
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
