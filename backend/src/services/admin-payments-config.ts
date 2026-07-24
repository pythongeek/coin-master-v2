/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN PAYMENTS CONFIG — deposit/withdrawal limits and payment
 *  provider tier knobs.
 *
 *  Part of the P1-11 refactor.
 *
 *  The original `GameConfig` interface had 4 withdrawal-related
 *  fields (withdrawalMinCoins, withdrawalMaxCoins,
 *  withdrawalAutoApproveThreshold, dailyWithdrawalLimitCoins) that
 *  semantically belong to "payments", not "game core" or "bonus".
 *  This module owns the typed config slice and the UI labels for
 *  those fields. Deposit-side limits are currently derived from
 *  KYC tier overrides (see `services/kyc-enforcement.service.ts`)
 *  and live in `admin_settings` via `getRawSetting`/`setRawSetting`,
 *  so the typed slice here is withdrawal-only — the schema is
 *  intentionally narrow.
 * ═══════════════════════════════════════════════════════════════
 */

import type { GameConfig } from './admin-game-config';

/**
 * UI label / description / type metadata for the payments-config
 * slice. Merged in the barrel `admin-config.ts` into the full
 * `CONFIG_LABELS`.
 */
export const PAYMENTS_CONFIG_LABELS: Partial<Record<keyof GameConfig, {
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}>> = {
  // তহবিল / উত্তোলন
  withdrawalMinCoins:              { label: 'ন্যূনতম উত্তোলন', description: 'একক উত্তোলনের ন্যূনতম পরিমাণ (কয়েন)।', unit: 'coin', min: 0.1, max: 10000, type: 'number', category: 'তহবিল / উত্তোলন' },
  withdrawalMaxCoins:              { label: 'সর্বোচ্চ উত্তোলন', description: 'একক উত্তোলনের সর্বোচ্চ পরিমাণ (কয়েন)।', unit: 'coin', min: 1, max: 1000000, type: 'number', category: 'তহবিল / উত্তোলন' },
  withdrawalAutoApproveThreshold:  { label: 'Auto-approve threshold', description: 'এই পরিমাণের কম হলে অটো-অনুমোদন (0 = সবসময় ম্যানুয়াল)।', unit: 'কয়েন', min: 0, max: 10000, type: 'number', category: 'উইথড্র' },
  dailyWithdrawalLimitCoins:       { label: 'Daily withdrawal limit', description: 'প্রতিদিন প্রতি ইউজার সর্বোচ্চ উইথড্র।', unit: 'কয়েন', min: 0, max: 1000000, type: 'number', category: 'উইথড্র' },
};

/**
 * Default values for the payments-config slice. Merged in the
 * barrel `admin-config.ts` to produce the full `DEFAULT_CONFIG`.
 */
export const PAYMENTS_DEFAULT_CONFIG: Partial<GameConfig> = {
  withdrawalMinCoins: 1.0,
  withdrawalMaxCoins: 10000.0,
  withdrawalAutoApproveThreshold: 0.0,
  dailyWithdrawalLimitCoins: 5000.0,
};
