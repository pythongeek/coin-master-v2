/**
 * ════════════════════════════════════════════════════════════════
 *  gp-2-04: invite-token redemption (Phase 2 / Day 11)
 *  ════════════════════════════════════════════════════════════════
 *
 *    1.  Token generation produces a 32-char lowercase base32 token
 *        + UNIQUE in DB
 *    2.  resolveInvite returns valid=true for an unexpired link
 *    3.  resolveInvite returns reason='EXPIRED' when expires_at < now
 *    4.  resolveInvite returns reason='EXHAUSTED' when
 *        redemption_count >= max_redemptions
 *    5.  redeemInvite with 1-redeem token → 2nd attempt throws
 *        INVITE_EXHAUSTED (HTTP 409 expected via InviteError.httpStatus)
 *    6.  redeemInvite with expired token throws INVITE_EXPIRED (HTTP 410)
 *    7.  redeemInvite (groupInviterBonusCoins > 0) credits BOTH inviter
 *        and invitee balances; persists 2 admin_adjustment credit rows
 *        with metadata.reason='group_invite_bonus'
 *    8.  groupInviterBonusCapPerUserPerDay enforces a cap: setting
 *        it to 5 and inviter already earned 4 today, then 1 more
 *        redemption → bonus is capped to 1 (not 5) → capped flag true
 *    9.  groupInviterBonusCoins=0 → no inviter/invitee credit rows
 *        written but the redeem_count still increments + invite row
 *        recorded (silent no-op bonus)
 *   10.  Audit row written with action='bonus_award' + sub-action
 *        'invite_redeemed' containing inviterId/inviteeId
 *
 *  Run with:  bash scripts/test-group-bet-invite.sh
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

const RUN_TAG = `gp11-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const {
  createInvite,
  resolveInvite,
  redeemInvite,
  InviteError,
} = require('../services/group-bet-invite');
const { updateGroupConfig, resetGroupConfig, getGroupConfig } = require('../services/admin-group-config');
const { createGroupBet } = require('../services/group-bet-create');

const TEST_CREATOR_ID = process.env.TEST_CREATOR_ID as string;
const TEST_MEMBER1_ID = process.env.TEST_MEMBER1_ID as string;
const TEST_MEMBER2_ID = process.env.TEST_MEMBER2_ID as string;

if (!TEST_CREATOR_ID || !TEST_MEMBER1_ID || !TEST_MEMBER2_ID) {
  console.error('FATAL: TEST_CREATOR_ID + 2 member IDs required');
  process.exit(2);
}

async function readBalance(userId: string): Promise<number> {
  const r = await pgQuery<{ b: string }>(
    `SELECT (COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`,
    [userId],
  );
  return parseFloat(r.rows[0]?.b ?? '0');
}

async function setBalance(userId: string, bonus: number): Promise<void> {
  await pgQuery(`UPDATE users SET bonus_balance_coins = $1, withdrawable_balance_coins = 50000 WHERE id = $2`, [bonus.toFixed(8), userId]);
}

async function cleanup(): Promise<void> {
  // Remove anything tagged with this run (each step is wrapped so a
  // missing column on one table doesn't break the others)
  const steps: Array<[string, string, any[]] | [string, string, any[]]> = [
    ['group_bet_audit', 'WHERE metadata::text LIKE $1', [`%${RUN_TAG}%`]],
    ['transactions',   'WHERE metadata::text LIKE $1 OR (metadata->>\'reason\' = \'group_invite_bonus\' AND user_id = ANY($2) AND created_at >= NOW() - interval \'1 hour\')', [`%${RUN_TAG}%`, [TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID]]],
    ['group_bet_invite', 'WHERE created_at > NOW() - interval \'1 hour\' AND invitee_user_id = ANY($1)', [[TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID]]],
    ['group_bet_invite_link', 'WHERE inviter_id = ANY($1) AND created_at > NOW() - interval \'1 hour\'', [[TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID]]],
    ['group_bet_member', 'WHERE group_id IN (SELECT id FROM group_bet WHERE invite_token LIKE $1)', [`${RUN_TAG}%`]],
    ['group_bet', 'WHERE invite_token LIKE $1', [`${RUN_TAG}%`]],
  ];
  for (const [tbl, where, params] of steps) {
    try {
      await pgQuery(`DELETE FROM ${tbl} ${where}`, params);
    } catch (e: any) {
      console.error(`[cleanup] ${tbl} FAILED: ${e?.message}`);
    }
  }
}

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // Ensure clean defaults + nuke any leftover bonus rows from prior runs
    try { await resetGroupConfig(); } catch {}
    await cleanup();
    // Make sure the creator starts at exactly 0 bonus today (no leak from prior runs)
    await pgQuery(
      `UPDATE transactions SET amount = 0 WHERE user_id = $1 AND type = 'admin_adjustment' AND metadata->>'reason' = 'group_invite_bonus' AND created_at >= date_trunc('day', NOW())`,
      [TEST_CREATOR_ID],
    );
    // Aggressive cleanup of all leftover bonus rows for the test users
    await pgQuery(
      `DELETE FROM transactions WHERE user_id = ANY($1) AND metadata->>'reason' = 'group_invite_bonus' AND created_at >= date_trunc('day', NOW())`,
      [[TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID]],
    );
    await pgQuery(
      `UPDATE users SET bonus_balance_coins = 0 WHERE id = ANY($1)`,
      [[TEST_CREATOR_ID, TEST_MEMBER1_ID, TEST_MEMBER2_ID]],
    );

    // Ensure clean defaults
    await resetGroupConfig();

    await setBalance(TEST_CREATOR_ID, 0);
    await setBalance(TEST_MEMBER1_ID, 0);
    await setBalance(TEST_MEMBER2_ID, 0);

    // ── 1. Token generation ──
    console.log('\n[1] createInvite returns 32-char lowercase token');
    // Need a room first (createInvite requires valid group)
    const roomFor1 = await createGroupBet({
      userId: TEST_CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 5,
      perMemberStake: 5,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
    });
    const inv1 = await createInvite({
      groupId: roomFor1.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: RUN_TAG,
    });
    assert(typeof inv1.token === 'string' && inv1.token.length === 32, `token length === 32 (got ${inv1.token.length})`);
    assert(/^[a-z0-9]+$/.test(inv1.token), `token is lowercase alphanumeric (matches ${/^[a-z0-9]+$/.test(inv1.token)})`);
    // Verify it's unique in the table
    const dupCheck = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_invite_link WHERE token = $1`,
      [inv1.token],
    );
    assert(dupCheck.rows[0].c === 1, `token is UNIQUE in DB (got ${dupCheck.rows[0].c} rows)`);
    assert(inv1.url === `/g/invite/${inv1.token}`, `url is /g/invite/{token}`);
    assert(inv1.campaign === RUN_TAG, `campaign round-tripped (got ${inv1.campaign})`);

    // ── 2. resolveInvite valid ──
    console.log('\n[2] resolveInvite returns valid=true for unexpired');
    const res2 = await resolveInvite(inv1.token);
    assert(res2.valid === true, `valid=true (got ${res2.valid})`);
    assert(res2.groupId === roomFor1.id, `groupId matches`);
    assert(res2.maxRedemptions === 1, `maxRedemptions=1 (got ${res2.maxRedemptions})`);
    assert(res2.redeemedCount === 0, `redeemedCount=0 initially (got ${res2.redeemedCount})`);

    // ── 3. resolveInvite expired ──
    console.log('\n[3] resolveInvite returns reason=EXPIRED for past expires_at');
    // Force expires_at into the past so we don't have to wait 7 days
    await pgQuery(`UPDATE group_bet_invite_link SET expires_at = NOW() - interval '1 second' WHERE token = $1`, [inv1.token]);
    const res3 = await resolveInvite(inv1.token);
    assert(res3.valid === false, `valid=false after expiry`);
    assert(res3.reason === 'EXPIRED', `reason=EXPIRED (got ${res3.reason})`);

    // Reset expiry so subsequent tests can reuse this token
    await pgQuery(`UPDATE group_bet_invite_link SET expires_at = NOW() + interval '7 days' WHERE token = $1`, [inv1.token]);

    // ── 4. resolveInvite exhausted ──
    console.log('\n[4] resolveInvite returns reason=EXHAUSTED when redemption_count >= max_redemptions');
    await pgQuery(`UPDATE group_bet_invite_link SET redemption_count = 1, redeemed_count = 1, max_redemptions = 1 WHERE token = $1`, [inv1.token]);
    const res4 = await resolveInvite(inv1.token);
    assert(res4.valid === false, `valid=false after exhausted`);
    assert(res4.reason === 'EXHAUSTED', `reason=EXHAUSTED (got ${res4.reason})`);

    // Reset for cases below
    await pgQuery(`UPDATE group_bet_invite_link SET redemption_count = 0, redeemed_count = 0 WHERE token = $1`, [inv1.token]);

    // ── 5. redeemInvite twice → 409 ──
    console.log('\n[5] redeemInvite single-use token — 2nd attempt throws INVITE_EXHAUSTED');
    await setBalance(TEST_CREATOR_ID, 0);
    await setBalance(TEST_MEMBER1_ID, 0);
    // First redeem should NOT throw because defaults bonus to 0 (no credits written)
    // (We'll do this with a fresh room + fresh invite so inv1 stays available)
    const roomFor5 = await createGroupBet({
      userId: TEST_CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 1,
      perMemberStake: 1,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
    });
    const inv5 = await createInvite({
      groupId: roomFor5.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: `${RUN_TAG}-5`,
    });
    const r5a = await redeemInvite({ token: inv5.token, inviteeUserId: TEST_MEMBER1_ID }).catch((e: any) => e);
    assert(r5a.token === inv5.token, `first redeem succeeded (got ${r5a?.token || r5a?.code})`);
    let r5b: any;
    try {
      r5b = await redeemInvite({ token: inv5.token, inviteeUserId: TEST_MEMBER2_ID });
    } catch (e: any) {
      r5b = e;
    }
    assert(r5b instanceof InviteError, `2nd redeem is an InviteError`);
    assert(r5b.code === 'INVITE_EXHAUSTED', `code is INVITE_EXHAUSTED (got ${r5b.code})`);
    assert(r5b.httpStatus === 409, `httpStatus is 409 (got ${r5b.httpStatus})`);

    // ── 6. redeemInvite expired → 410 ──
    console.log('\n[6] redeemInvite expired token → INVITE_EXPIRED (HTTP 410)');
    const inv6 = await createInvite({
      groupId: roomFor1.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: `${RUN_TAG}-6`,
    });
    await pgQuery(`UPDATE group_bet_invite_link SET expires_at = NOW() - interval '1 second' WHERE token = $1`, [inv6.token]);
    let r6: any;
    try {
      r6 = await redeemInvite({ token: inv6.token, inviteeUserId: TEST_MEMBER1_ID });
    } catch (e: any) {
      r6 = e;
    }
    assert(r6 instanceof InviteError, `expired redeem is an InviteError`);
    assert(r6.code === 'INVITE_EXPIRED', `code is INVITE_EXPIRED (got ${r6.code})`);
    assert(r6.httpStatus === 410, `httpStatus is 410 (got ${r6.httpStatus})`);

    // ── 7. Credits both inviter + invitee + persistence ──
    console.log('\n[7] redeemInvite credits both inviter and invitee');
    // Restore (token may have expired in case 6 — get fresh room + invite)
    const roomFor7 = await createGroupBet({
      userId: TEST_CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 5,
      perMemberStake: 5,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
    });
    // Enable bonuses for this test only
    await updateGroupConfig({ groupInviterBonusCoins: 10, groupInviteeBonusCoins: 7, groupInviterBonusCapPerUserPerDay: 50 });
    const inv7 = await createInvite({
      groupId: roomFor7.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: `${RUN_TAG}-7`,
    });
    await setBalance(TEST_CREATOR_ID, 0);
    await setBalance(TEST_MEMBER1_ID, 0);
    const r7 = await redeemInvite({ token: inv7.token, inviteeUserId: TEST_MEMBER1_ID });
    assert(r7.inviterBonus === 10, `inviterBonus=10 (got ${r7.inviterBonus})`);
    assert(r7.inviteeBonus === 7, `inviteeBonus=7 (got ${r7.inviteeBonus})`);
    assert(r7.totalBonus === 17, `totalBonus=17 (got ${r7.totalBonus})`);
    const inviterBalAfter = await readBalance(TEST_CREATOR_ID);
    const inviteeBalAfter = await readBalance(TEST_MEMBER1_ID);
    assert(inviterBalAfter === 10, `inviter bonus credited (got ${inviterBalAfter})`);
    assert(inviteeBalAfter === 7, `invitee bonus credited (got ${inviteeBalAfter})`);
    // Verify the admin_adjustment credit rows
    // Match by invitee/inviter + reason + groupId (NOT campaign — the metadata
    //  stores reason + inviteToken, not campaign)
    const creditRows = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM transactions
        WHERE user_id IN ($1, $2)
          AND type = 'admin_adjustment'
          AND direction = 'credit'
          AND metadata->>'reason' = 'group_invite_bonus'
          AND metadata->>'groupId' = $3`,
      [TEST_CREATOR_ID, TEST_MEMBER1_ID, roomFor7.id],
    );
    assert(creditRows.rows[0].c === 2, `2 admin_adjustment credit rows written (got ${creditRows.rows[0].c})`);

    // ── 8. Daily cap enforcement (inviter already earned 4 today) ──
    console.log('\n[8] groupInviterBonusCapPerUserPerDay caps at 5 (already-earned=4 → earns only 1)');
    // Reset balances and create a fresh room + invite for a third user
    await setBalance(TEST_CREATOR_ID, 0);
    await setBalance(TEST_MEMBER2_ID, 0);
    // Clear any leftover 'group_invite_bonus' rows from prior cases (case 7
    // credited inviter 10 — wipe it so case 8 starts at 0)
    await pgQuery(
      `DELETE FROM transactions WHERE user_id = $1 AND metadata->>'reason' = 'group_invite_bonus' AND created_at >= date_trunc('day', NOW())`,
      [TEST_CREATOR_ID],
    );
    // Add 4 already-earned (manually insert a credit transaction for today)
    await pgQuery(
      `INSERT INTO transactions (user_id, type, amount, currency, direction, status, metadata)
       VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
      [TEST_CREATOR_ID, '4.00000000', JSON.stringify({
        pool: 'group_play', reason: 'group_invite_bonus',
        campaign: `${RUN_TAG}-8-pre-existing`,
      })],
    );
    // Set cap=5, inviter=5 → cap kicks in (4 + 5 > 5 → earns only 1)
    await updateGroupConfig({ groupInviterBonusCoins: 5, groupInviteeBonusCoins: 0, groupInviterBonusCapPerUserPerDay: 5 });
    const roomFor8 = await createGroupBet({
      userId: TEST_CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 5,
      perMemberStake: 5,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
    });
    const inv8 = await createInvite({
      groupId: roomFor8.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: `${RUN_TAG}-8`,
    });
    const r8 = await redeemInvite({ token: inv8.token, inviteeUserId: TEST_MEMBER2_ID });
    assert(r8.inviterBonus === 1, `inviterBonus capped to 1 (got ${r8.inviterBonus})`);
    assert(r8.inviterBonusCapped === true, `inviterBonusCapped=true`);
    const inviterBalAfterCap = await readBalance(TEST_CREATOR_ID);
    assert(inviterBalAfterCap === 1, `inviter credited +1 (got ${inviterBalAfterCap})`);

    // ── 9. Zero-bonus no-op (no credit rows written) ──
    console.log('\n[9] groupInviterBonusCoins=0 → no credit rows written');
    await updateGroupConfig({ groupInviterBonusCoins: 0, groupInviteeBonusCoins: 0 });
    await setBalance(TEST_CREATOR_ID, 0);
    await setBalance(TEST_MEMBER1_ID, 0);
    const roomFor9 = await createGroupBet({
      userId: TEST_CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 1,
      perMemberStake: 1,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
    });
    const inv9 = await createInvite({
      groupId: roomFor9.id,
      inviterId: TEST_CREATOR_ID,
      channel: 'copy',
      campaign: `${RUN_TAG}-9`,
    });
    const r9 = await redeemInvite({ token: inv9.token, inviteeUserId: TEST_MEMBER1_ID });
    assert(r9.inviterBonus === 0, `inviterBonus=0 (got ${r9.inviterBonus})`);
    assert(r9.inviteeBonus === 0, `inviteeBonus=0 (got ${r9.inviteeBonus})`);
    assert(r9.totalBonus === 0, `totalBonus=0 (got ${r9.totalBonus})`);
    const inviterBalAfter9 = await readBalance(TEST_CREATOR_ID);
    assert(inviterBalAfter9 === 0, `inviter balance unchanged (got ${inviterBalAfter9})`);
    // The invite row in group_bet_invite_event_log should still be written
    const evLogR9 = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_invite
        WHERE invitee_user_id = $1 AND bonus_awarded = 0
          AND channel = 'copy'
          AND created_at > NOW() - interval '1 minute'
          AND id::text LIKE $2`,
      [TEST_MEMBER1_ID, '%'],
    );
    assert(evLogR9.rows[0].c >= 1, `invite event-log row written even with 0 bonus (got ${evLogR9.rows[0].c})`);
    // Token redemption_count should have incremented
    const incrR9 = await pgQuery<{ redemption_count: number }>(
      `SELECT redemption_count FROM group_bet_invite_link WHERE token = $1`, [inv9.token],
    );
    assert(incrR9.rows[0]?.redemption_count === 1, `redemption_count incremented to 1 (got ${incrR9.rows[0]?.redemption_count})`);

    // ── 10. Audit row ──
    console.log('\n[10] audit row written with action=bonus_award + payload.inviterId/inviteeId');
    const auditRows = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM group_bet_audit
        WHERE action = 'bonus_award'
          AND payload->>'trigger' = 'invite_redeem'
          AND payload->>'inviterId' = $1
          AND payload->>'inviteeId' = $2`,
      [TEST_CREATOR_ID, TEST_MEMBER1_ID],
    );
    assert(auditRows.rows[0].c >= 1, `>=1 bonus_award audit row (got ${auditRows.rows[0].c})`);

    // Reset config so other tests aren't affected
    await resetGroupConfig();

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-2-04 assertions failed.');
    else console.log('🎉 All gp-2-04 assertions passed.');
  } finally {
    console.log(`\n[cleanup] removing test rows for run-tag ${RUN_TAG}…`);
    try {
      // Reset config in case of any failures
      try { await resetGroupConfig(); } catch {}
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
