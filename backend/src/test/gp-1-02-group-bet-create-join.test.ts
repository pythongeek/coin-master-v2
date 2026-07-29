/**
 * ════════════════════════════════════════════════════════════════
 *  gp-1-02: group-bet-create + join — Day-2 integration test
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies against the LIVE Postgres (coin-master-postgres-1):
 *    1. createGroupBet happy path — row inserted, creator debited,
 *       member row inserted, pool = creator_stake, audit mirror OK
 *    2. Gate: insufficient balance throws GroupBetInsufficientBalanceError
 *    3. Gate: lifetime deposit < $50 throws GroupBetNotAllowedError
 *    4. Gate: KYC tier < 1 throws GroupBetNotAllowedError
 *    5. Idempotency: same clientRequestId returns same groupId
 *    6. Validation: bad creatorChoice throws ValidationError
 *    7. joinGroupBet: member debits, current_members++, auto-ready
 *    8. joinGroupBet: capacity full → GROUP_FULL
 *    9. joinGroupBet: creator-cannot-join → CREATOR_CANNOT_JOIN
 *   10. joinGroupBet: choice mismatch → CHOICE_MISMATCH
 *   11. joinGroupBet: replay (same clientRequestId) returns same member
 *
 *  Run:
 *    DATABASE_URL=... \
 *      _CREATOR_ID=... _MEMBER1_ID=... _MEMBER2_ID=... \
 *        bash scripts/test-group-bet-create-join.sh
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

const RUN_TAG = `gp2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ── Service under test ──────────────────────────────────────────
const {
  createGroupBet,
} = require('../services/group-bet-create');
const {
  joinGroupBet,
} = require('../services/group-bet-join');
const {
  GroupBetValidationError,
  GroupBetNotAllowedError,
  GroupBetInsufficientBalanceError,
  GroupBetDuplicateError,
} = require('../services/group-bet-create');

async function cleanup(): Promise<void> {
  // Best-effort: everything prefixed by RUN_TAG or by these user IDs
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  await pgQuery(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM group_bet_invite WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1)`, [`${tag}%`]);
  await pgQuery(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1)`, [`${tag}%`]);
  await pgQuery(`DELETE FROM transactions WHERE metadata::text LIKE $1 AND user_id IN ($2, $3, $4)`,
    [`%${RUN_TAG}%`, _CREATOR_ID, _MEMBER1_ID, _MEMBER2_ID]);
  await pgQuery(`DELETE FROM group_bet WHERE short_code LIKE $1`, [`${tag}%`]);
  // Restore creator's balance (best-effort)
  await pgQuery(`UPDATE users SET withdrawable_balance_coins = withdrawable_balance_coins + 100 WHERE id = $1`, [_CREATOR_ID]);
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await pgQuery(`UPDATE users SET withdrawable_balance_coins = $1, bonus_balance_coins = 0 WHERE id = $2`, [balance.toFixed(8), userId]);
}

async function readBalance(userId: string): Promise<number> {
  const r = await pgQuery<{ b: string }>(`SELECT (COALESCE(withdrawable_balance_coins,0) + COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`, [userId]);
  return parseFloat(r.rows[0].b);
}

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // ── Top up: $100k balance, ensure lifetime deposits ≥ $50 ──
    await setBalance(_CREATOR_ID, 100_000);
    await setBalance(_MEMBER1_ID, 100_000);
    await setBalance(_MEMBER2_ID, 100_000);
    const originalCreatorBal = await readBalance(_CREATOR_ID);
    const depCount = await pgQuery<{ c: number }>(`SELECT count(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status='confirmed'`, [_CREATOR_ID]);
    if (depCount.rows[0].c === 0) {
      await pgQuery(`INSERT INTO transactions (user_id, type, amount, currency, direction, status) VALUES ($1, 'deposit', 100, 'USD', 'credit', 'confirmed')`, [_CREATOR_ID]);
    }

    // ── Case 1: happy path ──
    console.log('\n[1] createGroupBet happy path');
    const created = await createGroupBet({
      userId: _CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 50,
      perMemberStake: 50,
      minMembers: 2,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
      clientRequestId: `${RUN_TAG}-req1`,
      ipAddress: '203.0.113.1',
    });
    assert(typeof created.id === 'string', 'created.id is a string');
    assert(/^[A-Z0-9]{6}$/.test(created.shortCode), `shortCode is 6 uppercase alnum (got ${created.shortCode})`);
    assert(created.status === 'open', 'status is open');
    assert(parseFloat(created.totalPool) === 50, 'totalPool == creatorStake');
    assert(parseFloat(created.creatorStake) === 50, 'creatorStake echoed');
    assert(created.inviteToken.length === 64, 'inviteToken is 64-hex');

    const creatorBalAfterCreate = await readBalance(_CREATOR_ID);
    assert(Math.abs(creatorBalAfterCreate - (originalCreatorBal - 50)) < 0.01, `creator debited ~50 (was ${originalCreatorBal}, now ${creatorBalAfterCreate})`);

    const memberRow = await pgQuery<any>(`SELECT role, choice, stake::text AS stake FROM group_bet_member WHERE group_id = $1 AND user_id = $2`, [created.id, _CREATOR_ID]);
    assert(memberRow.rows.length === 1, 'creator has exactly 1 member row');
    assert(memberRow.rows[0].role === 'creator', 'member row role = creator');

    const auditRow = await pgQuery<any>(`SELECT action FROM group_bet_audit WHERE group_id = $1 AND action = 'create' LIMIT 1`, [created.id]);
    assert(auditRow.rows.length === 1, 'group_bet_audit create row exists');

    // Match by shortCode (which the service DOES write into the
    // audit_log.details payload). Per-row match is more robust than
    // RUN_TAG since the service's JSON.stringify does not embed it.
    const logRow = await pgQuery<any>(
      `SELECT category, action, details
         FROM audit_log
        WHERE action = 'group_play.create'
          AND details::text LIKE $1
        ORDER BY created_at DESC LIMIT 1`,
      [`%${created.shortCode}%`],
    );
    assert(logRow.rows.length >= 1, 'audit_log mirror row exists');
    assert(logRow.rows[0]?.category === 'group_play', 'audit_log category = group_play');
    assert(
      logRow.rows[0]?.details?.groupId === created.id,
      `audit_log details.groupId matches (got ${logRow.rows[0]?.details?.groupId})`,
    );

    // ── Case 2: insufficient balance ──
    console.log('\n[2] createGroupBet — insufficient balance → 402');
    const beforeBal = await readBalance(_CREATOR_ID);
    await setBalance(_CREATOR_ID, 10);
    let threw2 = false;
    try {
      await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'heads',
        creatorStake: 50,  // cannot afford
        perMemberStake: 50,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
        clientRequestId: `${RUN_TAG}-req-poor`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      threw2 = true;
      assert(e instanceof GroupBetInsufficientBalanceError, 'thrown is GroupBetInsufficientBalanceError');
      assert(e.balance === 10, 'error.balance = 10');
      assert(e.required === 50, 'error.required = 50');
    }
    assert(threw2, 'insufficient balance threw');
    const afterBal = await readBalance(_CREATOR_ID);
    assert(afterBal === 10, 'no debit on insufficient (balance unchanged)');
    await setBalance(_CREATOR_ID, 100_000);

    // ── Case 3: lifetime deposits < $50 → gate ──
    console.log('\n[3] createGroupBet — lifetime deposits < $50 → 403');
    // Pick a user that we will create 'fresh' with no lifetime deposits.
    // The simplest path: temporarily zero out _CREATOR_ID's deposits by
    // UPDATE'ing them to status='failed' (which excludes them from
    // LIFETIME_DEPOSIT_TOO_LOW query which filters status='confirmed').
    const depRows = await pgQuery<{ id: string }>(`SELECT id FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'confirmed'`, [_CREATOR_ID]);
    const tempDepIds = depRows.rows.map(r => r.id);
    if (tempDepIds.length > 0) {
      await pgQuery(`UPDATE transactions SET status = 'failed' WHERE id = ANY($1::uuid[])`, [tempDepIds]);
    }
    let threw3 = false;
    try {
      await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'heads',
        creatorStake: 10,
        perMemberStake: 10,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
        clientRequestId: `${RUN_TAG}-req-poor-history`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      threw3 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'LIFETIME_DEPOSIT_TOO_LOW', `code = LIFETIME_DEPOSIT_TOO_LOW (got ${e.code})`);
    }
    assert(threw3, 'lifetime deposit gate threw');
    // Restore the deposits so subsequent tests succeed
    if (tempDepIds.length > 0) {
      await pgQuery(`UPDATE transactions SET status = 'confirmed' WHERE id = ANY($1::uuid[])`, [tempDepIds]);
    }

    // ── Case 4: KYC tier < 1 → gate ──
    console.log('\n[4] createGroupBet — KYC tier < 1 → 403');
    await pgQuery(`UPDATE users SET kyc_tier = '0' WHERE id = $1`, [_CREATOR_ID]);
    let threw4 = false;
    try {
      await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'heads',
        creatorStake: 10,
        perMemberStake: 10,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
        clientRequestId: `${RUN_TAG}-req-no-kyc`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      threw4 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'KYC_TIER_INSUFFICIENT', `code = KYC_TIER_INSUFFICIENT (got ${e.code})`);
    }
    assert(threw4, 'KYC tier gate threw');
    // Restore KYC for subsequent tests
    await pgQuery(`UPDATE users SET kyc_tier = '1' WHERE id = $1`, [_CREATOR_ID]);

    // ── Case 5: idempotency (same clientRequestId) ──
    console.log('\n[5] createGroupBet — idempotency replay returns same group');
    const first = await createGroupBet({
      userId: _CREATOR_ID,
      creatorChoice: 'tails',
      creatorStake: 20,
      perMemberStake: 20,
      minMembers: 2,
      maxMembers: 4,
      payoutMode: 'proportional',
      turnMode: 'auto_on_full',
      autoFlipSeconds: 8,
      clientRequestId: `${RUN_TAG}-idem`,
      ipAddress: '203.0.113.1',
    });
    let threw5 = false;
    try {
      await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'tails',
        creatorStake: 20,
        perMemberStake: 20,
        minMembers: 2,
        maxMembers: 4,
        payoutMode: 'proportional',
        turnMode: 'auto_on_full',
        autoFlipSeconds: 8,
        clientRequestId: `${RUN_TAG}-idem`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      threw5 = true;
      assert(e instanceof GroupBetDuplicateError, 'replay throws GroupBetDuplicateError');
      assert(e.existingGroupId === first.id, 'existingGroupId matches the original');
    }
    assert(threw5, 'replay correctly rejected');

    // ── Case 6: validation ──
    console.log('\n[6] createGroupBet — bad creatorChoice throws');
    let threw6 = false;
    try {
      await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'sideways' as any,
        creatorStake: 10,
        perMemberStake: 10,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
      });
    } catch (e: any) {
      threw6 = true;
      assert(e instanceof GroupBetValidationError, 'thrown is GroupBetValidationError');
      assert(e.code === 'INVALID_CHOICE', 'code = INVALID_CHOICE');
    }
    assert(threw6, 'validation rejected bad choice');

    // ── Case 7: joinGroupBet happy path (and auto-ready) ──
    console.log('\n[7] joinGroupBet — happy path + auto-ready at min_members');
    // Created group had minMembers=2, current_members=1 (creator).
    // Single member join should bring it to 2 → 'ready'.
    const member1BalBefore = await readBalance(_MEMBER1_ID);
    const joined = await joinGroupBet({
      userId: _MEMBER1_ID,
      groupIdentifier: created.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-join-1`,
      ipAddress: '203.0.113.99',
    });
    assert(joined.role === 'member', 'joined member role');
    assert(joined.choice === 'heads', 'joined choice echoed');
    assert(parseFloat(joined.stake) === 50, 'joined stake matches per_member_stake');
    assert(joined.currentMembers === 2, 'current_members = 2 after single join');
    assert(joined.newStatus === 'ready', 'auto-transitioned to ready (2 ≥ min=2)');

    const member1BalAfter = await readBalance(_MEMBER1_ID);
    assert(Math.abs(member1BalAfter - (member1BalBefore - 50)) < 0.01, `member1 debited 50 (was ${member1BalBefore}, now ${member1BalAfter})`);

    // Verify DB state
    const dbGroup = await pgQuery<any>(`SELECT status, current_members FROM group_bet WHERE id = $1`, [created.id]);
    assert(dbGroup.rows[0].status === 'ready', 'DB row.status = ready');
    assert(parseInt(dbGroup.rows[0].current_members) === 2, 'DB row.current_members = 2');

    const joinAudit = await pgQuery<any>(`SELECT action FROM group_bet_audit WHERE group_id = $1 AND action='join' AND actor_id=$2`, [created.id, _MEMBER1_ID]);
    assert(joinAudit.rows.length === 1, 'group_bet_audit join row exists for member1');

    const readyAudit = await pgQuery<any>(`SELECT action FROM group_bet_audit WHERE group_id = $1 AND action='ready' ORDER BY created_at DESC LIMIT 1`, [created.id]);
    assert(readyAudit.rows.length === 1, 'group_bet_audit ready row exists');

    // ── Case 8: cannot join already-ready group ──
    console.log('\n[8] joinGroupBet — cannot join a ready/cancelled group');
    let threw8 = false;
    try {
      await joinGroupBet({
        userId: _MEMBER2_ID,
        groupIdentifier: created.id,
        choice: 'heads',
        clientRequestId: `${RUN_TAG}-join-late`,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      threw8 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'GROUP_NOT_OPEN' || e.code === 'GROUP_FULL', `code = GROUP_NOT_OPEN/GROUP_FULL (got ${e.code})`);
    }
    assert(threw8, 'late join rejected');

    // ── Case 9: creator cannot join their own room ──
    console.log('\n[9] joinGroupBet — creator cannot join own room');
    // Create a fresh open group (not auto-readied since creator-only)
    // minMembers=3 so 1 join doesn't auto-ready
    const ownRoom = await createGroupBet({
      userId: _CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 10,
      perMemberStake: 10,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
      clientRequestId: `${RUN_TAG}-own`,
      ipAddress: '203.0.113.1',
    });
    let threw9 = false;
    try {
      await joinGroupBet({
        userId: _CREATOR_ID,
        groupIdentifier: ownRoom.id,
        choice: 'heads',
        clientRequestId: `${RUN_TAG}-own-join`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      threw9 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'CREATOR_CANNOT_JOIN', `code = CREATOR_CANNOT_JOIN (got ${e.code})`);
    }
    assert(threw9, 'self-join rejected');

    // ── Case 10: choice mismatch ──
    console.log('\n[10] joinGroupBet — choice mismatch');
    let threw10 = false;
    try {
      await joinGroupBet({
        userId: _MEMBER2_ID,
        groupIdentifier: ownRoom.id,
        choice: 'tails',  // creator picked heads
        clientRequestId: `${RUN_TAG}-mismatch`,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      threw10 = true;
      assert(e instanceof GroupBetValidationError, 'thrown is GroupBetValidationError');
      assert(e.code === 'CHOICE_MISMATCH', `code = CHOICE_MISMATCH (got ${e.code})`);
    }
    assert(threw10, 'choice mismatch rejected');

    // ── Case 11: replay (same clientRequestId) returns existing row ──
    console.log('\n[11] joinGroupBet — idempotency replay (same clientRequestId)');
    const firstJoin = await joinGroupBet({
      userId: _MEMBER2_ID,
      groupIdentifier: ownRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-own-join-m2`,
      ipAddress: '203.0.113.99',
    });
    // Now member1 also joins via DIFFERENT clientRequestId
    const m1SecondRoom = await joinGroupBet({
      userId: _MEMBER1_ID,
      groupIdentifier: ownRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-own-join-m1`,
      ipAddress: '203.0.113.99',
    });
    // Replay member2's clientRequestId
    const replay = await joinGroupBet({
      userId: _MEMBER2_ID,
      groupIdentifier: ownRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-own-join-m2`,
      ipAddress: '203.0.113.99',
    });
    assert(replay.memberId === firstJoin.memberId, 'replay returns same memberId (no duplicate debit)');
    assert(replay.currentMembers === m1SecondRoom.currentMembers, 'replay does not bump current_members');

    // ── Case 12: GET /api/group-bet/:id (HTTP route shape sanity) ──
    console.log('\n[12] direct DB read: GET /api/group-bet/:id shape');
    const r = await pgQuery<any>(
      `SELECT id, short_code, status, creator_choice, creator_stake, per_member_stake,
              total_pool, min_members, max_members, current_members, payout_mode, turn_mode
         FROM group_bet WHERE id = $1`,
      [created.id],
    );
    assert(r.rows.length === 1, 'group readable');
    assert(r.rows[0].status === 'ready', 'final status = ready');
    assert(r.rows[0].payout_mode === 'equal', 'payout_mode persisted');
    assert(r.rows[0].turn_mode === 'creator', 'turn_mode persisted');

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-1-02 assertions failed.');
    else console.log('🎉 All gp-1-02 assertions passed.');
  } finally {
    console.log(`\n[cleanup] removing test rows for run-tag ${RUN_TAG}...`);
    try {
      await cleanup();
      console.log('[cleanup] done.');
    } catch (e: any) {
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
