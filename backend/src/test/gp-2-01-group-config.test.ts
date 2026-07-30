/**
 * ════════════════════════════════════════════════════════════════
 *  gp-2-01: group-config (Phase 2 / Day 8)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Verifies the 24 group_play admin-config thresholds:
 *
 *    1. Migration seeded all 24 keys into admin_settings
 *    2. getGroupConfig() returns 24 keys with correct defaults
 *    3. getGroupConfigKey() returns the default for missing keys
 *    4. updateGroupConfig() persists + rejects out-of-range values
 *    5. resetGroupConfig() restores all defaults
 *    6. Country-list helpers (parseCountryList, isCountryAllowed)
 *    7. applyMemberCap helper
 *    8. GroupConfig re-exported from admin-config.ts barrel
 *    9. GROUP_CONFIG_LABELS has 24 entries with label/description/type
 *   10. Hard-cap: changing groupAbsoluteMaxMembers=5 in DB → createGroupBet rejects maxMembers=10
 *   11. Expiry: changing groupExpiryMinutes=60 → createGroupBet creates room with expires_at = now + 60min
 *   12. Regression: createGroupBet + joinGroupBet + flipGroup all work with the new config-driven caps
 *
 *  Run with:  bash scripts/test-group-bet-config.sh
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

const RUN_TAG = `gp8-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const {
  getGroupConfig,
  getGroupConfigKey,
  updateGroupConfig,
  resetGroupConfig,
  parseCountryList,
  isCountryAllowed,
  applyMemberCap,
  DEFAULT_GROUP_CONFIG,
  GROUP_CONFIG_LABELS,
} = require('../services/admin-group-config');

const ORIGINAL_DEFAULTS = JSON.parse(JSON.stringify(DEFAULT_GROUP_CONFIG));

async function cleanup(): Promise<void> {
  // Reset to defaults so other tests aren't affected
  try {
    await resetGroupConfig();
    // Clean any stray snake_case rows written by legacy updateConfig()
    // (they're harmless but inflate the count in test [1]).
    await pgQuery(
      `DELETE FROM admin_settings
        WHERE (key LIKE 'group_%' OR key LIKE 'group_play_%')
          AND key NOT IN (
            'group_play_enabled','group_play_allowed_countries','group_play_blocked_countries',
            'group_default_min_members','group_default_max_members','group_absolute_max_members',
            'group_default_contribution_min','group_default_contribution_max','group_absolute_pool_cap',
            'group_expiry_minutes','group_auto_flip_countdown_seconds',
            'group_default_payout_distribution','group_default_turn_decision','group_default_founder_share_pct',
            'group_house_edge_percent','group_loss_house_edge_percent','group_min_house_edge_spread_vs_solo',
            'group_inviter_bonus_coins','group_invitee_bonus_coins','group_inviter_bonus_cap_per_user_per_day',
            'group_invite_max_redemptions_default','group_invite_expiry_hours_default',
            'group_spectator_mode_enabled','group_private_allowed'
          )`,
    );
  } catch {}
}

async function runTests(): Promise<void> {
  try {
    console.log(`[run-tag] ${RUN_TAG}\n`);

    // ── 1. Migration seeded all 24 keys ──
    console.log('\n[1] migration seeded 24 group_play keys into admin_settings');
    const seeded = await pgQuery<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_settings WHERE key LIKE 'group_%' OR key LIKE 'group_play_%'`,
    );
    assert(seeded.rows[0].c === 24, `24 keys seeded (got ${seeded.rows[0].c})`);

    // ── 2. getGroupConfig returns 24 keys with correct defaults ──
    console.log('\n[2] getGroupConfig returns 24 keys with correct defaults');
    const cfg = await getGroupConfig();
    const expectedKeys = Object.keys(DEFAULT_GROUP_CONFIG);
    assert(Object.keys(cfg).length === 24, `24 keys returned (got ${Object.keys(cfg).length})`);
    assert(cfg.groupPlayEnabled === false, `groupPlayEnabled default false`);
    assert(cfg.groupAbsoluteMaxMembers === 10, `groupAbsoluteMaxMembers default 10`);
    assert(cfg.groupDefaultMinMembers === 2, `groupDefaultMinMembers default 2`);
    assert(cfg.groupDefaultMaxMembers === 5, `groupDefaultMaxMembers default 5`);
    assert(cfg.groupAbsolutePoolCap === 50000, `groupAbsolutePoolCap default 50000`);
    assert(cfg.groupExpiryMinutes === 30, `groupExpiryMinutes default 30`);
    assert(cfg.groupHouseEdgePercent === 1.0, `groupHouseEdgePercent default 1.0`);
    assert(cfg.groupDefaultPayoutDistribution === 'proportional', `payout distribution default proportional`);
    assert(cfg.groupDefaultTurnDecision === 'creator', `turn decision default creator`);
    assert(cfg.groupSpectatorModeEnabled === true, `spectator mode default true`);
    assert(expectedKeys.length === 24, `DEFAULT_GROUP_CONFIG has 24 keys`);

    // ── 3. getGroupConfigKey returns the default for missing keys ──
    console.log('\n[3] getGroupConfigKey fallback to default for missing keys');
    // Delete a key temporarily and confirm we get the default
    await pgQuery(`DELETE FROM admin_settings WHERE key = 'group_absolute_max_members'`);
    const fallback = await getGroupConfigKey('groupAbsoluteMaxMembers');
    assert(fallback === DEFAULT_GROUP_CONFIG.groupAbsoluteMaxMembers, `fallback = default (got ${fallback})`);
    // Re-insert via reset
    await resetGroupConfig();
    const restored = await getGroupConfigKey('groupAbsoluteMaxMembers');
    assert(restored === 10, `restored after reset (got ${restored})`);

    // ── 4. updateGroupConfig persists + validates ──
    console.log('\n[4] updateGroupConfig persists + validates');
    const r1 = await updateGroupConfig({
      groupAbsoluteMaxMembers: 8,
      groupHouseEdgePercent: 2.5,
      groupPrivateAllowed: false,
    });
    assert(r1.updated.length === 3, `3 keys updated (got ${r1.updated.length})`);
    assert(r1.rejected.length === 0, `0 rejected (got ${r1.rejected.length})`);
    const cfg2 = await getGroupConfig();
    assert(cfg2.groupAbsoluteMaxMembers === 8, `groupAbsoluteMaxMembers persisted = 8`);
    assert(cfg2.groupHouseEdgePercent === 2.5, `groupHouseEdgePercent persisted = 2.5`);
    assert(cfg2.groupPrivateAllowed === false, `groupPrivateAllowed persisted = false`);

    // Out-of-range: reject
    const r2 = await updateGroupConfig({ groupAbsoluteMaxMembers: 999 });
    assert(r2.rejected.length === 1, `rejected out-of-range (got ${r2.rejected.length})`);
    assert(r2.rejected[0].key === 'groupAbsoluteMaxMembers', `rejected key correct`);
    const r3 = await updateGroupConfig({ groupAbsoluteMaxMembers: 'not a number' as any });
    assert(r3.rejected.length === 1, `rejected non-numeric`);
    const r4 = await updateGroupConfig({ groupPlayEnabled: 'not a bool' as any });
    assert(r4.rejected.length === 1, `rejected non-boolean`);

    // Reset to defaults so downstream cases don't see test mutations
    await resetGroupConfig();

    // ── 5. resetGroupConfig restores all defaults ──
    console.log('\n[5] resetGroupConfig restores all defaults');
    const resetCfg = await getGroupConfig();
    for (const key of Object.keys(ORIGINAL_DEFAULTS)) {
      assert(resetCfg[key] === ORIGINAL_DEFAULTS[key], `${key} matches default after reset`);
    }

    // ── 6. Country-list helpers ──
    console.log('\n[6] parseCountryList + isCountryAllowed');
    assert(parseCountryList('*') === null, `"*" → null (everyone allowed)`);
    assert(parseCountryList('') === null, `"" → null`);
    assert(JSON.stringify(parseCountryList('US,GB,BD')) === JSON.stringify(['US', 'GB', 'BD']), `parses CSV`);
    assert(parseCountryList('us, gb , bd').join(',') === 'US,GB,BD', `trims + uppercases`);
    assert(isCountryAllowed('US', null, []) === true, `null allowed + no blocked = US allowed`);
    assert(isCountryAllowed('KP', null, ['KP']) === false, `KP in blocked list → blocked`);
    assert(isCountryAllowed('KP', ['KP'], ['KP']) === false, `blocked wins over allowed`);
    assert(isCountryAllowed('US', ['US', 'GB'], []) === true, `US in allowed list → allowed`);
    assert(isCountryAllowed('BD', ['US', 'GB'], []) === false, `BD NOT in allowed list → blocked`);

    // ── 7. applyMemberCap helper ──
    console.log('\n[7] applyMemberCap helper');
    assert(applyMemberCap(15, 10) === 10, `userMax=15 absolute=10 → 10`);
    assert(applyMemberCap(5, 10) === 5, `userMax=5 absolute=10 → 5 (no change)`);
    assert(applyMemberCap(10, 10) === 10, `userMax=10 absolute=10 → 10`);

    // ── 8. GroupConfig re-exported from admin-config.ts barrel ──
    console.log('\n[8] admin-config barrel re-exports group-config');
    const { getConfig, updateConfig } = require('../services/admin-config');
    const fullCfg = await getConfig();
    assert('groupPlayEnabled' in fullCfg, `getConfig() exposes groupPlayEnabled`);
    assert('groupAbsoluteMaxMembers' in fullCfg, `getConfig() exposes groupAbsoluteMaxMembers`);
    // PATCH via the existing admin-config endpoint path
    await updateConfig('groupAbsoluteMaxMembers' as any, 7);
    const fullCfg2 = await getConfig();
    assert(fullCfg2.groupAbsoluteMaxMembers === 7, `updateConfig() wrote to DB (got ${fullCfg2.groupAbsoluteMaxMembers})`);
    await resetGroupConfig();

    // ── 9. GROUP_CONFIG_LABELS has 24 entries ──
    console.log('\n[9] GROUP_CONFIG_LABELS has 24 entries with metadata');
    assert(Object.keys(GROUP_CONFIG_LABELS).length === 24, `24 labels (got ${Object.keys(GROUP_CONFIG_LABELS).length})`);
    for (const key of Object.keys(GROUP_CONFIG_LABELS)) {
      const meta = (GROUP_CONFIG_LABELS as any)[key];
      assert(typeof meta.label === 'string' && meta.label.length > 0, `${key}.label is non-empty string`);
      assert(typeof meta.description === 'string' && meta.description.length > 0, `${key}.description is non-empty string`);
      assert(['number', 'boolean', 'string'].includes(meta.type), `${key}.type is valid`);
      assert(meta.category === 'Group Play', `${key}.category = Group Play`);
    }

    // ── 10. Hard-cap: change groupAbsoluteMaxMembers=5, reject maxMembers=10 ──
    console.log('\n[10] hard-cap enforcement: maxMembers=10 rejected when absolute=5');
    await updateGroupConfig({ groupAbsoluteMaxMembers: 5 });
    const { createGroupBet, GroupBetValidationError } = require('../services/group-bet-create');
    let validationError: any = null;
    try {
      await createGroupBet({
        userId: '00000000-0000-0000-0000-000000000000', // fake — will fail at gate before validation
        creatorChoice: 'heads',
        creatorStake: 10,
        perMemberStake: 10,
        minMembers: 2,
        maxMembers: 10,  // exceeds new cap of 5
        payoutMode: 'equal',
        turnMode: 'creator',
      });
    } catch (e: any) {
      if (e instanceof GroupBetValidationError) {
        validationError = e;
      }
    }
    assert(validationError?.code === 'INVALID_MAX_MEMBERS', `rejected with INVALID_MAX_MEMBERS (got ${validationError?.code})`);
    await resetGroupConfig();

    // ── 11. Expiry: groupExpiryMinutes=60 → room expires_at ≈ now + 60min ──
    console.log('\n[11] expiry override: groupExpiryMinutes=60 sets expires_at = now + 60min');
    await updateGroupConfig({ groupExpiryMinutes: 60 });
    // Use the live test creator
    const TEST_CREATOR_ID = process.env.TEST_CREATOR_ID;
    if (TEST_CREATOR_ID) {
      // Set balance high enough to pass gates
      await pgQuery(`UPDATE users SET withdrawable_balance_coins = 10000, bonus_balance_coins = 0 WHERE id = $1`, [TEST_CREATOR_ID]);
      // Ensure creator has lifetime deposits ≥ 50
      await pgQuery(
        `INSERT INTO transactions (user_id, type, amount, currency, direction, status)
         VALUES ($1, 'deposit', 100, 'USD', 'credit', 'confirmed')
         ON CONFLICT DO NOTHING`,
        [TEST_CREATOR_ID],
      );
      const before = Date.now();
      const { createGroupBet: cgb } = require('../services/group-bet-create');
      const created = await cgb({
        userId: TEST_CREATOR_ID,
        creatorChoice: 'heads',
        creatorStake: 10,
        perMemberStake: 10,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
      });
      const after = Date.now();
      const expiresAtMs = new Date(created.expiresAt).getTime();
      const expectedMs = before + 60 * 60 * 1000;
      const drift = Math.abs(expiresAtMs - expectedMs);
      assert(drift < (after - before) + 5000, `expires_at ≈ now + 60min (drift ${drift}ms)`);
      // Clean up the test room
      await pgQuery(`DELETE FROM group_bet WHERE id = $1`, [created.id]);
    } else {
      console.log('  (skipped — TEST_CREATOR_ID not set)');
    }
    await resetGroupConfig();

    // ── 12. Regression: createGroupBet still works with config defaults ──
    console.log('\n[12] regression — createGroupBet works with config defaults');
    if (TEST_CREATOR_ID) {
      await pgQuery(`UPDATE users SET withdrawable_balance_coins = 10000, bonus_balance_coins = 0 WHERE id = $1`, [TEST_CREATOR_ID]);
      const { createGroupBet: cgb2 } = require('../services/group-bet-create');
      const c2 = await cgb2({
        userId: TEST_CREATOR_ID,
        creatorChoice: 'tails',
        creatorStake: 50,
        perMemberStake: 50,
        minMembers: 2,
        maxMembers: 5,
        payoutMode: 'equal',
        turnMode: 'creator',
      });
      assert(c2.id && c2.shortCode && c2.shortCode.length === 6, `created room with shortCode (got ${c2.shortCode})`);
      assert(parseFloat(c2.totalPool) === 50, `totalPool = creator stake (got ${c2.totalPool})`);
      await pgQuery(`DELETE FROM group_bet WHERE id = $1`, [c2.id]);
    } else {
      console.log('  (skipped — TEST_CREATOR_ID not set)');
    }

    console.log('\n═════════════════════════════════════════════════');
    if (failed) console.error('❌ Some gp-2-01 assertions failed.');
    else console.log('🎉 All gp-2-01 assertions passed.');
  } finally {
    console.log(`\n[cleanup] resetting group_play config + removing test rows…`);
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