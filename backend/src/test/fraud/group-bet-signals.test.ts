/**
 * ════════════════════════════════════════════════════════════════
 *  gp-13-fraud: group-bet-signals — 4 fraud-signal scenarios
 *  ════════════════════════════════════════════════════════════════
 *
 *  Gap 13 — covers the four highest-priority fraud signals in
 *  group-bet-fraud.ts:
 *    1. Sybil cluster — ≥3 members on the same IP
 *    2. Invite farm — creator had ≥3 rooms in 24h
 *    3. Founder collusion — creator win-rate > 60% over ≥10 rounds
 *    4. Withdraw hold — pool ≥ $5K
 *
 *  Each scenario runs the real evaluateOnJoin/evaluateOnFlip and
 *  asserts on the returned signal set (or on the persisted
 *  fraud_signals row). Cleanup runs at the end.
 *
 *  Run:
 *    DATABASE_URL=... npx ts-node src/test/fraud/group-bet-signals.test.ts
 */

import { Client } from 'pg';

let failed = false;
let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('  PASS:', msg); passed++; }
  else { console.error('  FAIL:', msg); failed = true; }
}

const DATABASE_URL = process.env.DATABASE_URL as string;
if (!DATABASE_URL) { console.error('FATAL: DATABASE_URL required'); process.exit(2); }

const pg = new Client({ connectionString: DATABASE_URL });
let connected = false;
async function pgQ<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
  if (!connected) { await pg.connect(); connected = true; }
  const r = await pg.query(text, params);
  return { rows: r.rows as T[] };
}

const RUN_TAG = `gp13f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 8);
const CREATOR_ID = '0fd1b26a-d82c-4968-a370-46198fd945cc';
const MEMBER1_ID = '01affa37-0e1d-4dfd-81a9-b6ade0094321';

const {
  evaluateOnJoin,
  evaluateOnFlip,
} = require('../../services/group-bet-fraud');

const RUN_TAG_LIKE = `%${RUN_TAG}%`;

async function cleanup(): Promise<void> {
  await pgQ(`DELETE FROM group_bet_audit WHERE payload::text LIKE $1`, [RUN_TAG_LIKE]);
  await pgQ(`DELETE FROM fraud_signals WHERE fingerprint LIKE $1 OR metadata::text LIKE $1`, [RUN_TAG_LIKE]);
  await pgQ(`DELETE FROM group_bet_member WHERE group_id IN (SELECT id FROM group_bet WHERE short_code LIKE $1)`, [`${RUN_TAG}%`]);
  await pgQ(`DELETE FROM group_bet WHERE short_code LIKE $1`, [`${RUN_TAG}%`]);
}

async function setBalance(userId: string, balance: number): Promise<void> {
  await pgQ(`UPDATE users SET withdrawable_balance_coins = $1 WHERE id = $2`, [balance.toFixed(8), userId]);
}

async function createGroupStub(opts: { suffix: string; ipAddress?: string } = {}): Promise<{ groupId: string; shortCode: string }> {
  const tag = `${RUN_TAG}${opts.suffix}`.slice(0, 10);
  const r = await pgQ<{ id: string }>(
    `INSERT INTO group_bet
       (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
        invite_token, expires_at, status)
     VALUES ($1, $2, 'heads', 1, 1, $3, NOW() + interval '24 hours', 'open')
     RETURNING id`,
    [tag, CREATOR_ID, `${RUN_TAG}-${opts.suffix}-token`],
  );
  // Add the creator as a member (real rooms do this on createGroupBet)
  await pgQ(
    `INSERT INTO group_bet_member (group_id, user_id, role, choice, stake, weight)
     VALUES ($1, $2, 'creator', 'heads', 1, 1.0)`,
    [r.rows[0].id, CREATOR_ID],
  );
  return { groupId: r.rows[0].id, shortCode: tag };
}

async function scenario(n: number, name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[scenario ${n}] ${name}`);
  try { await fn(); }
  catch (e: any) { console.error(`  EXCEPTION: ${e?.message}`); failed = true; }
}

async function runAll(): Promise<void> {
  await setBalance(CREATOR_ID, 1000);
  await setBalance(MEMBER1_ID, 1000);

  // ── 1. Sybil cluster: 3 members share the same IP ─────────────
  await scenario(1, 'sybil cluster (3 members same IP)', async () => {
    const { groupId } = await createGroupStub({ suffix: 'S1' });
    // Insert 3 member rows with registration_ip = the same IP
    const sybilIp = '203.0.113.42';
    // Pre-set the joining users' registration_ip
    await pgQ(`UPDATE users SET registration_ip = $1 WHERE id IN ($2, $3)`, [sybilIp, CREATOR_ID, MEMBER1_ID]);
    // Add 2 extra members to push the count over the threshold (3)
    const extra1 = `00000000-0000-4000-8000-000000000001`.replace(/0{8}$/, Math.floor(Math.random() * 1e8).toString(16).padStart(8, '0'));
    const extra2 = `00000000-0000-4000-8000-000000000002`.replace(/0{8}$/, Math.floor(Math.random() * 1e8).toString(16).padStart(8, '0'));
    for (const uid of [extra1, extra2]) {
      await pgQ(
        `INSERT INTO users (id, username, password_hash, is_active, is_admin, kyc_tier, kyc_status,
                             kyc_country, total_deposited_coins, withdrawable_balance_coins,
                             bonus_balance_coins, registration_ip, total_wagered, pending_rakeback)
         VALUES ($1, $2, '$2a$08$fakehashfakehashfakehashfakehashfakehashfakehash', true, false, 1, 'unverified', 'BD', 100, 100, 0, $3, 0, 0)
         ON CONFLICT (id) DO NOTHING`,
        [uid, `sybil_${uid.slice(0, 8)}`, sybilIp],
      );
      await pgQ(
        `INSERT INTO group_bet_member (group_id, user_id, role, choice, stake, weight)
         VALUES ($1, $2, 'member', 'heads', 1, 1.0)`,
        [groupId, uid],
      );
    }
    const signals = await evaluateOnJoin({
      groupId,
      userId: MEMBER1_ID,
      ipAddress: sybilIp,
      countryCode: 'BD',
    });
    const sybilSignal = signals.find((s: any) => s.signalType === 'group_sybil_suspected');
    assert(sybilSignal !== undefined, 'group_sybil_suspected signal fired');
    if (sybilSignal) {
      assert(sybilSignal.severity === 'high', 'severity=high');
    }
    // Cleanup the temp users
    await pgQ(`DELETE FROM group_bet_member WHERE user_id IN ($1, $2)`, [extra1, extra2]);
    await pgQ(`DELETE FROM users WHERE id IN ($1, $2)`, [extra1, extra2]);
  });

  // ── 2. Invite farm: creator had ≥3 rooms in 24h ────────────
  await scenario(2, 'invite farm (creator ≥3 rooms in 24h)', async () => {
    // Insert 3 historical rooms for the creator in the last 24h
    for (let i = 0; i < 3; i++) {
      const tag = `${RUN_TAG}I${i}`.slice(0, 10);
      await pgQ(
        `INSERT INTO group_bet (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
                                invite_token, expires_at, status, created_at)
         VALUES ($1, $2, 'heads', 1, 1, $3, NOW() + interval '24 hours', 'open', NOW() - interval '1 hour')`,
        [tag, CREATOR_ID, `${RUN_TAG}-invite-farm-${i}`],
      );
    }
    const { groupId } = await createGroupStub({ suffix: 'I2' });
    const signals = await evaluateOnJoin({
      groupId,
      userId: MEMBER1_ID,
      ipAddress: '10.0.0.1',
      countryCode: 'BD',
    });
    const farmSignal = signals.find((s: any) => s.signalType === 'group_invite_farm_suspected');
    assert(farmSignal !== undefined, 'group_invite_farm_suspected signal fired');
    if (farmSignal) {
      assert(farmSignal.severity === 'medium', 'severity=medium');
    }
  });

  // ── 3. Founder collusion: win-rate > 60% over ≥10 rounds ───
  await scenario(3, 'founder collusion (win-rate > 60% on 11 resolved rooms)', async () => {
    // Insert 11 resolved rooms where the creator won 8/11 = 73%
    for (let i = 0; i < 11; i++) {
      const tag = `${RUN_TAG}F${i}`.slice(0, 10);
      const winningSide = i < 8 ? 'heads' : 'tails';
      const creatorChoice = 'heads';
      await pgQ(
        `INSERT INTO group_bet (short_code, creator_id, creator_choice, creator_stake, per_member_stake,
                                invite_token, expires_at, status, resolved_at, winning_side)
         VALUES ($1, $2, $3, 1, 1, $4, NOW() - interval '1 day', 'resolved', NOW() - interval '1 day', $5)`,
        [tag, CREATOR_ID, creatorChoice, `${RUN_TAG}-founder-${i}`, winningSide],
      );
    }
    const { groupId } = await createGroupStub({ suffix: 'F2' });
    // Update the last stub to founder_boost so the signal is relevant
    await pgQ(`UPDATE group_bet SET payout_mode = 'founder_boost' WHERE id = $1`, [groupId]);
    const signals = await evaluateOnFlip({
      groupId,
      creatorId: CREATOR_ID,
      totalPool: 1,
      creatorStake: 1,
      maxMembers: 5,
      winningSide: 'heads',
      payoutMode: 'founder_boost',
      ipAddress: null,
    });
    const collusionSignal = signals.find((s: any) => s.signalType === 'group_founder_collusion');
    assert(collusionSignal !== undefined, 'group_founder_collusion signal fired');
    if (collusionSignal) {
      assert(collusionSignal.severity === 'medium', 'severity=medium');
    }
  });

  // ── 4. Withdraw hold: pool ≥ $5K ────────────────────────────
  await scenario(4, 'withdraw hold (pool ≥ $5K)', async () => {
    const { groupId } = await createGroupStub({ suffix: 'W1' });
    const signals = await evaluateOnFlip({
      groupId,
      creatorId: CREATOR_ID,
      totalPool: 6000,  // > $5K threshold
      creatorStake: 3000,
      maxMembers: 5,
      winningSide: 'heads',
      payoutMode: 'equal',
      ipAddress: null,
    });
    const holdSignal = signals.find((s: any) => s.signalType === 'group_withdraw_hold');
    assert(holdSignal !== undefined, 'group_withdraw_hold signal fired');
    if (holdSignal) {
      assert(holdSignal.severity === 'low', 'severity=low');
    }
  });

  await cleanup();
  console.log(`\n${passed} assertions passed.`);
  await pg.end();
  if (failed) process.exit(1);
  process.exit(0);
}

runAll().catch(async (e) => {
  console.error('FATAL:', e);
  try { await cleanup(); } catch {}
  try { await pg.end(); } catch {}
  process.exit(1);
});
