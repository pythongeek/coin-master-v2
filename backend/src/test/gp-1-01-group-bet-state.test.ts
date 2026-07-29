/**
 * ════════════════════════════════════════════════════════════════
 *  gp-1-01: group-bet-state — state machine + audit mirror
 *  ════════════════════════════════════════════════════════════════
 *
 *  Phase 1 / Day 1 — group-play foundation test (live DB).
 *
 *  Verifies (against the LIVE `coin-master-postgres-1` DB):
 *    1. The 6-state finite state machine
 *    2. Illegal transitions rejected
 *    3. fromStatuses mismatch rejected
 *    4. Terminal state guards
 *    5. Each transition writes to `group_bet_audit`
 *    6. Each transition mirrors to `audit_log`
 *    7. Atomic rollback when a sub-INSERT fails
 *    8. TRANSITION_TABLE const matches implementation
 *    9. Module boundary: no other service mutates group_bet.status
 *   10. Empty fromStatuses is a programming error
 *
 *  IMPORTANT: This test does NOT use --require setup.ts because the
 *  shared mock installer replaces `query` with an in-memory function
 *  that doesn't know about `group_bet`. We talk to Postgres via the
 *  `pg` library directly, using DATABASE_URL.
 *
 *  Run with:
 *    DATABASE_URL=postgresql://cryptoflip:***@127.0.0.1:55432/cryptoflip \
 *    CREATOR_ID=<uuid> ACTOR_ID=<uuid> \
 *      npx ts-node src/test/gp-1-01-group-bet-state.test.ts
 * ════════════════════════════════════════════════════════════════
 */

import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('PASS:', msg); }
  else { console.error('FAIL:', msg); failed = true; }
}

const DATABASE_URL = process.env.DATABASE_URL;
const CREATOR_ID = process.env.TEST_CREATOR_ID || null;
const ACTOR_ID = process.env.TEST_ACTOR_ID || null;

if (!DATABASE_URL || !CREATOR_ID || !ACTOR_ID) {
  console.error('FATAL: DATABASE_URL, TEST_CREATOR_ID, TEST_ACTOR_ID required.');
  process.exit(2);
}

// ── Direct DB client (bypasses setup.ts mock) ───────────────────
const pg = new Client({ connectionString: DATABASE_URL });
let connected = false;

async function pgQuery<T = any>(text: string, params: any[] = []): Promise<{ rows: T[]; rowCount: number }> {
  if (!connected) {
    await pg.connect();
    connected = true;
  }
  const r = await pg.query(text, params);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

const RUN_TAG = `gp-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function makeGroupBetRow(overrides: Record<string, any> = {}): Promise<string> {
  // short_code is UNIQUE in group_bet. Combine RUN_TAG (8 chars) + a
  // high-entropy 6-char random suffix. 8 + 6 = 14 trimmed to 10.
  // Tag prefix keeps cleanup easy: `DELETE WHERE short_code LIKE <tag>%`.
  const tag = RUN_TAG.toUpperCase().slice(0, 8);
  const suffix = Array.from({ length: 8 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
  const shortCode = `${tag}${suffix}`.slice(0, 10);
  const r = await pgQuery<{ id: string }>(
    `INSERT INTO group_bet
       (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
        invite_token, expires_at, status)
     VALUES ($1, $2, 'heads', 50, 50, $3, NOW() + interval '24 hours', $4)
     RETURNING id`,
    [shortCode, CREATOR_ID, `${RUN_TAG}-tk-${Math.random().toString(36).slice(2, 16)}`, overrides.status || 'open'],
  );
  return r.rows[0].id;
}

async function cleanup(): Promise<void> {
  const tag = RUN_TAG.toUpperCase().slice(0, 10);
  await pgQuery(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM audit_log WHERE details::text LIKE $1`, [`%${RUN_TAG}%`]);
  await pgQuery(`DELETE FROM group_bet WHERE short_code LIKE $1`, [`${tag}%`]);
}

async function rowStatus(id: string): Promise<string> {
  const r = await pgQuery<{ status: string }>(`SELECT status FROM group_bet WHERE id = $1`, [id]);
  return r.rows[0]?.status ?? 'MISSING';
}

async function auditCount(id: string): Promise<number> {
  const r = await pgQuery<{ c: number }>(`SELECT count(*)::int AS c FROM group_bet_audit WHERE group_id = $1`, [id]);
  return r.rows[0]?.c ?? 0;
}

// ── Service under test ──────────────────────────────────────────
const {
  transitionGroupStatus,
  isTerminalStatus,
  isTransitionAllowed,
  TRANSITION_TABLE,
  GroupBetTransitionError,
} = require('../services/group-bet-state');

async function runTests(): Promise<void> {
  const createdIds: string[] = [];
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // ──────────────────────────────────────────────────────────────
    console.log('\n[1] Happy path: open → ready → flipping → resolved');
    const g1 = await makeGroupBetRow();
    createdIds.push(g1);

    let r = await transitionGroupStatus(
      { groupId: g1, actorId: ACTOR_ID, payload: { runTag: RUN_TAG, memberCount: 2 } },
      { fromStatuses: ['open'], toStatus: 'ready', action: 'ready' },
    );
    assert(r.previousStatus === 'open', 'previousStatus === open');
    assert(r.newStatus === 'ready', 'newStatus === ready');
    assert(r.row.status === 'ready', 'returned row.status === ready');
    assert(r.row.ready_at !== null, 'ready_at populated');
    assert((await rowStatus(g1)) === 'ready', 'DB row.status === ready');

    r = await transitionGroupStatus(
      { groupId: g1, actorId: CREATOR_ID, payload: { runTag: RUN_TAG, nonce: 123 } },
      { fromStatuses: ['ready'], toStatus: 'flipping', action: 'flip_start',
        extraColumnsSql: 'server_seed_hash = $3',
        extraColumnsParams: ['abc123hash'] },
    );
    assert(r.previousStatus === 'ready', 'previousStatus === ready');
    assert(r.newStatus === 'flipping', 'newStatus === flipping');
    assert(r.row.server_seed_hash === 'abc123hash', 'server_seed_hash persisted');

    r = await transitionGroupStatus(
      { groupId: g1, actorId: null, payload: { runTag: RUN_TAG, winningSide: 'heads' } },
      { fromStatuses: ['flipping'], toStatus: 'resolved', action: 'flip_resolve',
        extraColumnsSql: 'winning_side = $3, resolved_at = NOW()',
        extraColumnsParams: ['heads'],
        auditSeverity: 'info' },
    );
    assert(r.previousStatus === 'flipping', 'previousStatus === flipping');
    assert(r.newStatus === 'resolved', 'newStatus === resolved');
    assert(r.row.winning_side === 'heads', 'winning_side persisted');
    assert(r.row.resolved_at !== null, 'resolved_at populated');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[2] Cancel paths (open and ready)');
    const g2a = await makeGroupBetRow();
    const g2b = await makeGroupBetRow({ status: 'ready' });
    createdIds.push(g2a, g2b);

    const r2a = await transitionGroupStatus(
      { groupId: g2a, actorId: CREATOR_ID, payload: { runTag: RUN_TAG } },
      { fromStatuses: ['open'], toStatus: 'cancelled', action: 'cancel' },
    );
    assert(r2a.newStatus === 'cancelled', 'open → cancelled works');

    const r2b = await transitionGroupStatus(
      { groupId: g2b, actorId: CREATOR_ID, payload: { runTag: RUN_TAG } },
      { fromStatuses: ['ready'], toStatus: 'cancelled', action: 'cancel' },
    );
    assert(r2b.newStatus === 'cancelled', 'ready → cancelled works');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[3] Expire paths');
    const g3a = await makeGroupBetRow();
    const g3b = await makeGroupBetRow({ status: 'ready' });
    createdIds.push(g3a, g3b);

    const r3a = await transitionGroupStatus(
      { groupId: g3a, actorId: null, payload: { runTag: RUN_TAG } },
      { fromStatuses: ['open'], toStatus: 'expired', action: 'expire', auditSeverity: 'warn' },
    );
    assert(r3a.newStatus === 'expired', 'open → expired works (system actor)');

    const r3b = await transitionGroupStatus(
      { groupId: g3b, actorId: null, payload: { runTag: RUN_TAG } },
      { fromStatuses: ['ready'], toStatus: 'expired', action: 'expire', auditSeverity: 'warn' },
    );
    assert(r3b.newStatus === 'expired', 'ready → expired works');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[4] Illegal transitions rejected');
    const g4 = await makeGroupBetRow();
    createdIds.push(g4);

    let threw = false;
    try {
      // Real call: resolve can only come from 'flipping'. Pass
      // fromStatuses=['flipping'] and current='open', so the helper
      // must throw GROUP_BET_INVALID_TRANSITION.
      await transitionGroupStatus(
        { groupId: g4, actorId: CREATOR_ID, payload: { runTag: RUN_TAG } },
        { fromStatuses: ['flipping'], toStatus: 'resolved', action: 'flip_resolve' },
      );
    } catch (e) {
      threw = true;
      assert(e instanceof GroupBetTransitionError, 'open→resolved is GroupBetTransitionError');
      assert((e as InstanceType<typeof GroupBetTransitionError>).code === 'GROUP_BET_INVALID_TRANSITION', 'wrong code');
    }
    assert(threw, 'open → resolved correctly rejected');

    threw = false;
    try {
      await transitionGroupStatus(
        { groupId: g4, actorId: null, payload: { runTag: RUN_TAG } },
        { fromStatuses: ['pending'], toStatus: 'ready', action: 'ready' },
      );
    } catch { threw = true; }
    assert(threw, 'wrong fromStatus correctly rejected');

    threw = false;
    try {
      await transitionGroupStatus(
        { groupId: '00000000-0000-0000-0000-000000000000', actorId: ACTOR_ID, payload: { runTag: RUN_TAG } },
        { fromStatuses: ['open'], toStatus: 'ready', action: 'ready' },
      );
    } catch (e) {
      threw = true;
      assert((e as InstanceType<typeof GroupBetTransitionError>).code === 'GROUP_BET_NOT_FOUND', 'not-found code');
    }
    assert(threw, 'non-existent group raises');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[5] Terminal state guards');
    for (const terminal of ['resolved', 'cancelled', 'expired'] as const) {
      const g5 = await makeGroupBetRow({ status: terminal });
      createdIds.push(g5);

      let tThrew = false;
      try {
        await transitionGroupStatus(
          { groupId: g5, actorId: ACTOR_ID, payload: { runTag: RUN_TAG } },
          { fromStatuses: ['open'], toStatus: 'open', action: 'ready' },
        );
      } catch { tThrew = true; }
      assert(tThrew, `terminal ${terminal} cannot transition to open`);

      assert(isTerminalStatus(terminal as any), `isTerminalStatus(${terminal}) === true`);
    }
    assert(!isTerminalStatus('open'), 'open is NOT terminal');
    assert(!isTerminalStatus('ready'), 'ready is NOT terminal');
    assert(!isTerminalStatus('flipping'), 'flipping is NOT terminal');
    assert(!isTerminalStatus('pending'), 'pending is NOT terminal');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[6] Audit mirror — every transition writes both ledgers');
    const g6 = await makeGroupBetRow();
    createdIds.push(g6);

    await transitionGroupStatus(
      { groupId: g6, actorId: CREATOR_ID, ipAddress: '203.0.113.10', payload: { runTag: RUN_TAG } },
      { fromStatuses: ['open'], toStatus: 'ready', action: 'ready' },
    );
    await transitionGroupStatus(
      { groupId: g6, actorId: CREATOR_ID, payload: { runTag: RUN_TAG } },
      { fromStatuses: ['ready'], toStatus: 'cancelled', action: 'cancel', auditSeverity: 'warn' },
    );

    assert((await auditCount(g6)) === 2, 'group_bet_audit has 2 rows');

    const audits = await pgQuery<any>(
      `SELECT action, payload, actor_id, ip_address::text AS ip_address
         FROM group_bet_audit WHERE group_id = $1 ORDER BY created_at ASC`,
      [g6],
    );
    const first = audits.rows[0];
    assert(first.action === 'ready', 'first audit action = ready');
    assert(first.actor_id === CREATOR_ID, 'audit actor_id matches');
    assert(
      String(first.ip_address).includes('203.0.113.10'),
      `audit ip_address captured (got ${first.ip_address})`,
    );
    assert(first.payload.previousStatus === 'open', 'audit payload has previousStatus');
    assert(first.payload.newStatus === 'ready', 'audit payload has newStatus');
    assert(first.payload.runTag === RUN_TAG, 'audit payload has runTag');

    const logs = await pgQuery<any>(
      `SELECT category, severity, user_id FROM audit_log
        WHERE action = 'group_play.ready' AND details::text LIKE $1
        ORDER BY created_at DESC LIMIT 1`,
      [`%${RUN_TAG}%`],
    );
    assert(logs.rows.length > 0, 'audit_log row exists for group_play.ready');
    assert(logs.rows[0].category === 'group_play', 'audit_log category = group_play');
    assert(logs.rows[0].user_id === CREATOR_ID, 'audit_log user_id mirrors');

    const cancelLogs = await pgQuery<any>(
      `SELECT severity FROM audit_log WHERE action = 'group_play.cancel' AND details::text LIKE $1 LIMIT 1`,
      [`%${RUN_TAG}%`],
    );
    assert(cancelLogs.rows[0].severity === 'warn', 'cancel uses warn severity');

    const second = audits.rows[1];
    assert(second.action === 'cancel', 'second audit action = cancel');
    assert(second.payload.previousStatus === 'ready', 'second payload.previousStatus = ready');
    assert(second.payload.newStatus === 'cancelled', 'second payload.newStatus = cancelled');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[7] Atomicity: rollback when audit sub-INSERT fails');
    const g7 = await makeGroupBetRow();
    createdIds.push(g7);

    let failedThrew = false;
    try {
      await transitionGroupStatus(
        { groupId: g7, actorId: '00000000-0000-0000-0000-000000000000', payload: { runTag: RUN_TAG } },
        { fromStatuses: ['open'], toStatus: 'ready', action: 'ready' },
      );
    } catch { failedThrew = true; }
    assert(failedThrew, 'transitionGroupStatus throws on FK violation');
    assert((await rowStatus(g7)) === 'open', 'status remains open (tx rolled back)');
    assert((await auditCount(g7)) === 0, 'no group_bet_audit row committed');

    // ──────────────────────────────────────────────────────────────
    console.log('\n[8] TRANSITION_TABLE const matches real implementation');
    assert(isTransitionAllowed('open', 'ready'), 'open → ready allowed');
    assert(isTransitionAllowed('ready', 'flipping'), 'ready → flipping allowed');
    assert(isTransitionAllowed('flipping', 'resolved'), 'flipping → resolved allowed');
    assert(isTransitionAllowed('open', 'cancelled'), 'open → cancelled allowed');
    assert(isTransitionAllowed('ready', 'cancelled'), 'ready → cancelled allowed');
    assert(isTransitionAllowed('open', 'expired'), 'open → expired allowed');
    assert(isTransitionAllowed('ready', 'expired'), 'ready → expired allowed');

    assert(!isTransitionAllowed('open', 'resolved'), 'open → resolved forbidden');
    assert(!isTransitionAllowed('resolved', 'open'), 'resolved → open forbidden');
    assert(!isTransitionAllowed('cancelled', 'ready'), 'cancelled → ready forbidden');
    assert(!isTransitionAllowed('expired', 'open'), 'expired → open forbidden');
    assert(!isTransitionAllowed('flipping', 'cancelled'), 'flipping → cancelled forbidden');

    const tuples: string[] = TRANSITION_TABLE.map((t: { from: string; to: string }) => `${t.from}→${t.to}`);
    const unique = new Set(tuples);
    assert(unique.size === tuples.length, 'TRANSITION_TABLE has no duplicate transitions');
    assert(tuples.length === 7, `TRANSITION_TABLE has 7 rows (got ${tuples.length})`);

    // ──────────────────────────────────────────────────────────────
    console.log('\n[9] Anti-pattern guard: no raw "UPDATE group_bet SET status" elsewhere');
    const servicesDir = path.join(__dirname, '..', 'services');
    const offenders: string[] = [];
    for (const fname of fs.readdirSync(servicesDir)) {
      if (!fname.endsWith('.ts')) continue;
      if (fname === 'group-bet-state.ts') continue;
      const src = fs.readFileSync(path.join(servicesDir, fname), 'utf-8');
      if (/UPDATE\s+group_bet\s+SET\s+status/i.test(src)) {
        offenders.push(fname);
      }
    }
    assert(offenders.length === 0, `no service mutates group_bet.status directly (found: ${offenders.join(',') || 'none'})`);

    // ──────────────────────────────────────────────────────────────
    console.log('\n[10] Empty fromStatuses is rejected at helper level');
    const g10 = await makeGroupBetRow();
    createdIds.push(g10);

    let emptyThrew = false;
    try {
      await transitionGroupStatus(
        { groupId: g10, actorId: CREATOR_ID, payload: { runTag: RUN_TAG } },
        { fromStatuses: [], toStatus: 'ready', action: 'ready' },
      );
    } catch (e) {
      emptyThrew = true;
      assert(/fromStatuses cannot be empty/.test((e as Error).message), 'clear error message');
    }
    assert(emptyThrew, 'empty fromStatuses throws');

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-1-01 assertions failed.');
    else console.log('🎉 All gp-1-01 assertions passed.');
  } finally {
    console.log(`\n[cleanup] removing ${createdIds.length} test rows for run-tag ${RUN_TAG}...`);
    try { await cleanup(); console.log('[cleanup] done.'); }
    catch (e) { console.error('[cleanup] FAILED:', (e as Error).message); }
    if (connected) await pg.end();
    process.exit(failed ? 1 : 0);
  }
}

runTests().catch((e) => {
  console.error('Unhandled error:', e?.message || e);
  if (connected) pg.end().catch(() => {});
  process.exit(1);
});
