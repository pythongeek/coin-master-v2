/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN CONFIG SERVICE — এডমিনের সম্পূর্ণ কন্ট্রোল প্যানেল
 * ═══════════════════════════════════════════════════════════════
 *
 *  এখানে গেমের সব গুরুত্বপূর্ণ সেটিং এডমিন লাইভ পরিবর্তন করতে পারবে।
 *  পরিবর্তন হলে সাথে সাথে সব নতুন গেমে প্রভাব পড়বে।
 *
 *  ডিফল্ট সেটিং:
 *  ──────────────────────────────────────────────────────────────
 *  হাউজ এজ: ২% (শিল্পের স্ট্যান্ডার্ড, ইউজারবান্ধব)
 *  মিন বেট: $০.০১ (যেকেউ খেলতে পারে)
 *  ম্যাক্স বেট: $১০০০ (রিস্ক কন্ট্রোল)
 *  ক্রিপ্টো রেইন ট্রিগার: ৫ জয়ের ধারাবাহিকতায়
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';

// ── সব সেটিংয়ের ধরন নির্ধারণ ─────────────────────────────────
export interface GameConfig {
  // ── হাউজ এজ সেটিং ──────────────────────────────────────────
  /** হাউজ এজ পার্সেন্ট (০.০১% - ৫০%)
   *  উদাহরণ: ২ = ২% → ইউজার ১০০ বেট করলে জিতলে ১৯৬ পাবে (লাভ ৯৬) */
  houseEdgePercent: number;
  /** সর্বোচ্চ জয়ের সীমা প্রতি বেট */
  maxWinAmount: number;

  // ── বেট লিমিট সেটিং ─────────────────────────────────────────
  /** সর্বনিম্ন বেট পরিমাণ */
  minBetAmount: number;
  /** সর্বোচ্চ বেট পরিমাণ (রিস্ক কন্ট্রোলের জন্য) */
  maxBetAmount: number;
  /** একজন ইউজার একসাথে কতটি বেট রাখতে পারবে */
  maxConcurrentBets: number;

  // ── ক্রিপ্টো রেইন সেটিং ──────────────────────────────────────
  /** কতটি টানা জয়ের পর রেইন ট্রিগার হবে */
  rainTriggerStreak: number;
  /** প্রতিদিন সর্বোচ্চ কত ডলার রেইন হিসেবে বিতরণ হবে */
  rainBudgetDailyUsd: number;
  /** একজন ইউজার রেইন থেকে সর্বোচ্চ কত ডলার ক্লেইম করতে পারবে */
  rainClaimPerUserUsd: number;
  /** রেইন ইভেন্ট কত সেকেন্ড স্থায়ী হবে */
  rainDurationSeconds: number;
  /** রেইন একটিভ আছে কিনা (এডমিন বন্ধ করতে পারবে) */
  rainEnabled: boolean;

  // ── স্কোয়াড ফ্লিপ সেটিং ──────────────────────────────────────
  /** স্কোয়াডে সর্বোচ্চ কতজন সদস্য */
  maxSquadSize: number;
  /** স্কোয়াড ফিচার একটিভ আছে কিনা */
  squadEnabled: boolean;
  /** স্কোয়াড বেটের জন্য আলাদা হাউজ এজ (%) */
  squadHouseEdgePercent: number;

  // ── গেম স্পিড সেটিং ─────────────────────────────────────────
  /** কয়েন স্পিন অ্যানিমেশনের সময় (মিলিসেকেন্ড) */
  coinSpinDurationMs: number;
  /** দুটি গেমের মধ্যে বিরতি (মিলিসেকেন্ড) */
  cooldownBetweenGamesMs: number;

  // ── সিড রোটেশন সেটিং ──────────────────────────────────────────
  /** কত গেমের পর সার্ভার সিড স্বয়ংক্রিয়ভাবে পরিবর্তন হবে */
  seedRotationAfterGames: number;

  maintenanceMode: boolean;
  /** বন্ধ থাকলে ইউজারদের কী বার্তা দেখাবে */
  maintenanceMessage: string;

  // ── প্রোগ্রেসিভ জ্যাকপট সেটিং ──────────────────────────────
  /** প্রোগ্রেসিভ জ্যাকপট চালু আছে কিনা */
  jackpotEnabled: boolean;
  /** জ্যাকপটের জন্য সর্বনিম্ন বেট পরিমাণ */
  jackpotMinBet: number;
  /** বেটের শতকরা কত অংশ জ্যাকপট পুলে যোগ হবে */
  jackpotContributionPercent: number;
  /** জ্যাকপট জয়ের সম্ভাবনা (১/X) */
  jackpotHitChance: number;
  /** জ্যাকপট শুরুর পুলের পরিমাণ */
  jackpotStartPool: number;
  /** জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থ */
  jackpotPool: number;
}

// ═══════════════════════════════════════════════════════════════
//  DEFAULT CONFIG — কারখানা থেকে বের হওয়া ডিফল্ট সেটিং
//  এডমিন না বদলালে এই মানগুলোই ব্যবহার হবে
// ═══════════════════════════════════════════════════════════════
export const DEFAULT_CONFIG: GameConfig = {
  // হাউজ এজ: ২% — শিল্পের সাথে প্রতিযোগিতামূলক
  houseEdgePercent: 2.0,

  // বেট লিমিট
  minBetAmount: 0.01,
  maxBetAmount: 1000.0,
  maxWinAmount: 50000.0,
  maxConcurrentBets: 1,

  // ক্রিপ্টো রেইন
  rainTriggerStreak: 5,
  rainBudgetDailyUsd: 50.0,
  rainClaimPerUserUsd: 0.10,
  rainDurationSeconds: 60,
  rainEnabled: true,

  // স্কোয়াড ফ্লিপ
  maxSquadSize: 5,
  squadEnabled: true,
  squadHouseEdgePercent: 1.0,  // স্কোয়াডে কম ফি — ইউজার আকর্ষণের জন্য

  // গেম স্পিড
  coinSpinDurationMs: 3000,     // ৩ সেকেন্ড স্পিন — টেনশন বিল্ড-আপ
  cooldownBetweenGamesMs: 1500, // ১.৫ সেকেন্ড বিরতি

  // সিড রোটেশন
  seedRotationAfterGames: 100,  // ১০০ গেমের পর নতুন সিড

  // মেইনটেন্যান্স
  maintenanceMode: false,
  maintenanceMessage: 'সাইটটি আপগ্রেডের জন্য সাময়িকভাবে বন্ধ আছে। শীঘ্রই আসছে!',

  // প্রোগ্রেসিভ জ্যাকপট
  jackpotEnabled: true,
  jackpotMinBet: 1.0,
  jackpotContributionPercent: 1.0,
  jackpotHitChance: 10000,
  jackpotStartPool: 10.0,
  jackpotPool: 10.0,
};

// ── কনফিগ কী → বাংলা লেবেল ম্যাপিং (UI-র জন্য) ───────────────
export const CONFIG_LABELS: Record<keyof GameConfig, { label: string; description: string; unit?: string; min?: number; max?: number; type: 'number' | 'boolean' | 'string'; category: string }> = {
  houseEdgePercent:       { label: 'হাউজ এজ', description: 'প্ল্যাটফর্মের লাভের পার্সেন্ট। ২% মানে ইউজার ১০০ বেটে জিতলে ১৯৬ পাবে।', unit: '%', min: 0.1, max: 10, type: 'number', category: 'বেটিং' },
  minBetAmount:           { label: 'সর্বনিম্ন বেট', description: 'একটি বেটে সর্বনিম্ন পরিমাণ।', unit: '$', min: 0.01, max: 10, type: 'number', category: 'বেটিং' },
  maxBetAmount:           { label: 'সর্বোচ্চ বেট', description: 'একটি বেটে সর্বোচ্চ পরিমাণ। রিস্ক কন্ট্রোলের জন্য গুরুত্বপূর্ণ।', unit: '$', min: 10, max: 100000, type: 'number', category: 'বেটিং' },
  maxWinAmount:           { label: 'সর্বোচ্চ জয়ের সীমা', description: 'প্রতি বেটে সর্বোচ্চ জয়ের লিমিট। এর বেশি লাভ করতে পারবে না।', unit: '$', min: 100, max: 1000000, type: 'number', category: 'বেটিং' },
  maxConcurrentBets:      { label: 'একসাথে বেট সংখ্যা', description: 'একজন ইউজার একসাথে কতটি বেট রাখতে পারবে।', unit: 'টি', min: 1, max: 5, type: 'number', category: 'বেটিং' },
  rainTriggerStreak:      { label: 'রেইন ট্রিগার স্ট্রিক', description: 'টানা কতটি জয়ের পর Crypto Rain শুরু হবে।', unit: 'বার', min: 3, max: 20, type: 'number', category: 'ক্রিপ্টো রেইন' },
  rainBudgetDailyUsd:     { label: 'দৈনিক রেইন বাজেট', description: 'প্রতিদিন সর্বোচ্চ কত ডলার রেইন হিসেবে দেওয়া হবে।', unit: '$', min: 1, max: 10000, type: 'number', category: 'ক্রিপ্টো রেইন' },
  rainClaimPerUserUsd:    { label: 'প্রতি ইউজার ক্লেইম', description: 'একজন ইউজার একটি রেইন ইভেন্টে সর্বোচ্চ কত ডলার পাবে।', unit: '$', min: 0.01, max: 10, type: 'number', category: 'ক্রিপ্টো রেইন' },
  rainDurationSeconds:    { label: 'রেইনের স্থায়িত্ব', description: 'একটি Crypto Rain ইভেন্ট কত সেকেন্ড চলবে।', unit: 'সেকেন্ড', min: 10, max: 300, type: 'number', category: 'ক্রিপ্টো রেইন' },
  rainEnabled:            { label: 'রেইন ফিচার চালু', description: 'Crypto Rain সম্পূর্ণ বন্ধ বা চালু করুন।', type: 'boolean', category: 'ক্রিপ্টো রেইন' },
  maxSquadSize:           { label: 'স্কোয়াড সাইজ', description: 'একটি Squad Flip-এ সর্বোচ্চ কতজন অংশ নিতে পারবে।', unit: 'জন', min: 2, max: 10, type: 'number', category: 'স্কোয়াড' },
  squadEnabled:           { label: 'স্কোয়াড ফিচার চালু', description: 'Squad Flip ফিচার সম্পূর্ণ বন্ধ বা চালু করুন।', type: 'boolean', category: 'স্কোয়াড' },
  squadHouseEdgePercent:  { label: 'স্কোয়াড হাউজ এজ', description: 'Squad Flip-এর জন্য আলাদা হাউজ এজ। কম রাখলে ইউজার আকৃষ্ট হবে।', unit: '%', min: 0.1, max: 5, type: 'number', category: 'স্কোয়াড' },
  coinSpinDurationMs:     { label: 'কয়েন স্পিন সময়', description: 'কয়েন কত মিলিসেকেন্ড ঘুরবে। বেশি হলে টেনশন বাড়ে।', unit: 'ms', min: 1000, max: 10000, type: 'number', category: 'গেম স্পিড' },
  cooldownBetweenGamesMs: { label: 'গেমের মধ্যে বিরতি', description: 'দুটি গেমের মধ্যে কত মিলিসেকেন্ড অপেক্ষা করতে হবে।', unit: 'ms', min: 500, max: 10000, type: 'number', category: 'গেম স্পিড' },
  seedRotationAfterGames: { label: 'সিড রোটেশন', description: 'কত গেমের পর স্বয়ংক্রিয়ভাবে নতুন সার্ভার সিড তৈরি হবে।', unit: 'গেম', min: 10, max: 1000, type: 'number', category: 'নিরাপত্তা' },
  maintenanceMode:        { label: 'মেইনটেন্যান্স মোড', description: 'চালু করলে ইউজাররা গেম খেলতে পারবে না।', type: 'boolean', category: 'সিস্টেম' },
  maintenanceMessage:     { label: 'মেইনটেন্যান্স বার্তা', description: 'মেইনটেন্যান্স মোডে ইউজারদের কী বার্তা দেখাবে।', type: 'string', category: 'সিস্টেম' },
  jackpotEnabled:         { label: 'জ্যাকপট চালু', description: 'প্রোগ্রেসিভ জ্যাকপট সম্পূর্ণ বন্ধ বা চালু করুন।', type: 'boolean', category: 'জ্যাকপট' },
  jackpotMinBet:          { label: 'জ্যাকপট সর্বনিম্ন বেট', description: 'জ্যাকপটে অংশ নেওয়ার জন্য সর্বনিম্ন বেট পরিমাণ।', unit: '$', min: 0.01, max: 100, type: 'number', category: 'জ্যাকপট' },
  jackpotContributionPercent: { label: 'জ্যাকপট কন্ট্রিবিউশন (%)', description: 'প্রতি বেটের শতকরা কত অংশ জ্যাকপট পুলে যোগ হবে।', unit: '%', min: 0, max: 10, type: 'number', category: 'জ্যাকপট' },
  jackpotHitChance:       { label: 'জ্যাকপট জয়ের সুযোগ (১/X)', description: 'জ্যাকপট জয়ের সম্ভাবনা (১/X chance)। যেমন ১০০০০ দিলে প্রতি ১০,০০০ গেমে গড়ে একবার জিতবে।', unit: 'টি গেম', min: 2, max: 1000000, type: 'number', category: 'জ্যাকপট' },
  jackpotStartPool:       { label: 'জ্যাকপট শুরুর মান', description: 'জ্যাকপট জয়ের পর পুলটি যে প্রারম্ভিক অ্যামাউন্টে রিসেট হবে।', unit: '$', min: 0.01, max: 1000, type: 'number', category: 'জ্যাকপট' },
  jackpotPool:            { label: 'জ্যাকপট পুল ব্যালেন্স', description: 'জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থের পরিমাণ।', unit: '$', min: 0, max: 1000000, type: 'number', category: 'জ্যাকপট' },
};

// ═══════════════════════════════════════════════════════════════
//  DATABASE থেকে CONFIG পড়া ও লেখা
// ═══════════════════════════════════════════════════════════════

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
    [key, stringValue]
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

/** হাউজ এজ থেকে পেআউট মাল্টিপ্লায়ার বের করো */
export function getPayoutMultiplier(houseEdgePercent: number): number {
  // ২% হাউজ এজে: multiplier = 2 × (1 - 0.02) = 1.96
  return parseFloat((2 * (1 - houseEdgePercent / 100)).toFixed(4));
}

/** বেট পরিমাণ ভ্যালিড কিনা যাচাই করো */
export function validateBetAmount(
  amount: number,
  config: GameConfig
): { valid: boolean; error?: string } {
  if (amount < config.minBetAmount) {
    return { valid: false, error: `সর্বনিম্ন বেট $${config.minBetAmount}। আপনি দিয়েছেন $${amount}।` };
  }
  if (amount > config.maxBetAmount) {
    return { valid: false, error: `সর্বোচ্চ বেট $${config.maxBetAmount}। আপনি দিয়েছেন $${amount}।` };
  }
  return { valid: true };
}
