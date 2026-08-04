/**
 * ════════════════════════════════════════════════════════════════
 *  ADMIN GROUP CONFIG — Phase 2 / Day 8
 *  ════════════════════════════════════════════════════════════════
 *
 *  Domain slice for the 24 group_play admin-config thresholds from
 *  the Phase 2 §2.1 spec.
 *
 *  Mirrors the P1-11 split pattern (admin-game-config.ts,
 *  admin-bonus-config.ts, admin-fraud-config.ts,
 *  admin-payments-config.ts). The barrel file `admin-config.ts`
 *  composes `DEFAULT_CONFIG` + `CONFIG_LABELS` by merging the per-
 *  domain default slices — order: GAME → BONUS → PAYMENTS → GROUP,
 *  with later slices winning (none overlap in practice).
 *
 *  Storage: 24 rows in `admin_settings` (one per setting) with
 *  category='group_play' implied by the `group_*` key prefix. The
 *  service reads via `getRawSetting()` and writes via `setRawSetting()`
 *  from admin-fraud-config.ts (both are imported below).
 *
 *  Pattern: domain services read these values at call-time so an
 *  admin's change is visible immediately (no restart required).
 *  Where a value needs caching (e.g. inside a hot loop), the caller
 *  should `await getGroupConfig()` ONCE and reuse the object.
 * ════════════════════════════════════════════════════════════════
 */

import { getRawSetting, setRawSetting } from './admin-fraud-config';

// ─── Public type contract ───────────────────────────────────────
export interface GroupConfig {
  // ── Master toggles ──
  /** Master toggle — kills all groups if off */
  groupPlayEnabled: boolean;
  /** ISO country codes (CSV); "*" = everyone */
  groupPlayAllowedCountries: string;
  /** ISO country codes (CSV) hard-blocked (regulatory) */
  groupPlayBlockedCountries: string;

  // ── Member caps ──
  /** Default min players when group is created */
  groupDefaultMinMembers: number;
  /** Default max players */
  groupDefaultMaxMembers: number;
  /** Hard cap (overrides user choice) */
  groupAbsoluteMaxMembers: number;

  // ── Eligibility gate (Gap 6) ──
  /** Minimum lifetime confirmed deposits (USD) a user must have before
   *  they can create OR join a group. Anti-bot: keeps brand-new
   *  accounts with $0 deposit history from polluting the pool. */
  groupMinUserDepositHistory: number;

  // ── Stake caps ──
  /** Default min stake per member */
  groupDefaultContributionMin: number;
  /** Default max stake per member */
  groupDefaultContributionMax: number;
  /** Hard cap on total pool */
  groupAbsolutePoolCap: number;

  // ── Timing ──
  /** Default time-to-live before WAITING → EXPIRED */
  groupExpiryMinutes: number;
  /** For auto_on_full turn mode */
  groupAutoFlipCountdownSeconds: number;

  // ── Distribution & turn defaults ──
  /** equal | proportional | founder_boost */
  groupDefaultPayoutDistribution: 'equal' | 'proportional' | 'founder_boost';
  /** creator | auto_on_full | random_lottery */
  groupDefaultTurnDecision: 'creator' | 'auto_on_full' | 'random_lottery';
  /** For founder_boost mode (0-30) */
  groupDefaultFounderSharePct: number;

  // ── House edge ──
  /** House edge on group wins (decoupled from solo) */
  groupHouseEdgePercent: number;
  /** Sometimes you want a tiny edge on losses too */
  groupLossHouseEdgePercent: number;
  /** Minimum extra house edge for groups (vs solo) to prevent arb */
  groupMinHouseEdgeSpreadVsSolo: number;

  // ── Invites & bonuses ──
  /** Percentage of stake that counts toward bonus wagering clearance
   *  on group resolve. 50 = half-credit vs solo (groups clear bonus
   *  slower because the variance is shared). Range 0-100. */
  groupBonusWagerWeight: number;
  /** Coins credited to inviter when invitee joins via token */
  groupInviterBonusCoins: number;
  /** Coins credited to invitee when they join via token */
  groupInviteeBonusCoins: number;
  /** Anti-fraud cap on inviter bonuses */
  groupInviterBonusCapPerUserPerDay: number;
  /** How many times a single invite token can be redeemed */
  groupInviteMaxRedemptionsDefault: number;
  /** Default invite token TTL (7 days default) */
  groupInviteExpiryHoursDefault: number;

  // ── Feature flags ──
  /** Toggle spectator view of in-progress groups */
  groupSpectatorModeEnabled: boolean;
  /** Allow is_private=true groups */
  groupPrivateAllowed: boolean;
}

// ─── Defaults (must match migration-group-play-config.sql) ────
export const DEFAULT_GROUP_CONFIG: GroupConfig = {
  groupPlayEnabled: false,
  groupPlayAllowedCountries: '*',
  groupPlayBlockedCountries: 'KP,IR,SY,CU',

  groupDefaultMinMembers: 2,
  groupDefaultMaxMembers: 5,
  groupAbsoluteMaxMembers: 10,

  groupMinUserDepositHistory: 50, // gap6: $50 lifetime deposits

  groupDefaultContributionMin: 0.10,
  groupDefaultContributionMax: 10000,
  groupAbsolutePoolCap: 50000,

  groupExpiryMinutes: 30,
  groupAutoFlipCountdownSeconds: 5,

  groupDefaultPayoutDistribution: 'proportional',
  groupDefaultTurnDecision: 'creator',
  groupDefaultFounderSharePct: 10,

  groupHouseEdgePercent: 1.0,
  groupLossHouseEdgePercent: 0,
  groupMinHouseEdgeSpreadVsSolo: 0.5,

  groupBonusWagerWeight: 50, // gap4: groups clear bonus at 50% of stake
  groupInviterBonusCoins: 0,
  groupInviteeBonusCoins: 0,
  groupInviterBonusCapPerUserPerDay: 50,
  groupInviteMaxRedemptionsDefault: 1,
  groupInviteExpiryHoursDefault: 168,

  groupSpectatorModeEnabled: true,
  groupPrivateAllowed: true,
};

// ─── Labels (mirror `CONFIG_LABELS` shape from admin-game-config) ─
export interface ConfigLabelMeta {
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}

export const GROUP_CONFIG_LABELS: Record<keyof GroupConfig, ConfigLabelMeta> = {
  groupPlayEnabled: {
    label: 'Group Play Master Toggle',
    description: 'Master switch. When false, no groups can be created or joined.',
    type: 'boolean',
    category: 'Group Play',
  },
  groupPlayAllowedCountries: {
    label: 'Allowed Countries',
    description: 'CSV of ISO country codes that may play groups. "*" = everyone (subject to blocked list).',
    type: 'string',
    category: 'Group Play',
  },
  groupPlayBlockedCountries: {
    label: 'Blocked Countries',
    description: 'Hard-blocked CSV (e.g. KP,IR,SY,CU). Wins over allowed list.',
    type: 'string',
    category: 'Group Play',
  },
  groupDefaultMinMembers: {
    label: 'Default Min Members',
    description: 'Default minimum members when creator does not specify.',
    unit: 'members', min: 2, max: 10, type: 'number',
    category: 'Group Play',
  },
  groupDefaultMaxMembers: {
    label: 'Default Max Members',
    description: 'Default maximum members when creator does not specify.',
    unit: 'members', min: 2, max: 10, type: 'number',
    category: 'Group Play',
  },
  groupAbsoluteMaxMembers: {
    label: 'Absolute Max Members (hard cap)',
    description: 'Hard cap overriding any per-group choice.',
    unit: 'members', min: 2, max: 10, type: 'number',
    category: 'Group Play',
  },
  groupMinUserDepositHistory: {
    label: 'Min Lifetime Deposit to Create Group',
    description: 'Minimum lifetime confirmed deposits (USD) a user must have to create or join a group. Anti-bot gate — set to 0 to disable. Default 50 USD.',
    unit: '$', min: 0, max: 1000, type: 'number',
    category: 'Group Play',
  },
  groupDefaultContributionMin: {
    label: 'Default Min Stake',
    description: 'Default minimum contribution per member.',
    unit: 'USD', min: 0.01, max: 1000, type: 'number',
    category: 'Group Play',
  },
  groupDefaultContributionMax: {
    label: 'Default Max Stake',
    description: 'Default maximum contribution per member.',
    unit: 'USD', min: 1, max: 50000, type: 'number',
    category: 'Group Play',
  },
  groupAbsolutePoolCap: {
    label: 'Absolute Pool Cap (hard cap)',
    description: 'Hard cap on total pool — overrides per-group choice.',
    unit: 'USD', min: 100, max: 1000000, type: 'number',
    category: 'Group Play',
  },
  groupExpiryMinutes: {
    label: 'Group Expiry (minutes)',
    description: 'Time-to-live before WAITING → EXPIRED. Sweep cron handles the transition.',
    unit: 'minutes', min: 5, max: 1440, type: 'number',
    category: 'Group Play',
  },
  groupAutoFlipCountdownSeconds: {
    label: 'Auto-Flip Countdown',
    description: 'For auto_on_full turn mode, the countdown after min_members is reached.',
    unit: 'seconds', min: 3, max: 30, type: 'number',
    category: 'Group Play',
  },
  groupDefaultPayoutDistribution: {
    label: 'Default Payout Distribution',
    description: 'equal | proportional | founder_boost. Creator can override per-group.',
    type: 'string',
    category: 'Group Play',
  },
  groupDefaultTurnDecision: {
    label: 'Default Turn Decision',
    description: 'creator | auto_on_full | random_lottery.',
    type: 'string',
    category: 'Group Play',
  },
  groupDefaultFounderSharePct: {
    label: 'Default Founder Boost %',
    description: 'For founder_boost mode only. Range 0-30.',
    unit: '%', min: 0, max: 30, type: 'number',
    category: 'Group Play',
  },
  groupHouseEdgePercent: {
    label: 'Group House Edge (wins)',
    description: 'House edge on group wins. Decoupled from solo so group can be promoted.',
    unit: '%', min: 0.1, max: 5, type: 'number',
    category: 'Group Play',
  },
  groupLossHouseEdgePercent: {
    label: 'Group Loss House Edge',
    description: 'Sometimes you want a tiny edge on losses (e.g. plinko).',
    unit: '%', min: 0, max: 1, type: 'number',
    category: 'Group Play',
  },
  groupMinHouseEdgeSpreadVsSolo: {
    label: 'Min House Edge Spread vs Solo',
    description: 'Minimum extra house edge for groups vs solo. Prevents arb.',
    unit: '%', min: 0, max: 2, type: 'number',
    category: 'Group Play',
  },
  groupBonusWagerWeight: {
    label: 'Group Bonus Wager Weight',
    description: 'Percentage of stake that counts toward bonus wagering clearance on group resolve. 50 = half-credit (groups clear bonus slower because the variance is shared). 0 = no credit.',
    unit: '%', min: 0, max: 100, type: 'number',
    category: 'Group Play',
  },
  groupInviterBonusCoins: {
    label: 'Inviter Bonus Coins',
    description: 'Coins credited to inviter when invitee joins via token. 0 = no bonus.',
    unit: 'coins', min: 0, max: 100, type: 'number',
    category: 'Group Play',
  },
  groupInviteeBonusCoins: {
    label: 'Invitee Bonus Coins',
    description: 'Coins credited to invitee when they join via token. 0 = no bonus.',
    unit: 'coins', min: 0, max: 100, type: 'number',
    category: 'Group Play',
  },
  groupInviterBonusCapPerUserPerDay: {
    label: 'Inviter Bonus Daily Cap',
    description: 'Anti-fraud cap on inviter bonuses per user per day.',
    unit: 'coins', min: 0, max: 500, type: 'number',
    category: 'Group Play',
  },
  groupInviteMaxRedemptionsDefault: {
    label: 'Invite Max Redemptions Default',
    description: 'How many times a single invite token can be redeemed.',
    unit: 'uses', min: 1, max: 100, type: 'number',
    category: 'Group Play',
  },
  groupInviteExpiryHoursDefault: {
    label: 'Invite Expiry Hours Default',
    description: 'Default invite token TTL.',
    unit: 'hours', min: 1, max: 720, type: 'number',
    category: 'Group Play',
  },
  groupSpectatorModeEnabled: {
    label: 'Spectator Mode Enabled',
    description: 'Allow non-members to spectate in-progress groups via group:spectate.',
    type: 'boolean',
    category: 'Group Play',
  },
  groupPrivateAllowed: {
    label: 'Private Groups Allowed',
    description: 'When false, is_private=true groups are rejected at create time.',
    type: 'boolean',
    category: 'Group Play',
  },
};

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Read the full GroupConfig from `admin_settings`. Falls back to
 * DEFAULT_GROUP_CONFIG for missing keys (so a half-applied migration
 * doesn't crash the caller).
 *
 * The DB stores keys in snake_case (per the migration +
 * `updateConfig` convention from admin-config.ts), while
 * DEFAULT_GROUP_CONFIG uses camelCase. We convert at read-time via
 * `camelToSnake()` so the in-memory shape stays camelCase.
 */
export async function getGroupConfig(): Promise<GroupConfig> {
  const config: GroupConfig = { ...DEFAULT_GROUP_CONFIG };
  for (const camelKey of Object.keys(DEFAULT_GROUP_CONFIG) as Array<keyof GroupConfig>) {
    const dbKey = camelToSnake(camelKey);
    const raw = await getRawSetting(dbKey);
    if (raw === null) continue;
    const meta = GROUP_CONFIG_LABELS[camelKey];
    if (meta.type === 'boolean') {
      (config as any)[camelKey] = raw === 'true';
    } else if (meta.type === 'number') {
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) (config as any)[camelKey] = n;
    } else {
      (config as any)[camelKey] = raw;
    }
  }
  return config;
}

/**
 * Read a single key from the group_play config. Returns the default
 * if the key is missing. Convenience helper for hot paths.
 */
export async function getGroupConfigKey<K extends keyof GroupConfig>(
  key: K,
): Promise<GroupConfig[K]> {
  const dbKey = camelToSnake(key);
  const raw = await getRawSetting(dbKey);
  if (raw === null) return DEFAULT_GROUP_CONFIG[key];
  const meta = GROUP_CONFIG_LABELS[key];
  if (meta.type === 'boolean') {
    return (raw === 'true') as any;
  }
  if (meta.type === 'number') {
    const n = parseFloat(raw);
    return (Number.isNaN(n) ? DEFAULT_GROUP_CONFIG[key] : n) as any;
  }
  return raw as any;
}

/**
 * Update one or more keys. Validates range for numeric keys against
 * GROUP_CONFIG_LABELS.min/max. Throws on invalid values (caller should
 * catch and surface to the admin UI).
 */
export async function updateGroupConfig(
  updates: Partial<GroupConfig>,
): Promise<{ updated: string[]; rejected: Array<{ key: string; reason: string }> }> {
  const updated: string[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];

  for (const [camelKey, v] of Object.entries(updates)) {
    if (!(camelKey in DEFAULT_GROUP_CONFIG)) {
      rejected.push({ key: camelKey, reason: 'unknown key' });
      continue;
    }
    const meta = GROUP_CONFIG_LABELS[camelKey as keyof GroupConfig];
    if (meta.type === 'number' && typeof v === 'number') {
      if (meta.min !== undefined && v < meta.min) {
        rejected.push({ key: camelKey, reason: `below min ${meta.min}` });
        continue;
      }
      if (meta.max !== undefined && v > meta.max) {
        rejected.push({ key: camelKey, reason: `above max ${meta.max}` });
        continue;
      }
    } else if (meta.type === 'number' && typeof v !== 'number') {
      rejected.push({ key: camelKey, reason: 'must be number' });
      continue;
    }
    if (meta.type === 'boolean' && typeof v !== 'boolean') {
      rejected.push({ key: camelKey, reason: 'must be boolean' });
      continue;
    }
    // Write to DB using snake_case key (the storage convention)
    await setRawSetting(camelToSnake(camelKey), String(v));
    updated.push(camelKey);
  }
  return { updated, rejected };
}

/**
 * Reset all 24 keys to DEFAULT_GROUP_CONFIG. Used by the "Reset to
 * defaults" admin button.
 */
export async function resetGroupConfig(): Promise<void> {
  for (const [camelKey, v] of Object.entries(DEFAULT_GROUP_CONFIG)) {
    await setRawSetting(camelToSnake(camelKey), String(v));
  }
}

// ─── Internal helpers ───────────────────────────────────────────

/**
 * Convert camelCase → snake_case for the admin_settings key lookup.
 * The migration stores snake_case; the in-memory shape is camelCase.
 *
 * Example:
 *   groupAbsoluteMaxMembers → group_absolute_max_members
 *   groupPlayEnabled        → group_play_enabled
 */
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m, idx) => (idx === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`));
}

/**
 * Hard-cap helper: returns `min(userMax, absoluteMax)`. Used by
 * `group-bet-create.ts` so an admin can shrink the cap without
 * restarting the backend.
 */
export function applyMemberCap(userMax: number, absoluteMax: number): number {
  return Math.min(userMax, absoluteMax);
}

/**
 * Parse a CSV country list into an array of trimmed ISO codes.
 * Special-cases "*" (returns null = "everyone allowed").
 */
export function parseCountryList(csv: string): string[] | null {
  if (!csv || csv.trim() === '*') return null;
  return csv.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
}

/**
 * Check if a country is allowed by the allowed/blocked lists.
 * `allowedCountries = null` means "everyone allowed".
 * Blocked wins over allowed.
 */
export function isCountryAllowed(country: string, allowedCountries: string | null, blockedCountries: string[]): boolean {
  const c = (country || '').toUpperCase();
  if (blockedCountries.includes(c)) return false;
  if (allowedCountries === null) return true;
  return allowedCountries.includes(c);
}