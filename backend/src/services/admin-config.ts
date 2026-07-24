/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN CONFIG — barrel re-exporter for the 4 domain modules
 *  (P1-11 refactor).
 *
 *  Before P1-11 this file was a 547-line monolith. It has been
 *  split into 4 domain modules for maintainability:
 *
 *    - admin-game-config.ts    — game core, betting limits, jackpot,
 *                                payout math, `getPayoutMultiplier`,
 *                                `validateBetAmount`
 *    - admin-bonus-config.ts   — bonus, scatter, streak, lightning,
 *                                daily wheel, leaderboard, rakeback,
 *                                challenges
 *    - admin-fraud-config.ts   — generic KYC/risk threshold
 *                                persistence (`getRawSetting`,
 *                                `setRawSetting`)
 *    - admin-payments-config.ts — withdrawal limits
 *
 *  This barrel file:
 *    1. Re-exports the `GameConfig` interface and the per-domain
 *       helpers from each module.
 *    2. Composes `DEFAULT_CONFIG` by merging the per-domain default
 *       slices — order: GAME → BONUS → PAYMENTS, with later slices
 *       winning (none overlap in practice).
 *    3. Composes `CONFIG_LABELS` by merging the per-domain label
 *       slices.
 *    4. Hosts the DB I/O functions: `getConfig`, `updateConfig`,
 *       `updateAllConfig`, `resetToDefaults`.
 *
 *  Backward compatibility: every public symbol that the original
 *  monolith exported is still exported from this file with the
 *  same name. The 17 importers (1 wildcard + 16 named) continue to
 *  work without changes.
 *
 *  See `BACKEND_PROD_READINESS.md` [P1-11] for the full audit
 *  history and the per-module line-count breakdown.
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';

import {
  GameConfig,
  GAME_CONFIG_LABELS,
  GAME_DEFAULT_CONFIG,
  getPayoutMultiplier,
  validateBetAmount,
} from './admin-game-config';

import {
  BONUS_CONFIG_LABELS,
  BONUS_DEFAULT_CONFIG,
} from './admin-bonus-config';

import {
  getRawSetting,
  setRawSetting,
} from './admin-fraud-config';

import {
  PAYMENTS_CONFIG_LABELS,
  PAYMENTS_DEFAULT_CONFIG,
} from './admin-payments-config';

// Re-export all per-domain symbols so that `import { getConfig } from
// '../services/admin-config'` continues to resolve exactly as it did
// before the refactor. The wildcard import in `test/leaderboards.test.ts`
// relies on this — `(adminConfigModule as any).getConfig = async () => …`
// must still work.
export {
  GameConfig,
  getPayoutMultiplier,
  validateBetAmount,
  getRawSetting,
  setRawSetting,
};

// ── Composed `DEFAULT_CONFIG` ──────────────────────────────────
/**
 * Single source of truth for the default admin configuration.
 * Composed by merging GAME + BONUS + PAYMENTS default slices. Each
 * slice is `Partial<GameConfig>` so TypeScript enforces that no key
 * is misspelled; the runtime merge produces a fully-typed
 * `GameConfig` object.
 *
 * The spread order matters only for the rare case of an overlapping
 * key (none today). We put GAME first because it's the largest
 * slice; later spreads win.
 */
export const DEFAULT_CONFIG: GameConfig = {
  ...(GAME_DEFAULT_CONFIG as GameConfig),
  ...(BONUS_DEFAULT_CONFIG as GameConfig),
  ...(PAYMENTS_DEFAULT_CONFIG as GameConfig),
} as GameConfig;

// ── Composed `CONFIG_LABELS` ───────────────────────────────────
/**
 * UI label / description / type metadata for every `GameConfig` key.
 * Composed by merging the per-domain label slices. Keys are unique
 * across slices; the merge is safe.
 */
export const CONFIG_LABELS: Record<keyof GameConfig, {
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}> = {
  ...(GAME_CONFIG_LABELS as Record<keyof GameConfig, {
    label: string;
    description: string;
    unit?: string;
    min?: number;
    max?: number;
    type: 'number' | 'boolean' | 'string';
    category: string;
  }>),
  ...(BONUS_CONFIG_LABELS as Record<keyof GameConfig, {
    label: string;
    description: string;
    unit?: string;
    min?: number;
    max?: number;
    type: 'number' | 'boolean' | 'string';
    category: string;
  }>),
  ...(PAYMENTS_CONFIG_LABELS as Record<keyof GameConfig, {
    label: string;
    description: string;
    unit?: string;
    min?: number;
    max?: number;
    type: 'number' | 'boolean' | 'string';
    category: string;
  }>),
} as Record<keyof GameConfig, {
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}>;

// ── DB I/O for the typed GameConfig ───────────────────────────

/** ডাটাবেস থেকে সব সেটিং পড়ো */
export async function getConfig(): Promise<GameConfig> {
  try {
    const result = await query('SELECT key, value FROM admin_settings');

    // ডিফল্ট কনফিগ দিয়ে শুরু করো
    const config: GameConfig = { ...DEFAULT_CONFIG };

    // snake_case থেকে camelCase এ রূপান্তর করার জন্য
    const snakeToCamel = (str: string) =>
      str.replace(/([-_][a-z])/g, group =>
        group.toUpperCase().replace('-', '').replace('_', '')
      );

    // ডাটাবেস থেকে পড়া মান দিয়ে আপডেট করো
    for (const row of result.rows) {
      const dbKey = row.key;
      const camelKey = snakeToCamel(dbKey) as keyof GameConfig;
      if (camelKey in config) {
        const meta = CONFIG_LABELS[camelKey];
        if (meta.type === 'boolean') {
          (config as any)[camelKey] = row.value === 'true';
        } else if (meta.type === 'number') {
          (config as any)[camelKey] = parseFloat(row.value);
        } else if (camelKey === 'dailyWheelPrizes') {
          try {
            (config as any)[camelKey] = JSON.parse(row.value);
          } catch {
            (config as any)[camelKey] = DEFAULT_CONFIG.dailyWheelPrizes;
          }
        } else if (camelKey === 'leaderboardPrizes') {
          try {
            (config as any)[camelKey] = JSON.parse(row.value);
          } catch {
            (config as any)[camelKey] = DEFAULT_CONFIG.leaderboardPrizes;
          }
        } else if (camelKey === 'dailyChallenges') {
          try {
            (config as any)[camelKey] = JSON.parse(row.value);
          } catch {
            (config as any)[camelKey] = DEFAULT_CONFIG.dailyChallenges;
          }
        } else {
          (config as any)[camelKey] = row.value;
        }
      }
    }

    return config;
  } catch {
    // ডাটাবেস কানেক্ট না হলে ডিফল্ট ব্যবহার করো
    console.warn('⚠️ ডাটাবেস থেকে কনফিগ পড়া যায়নি। ডিফল্ট সেটিং ব্যবহার হচ্ছে।');
    return { ...DEFAULT_CONFIG };
  }
}

/** একটি সেটিং আপডেট করো */
export async function updateConfig(key: keyof GameConfig, value: unknown): Promise<void> {
  const stringValue = String(value);
  await query(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, stringValue],
  );
}

/** সব সেটিং একসাথে আপডেট করো */
export async function updateAllConfig(config: Partial<GameConfig>): Promise<void> {
  for (const [key, value] of Object.entries(config)) {
    await updateConfig(key as keyof GameConfig, value);
  }
}

/** সব সেটিং ডিফল্টে ফিরিয়ে দাও */
export async function resetToDefaults(): Promise<void> {
  await updateAllConfig(DEFAULT_CONFIG);
}
