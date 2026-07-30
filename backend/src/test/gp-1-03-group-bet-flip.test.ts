/**
 * ════════════════════════════════════════════════════════════════
 *  gp-1-03: group-bet-flip — provably-fair resolve (Day 3)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies (against LIVE Postgres + server_seeds + transactions):
 *    1. createGroupBet happy path → group ready
 *    2. 2 members join → status='ready'
 *    3. flipGroup happy path → status='resolved', server_seed_hash ==
 *       hashServerSeed(server_seed_reveal), winningSide matches result
 *    4. Provably-fair: result_hash == raw_hash, rawValue in 0..100
 *    5. Audit trail: group_bet_audit has 'flip_start' + 'flip_resolve' rows
 *    6. Audit mirror: audit_log has group_play.flip_start + group_play.flip_resolve
 *    7. Members are paid out: payout_amount column populated, balances
 *       reflect credits, transactions('payout') rows exist
 *    8. Idempotency: flipping an already-resolved group → 409
 *    9. Turn-mode enforcement: turn_mode='creator' rejects non-creator flip
 *   10. Anti-fraud: frozen group → 403
 *   11. Payout-mode 'equal': sum(payouts) === totalPool
 *   12. Payout-mode 'founder_boost': creator gets 10% boost
 *
 *  Run with:
 *    DATABASE_URL=... REDIS_HOST=127.0.0.1 CREATOR_ID=... MEMBER1=... MEMBER2=...
 *      bash scripts/test-group-bet-flip.sh
 * ════════════════════════════════════════════════════════════════
 */

import { Client } from 'pg';
import { createHash } from 'node:crypto';

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

const RUN_TAG = `gp3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const {
  createGroupBet,
  GroupBetValidationError,
  GroupBetNotAllowedError,
} = require('../services/group-bet-create');
const { joinGroupBet } = require('../services/group-bet-join');
const { flipGroup } = require('../services/group-bet-flip');
const { hashServerSeed, resolveFlip, generateServerSeed } = require('../services/provably-fair');

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

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // Top up balances + ensure lifetime deposits
    try {
      await setBalance(_CREATOR_ID, 100_000);
      await setBalance(_MEMBER1_ID, 100_000);
      await setBalance(_MEMBER2_ID, 100_000);
    } catch (e: any) {
      console.error('[setup] setBalance failed:', e?.message);
      throw e;
    }
    for (const uid of [_CREATOR_ID, _MEMBER1_ID, _MEMBER2_ID]) {
      const depCount = await pgQuery<{ c: number }>(`SELECT count(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status='confirmed'`, [uid]);
      if (depCount.rows[0].c === 0) {
        await pgQuery(`INSERT INTO transactions (user_id, type, amount, currency, direction, status) VALUES ($1, 'deposit', 100, 'USD', 'credit', 'confirmed')`, [uid]);
      }
    }

    // ── Case 1: create + 2 members join → status='ready' ──
    // We use minMembers=3 so we can verify that the auto-ready
    // transition fires when the LAST member joins, not before.
    console.log('\n[1] create + 3 joins → status=ready on last join');
    let created;
    try {
      created = await createGroupBet({
        userId: _CREATOR_ID,
        creatorChoice: 'heads',
        creatorStake: 50,
        perMemberStake: 50,
        minMembers: 3,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
        clientRequestId: `${RUN_TAG}-create`,
        ipAddress: '203.0.113.1',
      });
    } catch (e: any) {
      console.error('[case1] createGroupBet failed:', e?.message, e?.stack?.split('\n').slice(0,5).join('\n'));
      throw e;
    }
    assert(typeof created.id === 'string', 'group created with id');

    // m1 → still open (1 creator + 1 member < minMembers 3)
    await joinGroupBet({
      userId: _MEMBER1_ID,
      groupIdentifier: created.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-m1`,
      ipAddress: '203.0.113.2',
    });
    const afterM1 = await pgQuery<{ status: string }>(`SELECT status FROM group_bet WHERE id = $1`, [created.id]);
    assert(afterM1.rows[0].status === 'open', `still open after m1 (got ${afterM1.rows[0].status})`);

    // m2 → auto-transitions to ready (1 creator + 2 members = minMembers 3)
    await joinGroupBet({
      userId: _MEMBER2_ID,
      groupIdentifier: created.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-m2`,
      ipAddress: '203.0.113.3',
    });
    const beforeFlip = await pgQuery<{ status: string }>(`SELECT status FROM group_bet WHERE id = $1`, [created.id]);
    assert(beforeFlip.rows[0].status === 'ready', 'group is ready after m2 (minMembers reached)');

    // ── Case 2: flip happy path (creator turns) ──
    console.log('\n[2] flipGroup happy path');
    // Snapshot balances AFTER case 1's debits but BEFORE the main flip
    // (so we test only this flip's effect, not the cumulative effect of
    // cases 9-12 which would also be applied by test cleanup later).
    const creatorBalBefore = await readBalance(_CREATOR_ID);
    const m1BalBefore = await readBalance(_MEMBER1_ID);
    const m2BalBefore = await readBalance(_MEMBER2_ID);

    let flipResult;
    try {
      flipResult = await flipGroup({
        userId: _CREATOR_ID,
        groupIdentifier: created.id,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      console.error('[case2] flipGroup failed:', e?.message);
      console.error('[case2] stack:', e?.stack?.split('\n').slice(0, 8).join('\n'));
      throw e;
    }
    assert(flipResult.status === 'resolved', 'flip result status = resolved');
    assert(['heads', 'tails'].includes(flipResult.winningSide), `winningSide is heads/tails (got ${flipResult.winningSide})`);
    assert(typeof flipResult.serverSeedHash === 'string' && flipResult.serverSeedHash.length === 64, `serverSeedHash is 64-hex (got length ${flipResult.serverSeedHash.length})`);
    assert(typeof flipResult.serverSeedReveal === 'string' && flipResult.serverSeedReveal.length === 64, `serverSeedReveal is 64-hex (got length ${flipResult.serverSeedReveal.length})`);

    // ── Case 3: provably-fair verification ──
    console.log('\n[3] provably-fair verification (hash matches)');
    const computed = hashServerSeed(flipResult.serverSeedReveal);
    assert(computed === flipResult.serverSeedHash, `hashServerSeed(reveal) === hash (got ${computed} vs ${flipResult.serverSeedHash})`);

    // Re-run resolveFlip() with the same seeds + ORIGINAL creator's
    // choice. The rerun should produce the same rawValue/rawHash.
    // We don't compare `result` (the won/not-won derived field) because
    // resolveFlip is parametrised on `choice`, not on `result`.
    const reRun = resolveFlip(
      {
        serverSeed: flipResult.serverSeedReveal,
        serverSeedHash: flipResult.serverSeedHash,
        clientSeed: flipResult.clientSeed,
        nonce: flipResult.nonce,
      },
      'heads',  // creator's original choice (the group was creator_choice='heads')
      parseFloat(flipResult.totalPool),
      2.0,
      2.0,
    );
    assert(reRun.rawValue === flipResult.rawValue, `rerun matches rawValue (got ${reRun.rawValue} vs ${flipResult.rawValue})`);
    assert(reRun.rawHash === flipResult.rawHash, 'rerun matches rawHash');
    // The rerun's `result` equals `winningSide` if creator won, else the opposite
    const expectedRerunResult = reRun.won ? 'heads' : 'tails';
    assert(expectedRerunResult === flipResult.winningSide, `rerun result derivation matches (won=${reRun.won}, expected ${expectedRerunResult} vs ${flipResult.winningSide})`);

    // ── Case 4: DB persistence of provably-fair state ──
    console.log('\n[4] DB persistence of provably-fair columns');
    const dbRow = await pgQuery<any>(`SELECT winning_side, server_seed_hash, server_seed_reveal, client_seed, nonce, result_hash, total_pool::text AS total_pool, resolved_at, status FROM group_bet WHERE id = $1`, [created.id]);
    const r = dbRow.rows[0];
    assert(r.status === 'resolved', 'DB row.status = resolved');
    assert(r.winning_side === flipResult.winningSide, `DB winning_side matches (got ${r.winning_side})`);
    assert(r.server_seed_hash === flipResult.serverSeedHash, 'DB server_seed_hash matches');
    assert(r.server_seed_reveal === flipResult.serverSeedReveal, 'DB server_seed_reveal matches');
    assert(r.client_seed === flipResult.clientSeed, 'DB client_seed matches');
    assert(parseInt(r.nonce) === flipResult.nonce, `DB nonce matches (got ${r.nonce} vs ${flipResult.nonce})`);
    assert(r.result_hash === flipResult.resultHash, 'DB result_hash matches');
    assert(r.resolved_at !== null, 'DB resolved_at populated');

    // ── Case 5: audit trail ──
    console.log('\n[5] audit trail (group_bet_audit + audit_log)');
    const auditRows = await pgQuery<any>(`SELECT action FROM group_bet_audit WHERE group_id = $1 ORDER BY created_at ASC`, [created.id]);
    const actions = auditRows.rows.map(r => r.action);
    assert(actions.includes('create'), 'audit has create');
    assert(actions.includes('join'), 'audit has join');
    assert(actions.includes('ready'), 'audit has ready');
    assert(actions.includes('flip_start'), 'audit has flip_start');
    assert(actions.includes('flip_resolve'), 'audit has flip_resolve');
    assert(actions.indexOf('flip_start') < actions.indexOf('flip_resolve'), 'flip_start logged before flip_resolve');

    const logRows = await pgQuery<any>(`SELECT action, severity, details FROM audit_log WHERE details::text LIKE $1 ORDER BY created_at ASC`, [`%${RUN_TAG}%`]);
    // Also try matching by group_id (the service doesn't always embed RUN_TAG in details)
    const allFlipLogs = await pgQuery<any>(`SELECT action, severity, details FROM audit_log WHERE action IN ('group_play.flip_start','group_play.flip_resolve') AND details::text LIKE $1 ORDER BY created_at ASC`, [`%${created.id}%`]);
    const logActions = allFlipLogs.rows.map(r => r.action);
    assert(logActions.some(a => a === 'group_play.flip_start'), 'audit_log has group_play.flip_start');
    assert(logActions.some(a => a === 'group_play.flip_resolve'), 'audit_log has group_play.flip_resolve');
    assert(allFlipLogs.rows.every(r => r.severity === 'info'), 'all audit_log rows are info severity');

    // ── Case 6: payout distribution (equal mode) ──
    console.log('\n[6] payout distribution: equal mode, sum=totalPool');
    if (flipResult.winningSide === 'heads') {
      // All 3 are winners
      const expectedPerWinner = parseFloat(r.total_pool) / 3;  // 3 winners
      const sumPayouts = flipResult.payouts.reduce((s: number, p: any) => s + parseFloat(p.payout), 0);
      assert(Math.abs(sumPayouts - parseFloat(r.total_pool)) < 0.01,
        `sum(payouts) ≈ totalPool (got ${sumPayouts} vs ${parseFloat(r.total_pool)})`);

      const winners = flipResult.payouts.filter((p: any) => p.isWinner);
      assert(winners.length === 3, `3 winners (got ${winners.length})`);

      for (const p of flipResult.payouts) {
        assert(Math.abs(parseFloat(p.payout) - expectedPerWinner) < 0.01,
          `member ${p.userId.slice(0,8)}: payout ${p.payout} ≈ ${expectedPerWinner.toFixed(8)}`);
      }
    } else {
      // Creator side lost — all payouts should be 0 and house wins
      const sumPayouts = flipResult.payouts.reduce((s: number, p: any) => s + parseFloat(p.payout), 0);
      assert(sumPayouts === 0, `sum(payouts) = 0 when creator side lost (got ${sumPayouts})`);
      const winners = flipResult.payouts.filter((p: any) => p.isWinner);
      assert(winners.length === 0, `0 winners when creator side lost (got ${winners.length})`);
      for (const p of flipResult.payouts) {
        assert(p.isWinner === false, `${p.userId.slice(0,8)} is_winner = false (got ${p.isWinner})`);
        assert(parseFloat(p.payout) === 0, `${p.userId.slice(0,8)} payout = 0 (got ${p.payout})`);
      }
    }

    // ── Case 7: balances credited + transactions(win) rows exist ──
    console.log('\n[7] balances credited + transactions(win) rows exist');
    const creatorBalAfter = await readBalance(_CREATOR_ID);
    const m1BalAfter = await readBalance(_MEMBER1_ID);
    const m2BalAfter = await readBalance(_MEMBER2_ID);
    // The creator was already debited at createGroupBet time, so the
    // flip only ADDS the payout credit (no extra debit). For members,
    // the same applies: the join already debited them.
    const expectedCreatorBal = creatorBalBefore + parseFloat(flipResult.payouts.find((p: any) => p.userId === _CREATOR_ID)?.payout ?? '0');
    const expectedM1Bal = m1BalBefore + parseFloat(flipResult.payouts.find((p: any) => p.userId === _MEMBER1_ID)?.payout ?? '0');
    const expectedM2Bal = m2BalBefore + parseFloat(flipResult.payouts.find((p: any) => p.userId === _MEMBER2_ID)?.payout ?? '0');
    assert(Math.abs(creatorBalAfter - expectedCreatorBal) < 0.01, `creator balance after flip (${creatorBalAfter} ≈ ${expectedCreatorBal})`);
    assert(Math.abs(m1BalAfter - expectedM1Bal) < 0.01, `member1 balance after flip (${m1BalAfter} ≈ ${expectedM1Bal})`);
    assert(Math.abs(m2BalAfter - expectedM2Bal) < 0.01, `member2 balance after flip (${m2BalAfter} ≈ ${expectedM2Bal})`);

    // The win ledger rows exist only when the creator's side won
    if (flipResult.winningSide === 'heads') {
      const payoutTxns = await pgQuery<any>(
        `SELECT user_id, amount::text AS amount
           FROM transactions
          WHERE type = 'win' AND metadata::text LIKE $1`,
        [`%${created.id}%`],
      );
      assert(payoutTxns.rows.length === 3, `3 win ledger rows (got ${payoutTxns.rows.length})`);

      const memberPayouts = await pgQuery<any>(`SELECT user_id, payout_amount::text AS payout, is_winner FROM group_bet_member WHERE group_id = $1 ORDER BY joined_at`, [created.id]);
      assert(memberPayouts.rows.length === 3, '3 group_bet_member rows');
      for (const m of memberPayouts.rows) {
        assert(m.is_winner === true, `${m.user_id.slice(0,8)} is_winner = true`);
        assert(parseFloat(m.payout) > 0, `${m.user_id.slice(0,8)} has positive payout`);
      }
    } else {
      // Creator side lost — no win rows, all members marked is_winner=false
      const payoutTxns = await pgQuery<any>(
        `SELECT user_id FROM transactions WHERE type = 'win' AND metadata::text LIKE $1`,
        [`%${created.id}%`],
      );
      assert(payoutTxns.rows.length === 0, `0 win ledger rows (got ${payoutTxns.rows.length})`);

      const memberPayouts = await pgQuery<any>(`SELECT user_id, payout_amount::text AS payout, is_winner FROM group_bet_member WHERE group_id = $1`, [created.id]);
      for (const m of memberPayouts.rows) {
        assert(m.is_winner === false, `${m.user_id.slice(0,8)} is_winner = false`);
        assert(parseFloat(m.payout) === 0, `${m.user_id.slice(0,8)} payout = 0`);
      }
    }

    // ── Case 8: re-flip an already-resolved group → 409 ──
    console.log('\n[8] re-flip already-resolved → 409');
    let threw8 = false;
    try {
      await flipGroup({
        userId: _CREATOR_ID,
        groupIdentifier: created.id,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      threw8 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'GROUP_NOT_READY', `code = GROUP_NOT_READY (got ${e.code})`);
    }
    assert(threw8, 're-flip rejected');

    // ── Case 9: turn_mode=creator rejects non-creator flip ──
    console.log('\n[9] turn_mode=creator rejects non-creator flip');
    const ownRoom = await createGroupBet({
      userId: _CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 10,
      perMemberStake: 10,
      minMembers: 2,
      maxMembers: 5,
      payoutMode: 'equal',
      turnMode: 'creator',
      clientRequestId: `${RUN_TAG}-own`,
      ipAddress: '203.0.113.1',
    });
    await joinGroupBet({
      userId: _MEMBER1_ID,
      groupIdentifier: ownRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-own-m1`,
      ipAddress: '203.0.113.2',
    });
    let threw9 = false;
    try {
      await flipGroup({
        userId: _MEMBER1_ID,  // not the creator
        groupIdentifier: ownRoom.id,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      threw9 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'NOT_THE_FLIPPER', `code = NOT_THE_FLIPPER (got ${e.code})`);
    }
    assert(threw9, 'non-creator rejected');

    // ── Case 10: frozen group → 403 ──
    console.log('\n[10] frozen group → 403');
    await pgQuery(`UPDATE group_bet SET is_frozen = true WHERE id = $1`, [ownRoom.id]);
    let threw10 = false;
    try {
      await flipGroup({
        userId: _CREATOR_ID,
        groupIdentifier: ownRoom.id,
        ipAddress: '203.0.113.99',
      });
    } catch (e: any) {
      threw10 = true;
      assert(e instanceof GroupBetNotAllowedError, 'thrown is GroupBetNotAllowedError');
      assert(e.code === 'GROUP_FROZEN', `code = GROUP_FROZEN (got ${e.code})`);
    }
    assert(threw10, 'frozen group rejected');
    await pgQuery(`UPDATE group_bet SET is_frozen = false WHERE id = $1`, [ownRoom.id]);

    // ── Case 11: founder_boost mode ──
    console.log('\n[11] founder_boost: creator gets 10% boost');
    // Use minMembers=3 + 2 members so we have 3 winners (creator + 2).
    const founderRoom = await createGroupBet({
      userId: _CREATOR_ID,
      creatorChoice: 'heads',
      creatorStake: 100,
      perMemberStake: 100,
      minMembers: 3,
      maxMembers: 5,
      payoutMode: 'founder_boost',
      turnMode: 'creator',
      clientRequestId: `${RUN_TAG}-founder`,
      ipAddress: '203.0.113.1',
    });
    await joinGroupBet({
      userId: _MEMBER1_ID,
      groupIdentifier: founderRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-founder-m1`,
      ipAddress: '203.0.113.2',
    });
    await joinGroupBet({
      userId: _MEMBER2_ID,
      groupIdentifier: founderRoom.id,
      choice: 'heads',
      clientRequestId: `${RUN_TAG}-founder-m2`,
      ipAddress: '203.0.113.3',
    });

    const founderFlip = await flipGroup({
      userId: _CREATOR_ID,
      groupIdentifier: founderRoom.id,
      ipAddress: '203.0.113.99',
    });
    // If all on winning side:
    if (founderFlip.winningSide === 'heads') {
      // All 3 are winners, so the boost is added to the creator's share
      // of the proportional split (split among all 3 = 1/3 each of 90%)
      const founderCreatorPayout = founderFlip.payouts.find((p: any) => p.userId === _CREATOR_ID)?.payout ?? '0';
      const m1Payout = parseFloat(founderFlip.payouts.find((p: any) => p.userId === _MEMBER1_ID)?.payout ?? '0');
      // The founder should get exactly 10% more than the others (because
      // pool is split 30%/30%/30% + 10% extra to founder = 40%/30%/30%).
      // Members should each get 30% of pool, founder 40%.
      const pool = 300;  // 100 + 100 + 100
      const expectedFounder = pool * 0.4;
      const expectedMember = pool * 0.3;
      assert(Math.abs(parseFloat(founderCreatorPayout) - expectedFounder) < 0.01,
        `founder payout ≈ 40% of pool (got ${founderCreatorPayout}, expected ${expectedFounder})`);
      assert(Math.abs(m1Payout - expectedMember) < 0.01,
        `member1 payout ≈ 30% of pool (got ${m1Payout}, expected ${expectedMember})`);
    } else {
      console.log('     (creator side lost; founder_boost test skipped)');
    }

    // ── Case 12: total payout invariant ──
    console.log('\n[12] total payouts invariant (sum ≈ totalPool) for all modes');
    const allPayouts = founderFlip.payouts.reduce((s: number, p: any) => s + parseFloat(p.payout), 0);
    if (founderFlip.winningSide === 'heads') {
      const founderPool = 300;
      assert(Math.abs(allPayouts - founderPool) < 0.01,
        `founder_boost sum ≈ pool (got ${allPayouts} vs ${founderPool})`);
    } else {
      assert(allPayouts === 0, `founder_boost sum = 0 when creator side lost (got ${allPayouts})`);
    }

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-1-03 assertions failed.');
    else console.log('🎉 All gp-1-03 assertions passed.');
  } finally {
    console.log('\n[cleanup] removing test rows for run-tag ${RUN_TAG}...');
    try {
      if (connected) {
        await pg.end();
        connected = false;
      }
    } catch {}
    try {
      // Re-connect for cleanup
      const freshPg = new Client({ connectionString: DATABASE_URL });
      await freshPg.connect();
      const tag = RUN_TAG.toUpperCase().slice(0, 8);
      await freshPg.query(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1`, [`%${RUN_TAG}%`]);
      await freshPg.query(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
      await freshPg.query(`DELETE FROM transactions WHERE metadata::text LIKE $1`, [`%${RUN_TAG}%`]);
      await freshPg.query(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1)`, [`${tag}%`]);
      await freshPg.query(`DELETE FROM group_bet WHERE short_code LIKE $1`, [`${tag}%`]);
      await freshPg.end();
      console.log('[cleanup] done.');
    } catch (e) {
      console.error('[cleanup] FAILED:', (e as Error).message);
    }
    process.exit(failed ? 1 : 0);
  }
}

runTests().catch((e) => {
  console.error('Unhandled error:', e?.message || e);
  if (connected) pg.end().catch(() => {});
  process.exit(1);
});
