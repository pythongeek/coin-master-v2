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

  // ── মেইনটেন্যান্স মোড ──────────────────────────────────────────
  /** গেম বন্ধ আছে কিনা */
  maintenanceMode: boolean;
  /** বন্ধ থাকলে ইউজারদের কী বার্তা দেখাবে */
  maintenanceMessage: string;

  // ── বোনাস সিস্টেম সেটিং (Session 1, roadmap-2026.md) ────────────
  /** Wagering multiplier — bonus × N = wagering required */
  bonusWagerMultiplier: number;
  /** Max withdrawal = bonus × N (profit-first default) */
  bonusMaxWithdrawalMultiplier: number;
  /** Days until bonus expires and is forfeit */
  bonusExpiryDays: number;
  /** Min deposit as % of bonus before withdrawal allowed */
  bonusMinDepositToWithdrawPct: number;
  /** Hours after bonus grant before withdrawal allowed (cooldown) */
  bonusCooldownHours: number;
  /** Welcome bonus amount in coins */
  bonusWelcomeAmount: number;
  /** Deposit match bonus as % of deposit (0 = disabled) */
  bonusDepositMatchPct: number;
  /** Max deposit match bonus per deposit in coins */
  bonusDepositMatchCap: number;

  // ── উইথড্রাল সেটিং (Session 1) ────────────────────────────────
  /** Daily max withdrawal per user in coins */
  dailyWithdrawalLimitCoins: number;
  /** Minimum withdrawal amount in coins */
  withdrawalMinCoins: number;
  /** Maximum withdrawal amount per request in coins */
  withdrawalMaxCoins: number;
  /** Auto-approve withdrawals below this (0 = always manual) */
  withdrawalAutoApproveThreshold: number;
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

  // মেইনটেন্যান্স মোড
    maintenanceMode: false,
    maintenanceMessage: 'সাইটটি আপগ্রেডের জন্য সাময়িকভাবে বন্ধ আছে। শীঘ্রই আসছে!',

    // বোনাস সিস্টেম ডিফল্ট (Session 1)
    bonusWagerMultiplier: 30,           // ১০ বোনাস = ৩০০ ওয়েজারিং
    bonusMaxWithdrawalMultiplier: 3,    // ১০ বোনাসে সর্বোচ্চ ৩০ তোলা (profit-first)
    bonusExpiryDays: 7,                 // ৭ দিনে মেয়াদ শেষ
    bonusMinDepositToWithdrawPct: 50,   // ৫০% মিন ডিপোজিট
    bonusCooldownHours: 24,             // ২৪ ঘণ্টা কুলিং অফ
    bonusWelcomeAmount: 10,             // ১০ Coin ওয়েলকাম বোনাস
    bonusDepositMatchPct: 50,           // ৫০% ম্যাচ বোনাস
    bonusDepositMatchCap: 100,          // ১০০ Coin ম্যাক্স ম্যাচ

    // উইথড্রাল ডিফল্ট
    dailyWithdrawalLimitCoins: 5000,
    withdrawalMinCoins: 1,
    withdrawalMaxCoins: 10000,
    withdrawalAutoApproveThreshold: 0,  // 0 = always manual approval
  };

// ── কনফিগ কী → বাংলা লেবেল ম্যাপিং (UI-র জন্য) ───────────────
export const CONFIG_LABELS: Record<keyof GameConfig, { label: string; description: string; unit?: string; min?: number; max?: number; type: 'number' | 'boolean' | 'string'; category: string }> = {
  houseEdgePercent:       { label: 'হাউজ এজ', description: 'প্ল্যাটফর্মের লাভের পার্সেন্ট। ২% মানে ইউজার ১০০ বেটে জিতলে ১৯৬ পাবে।', unit: '%', min: 0.1, max: 10, type: 'number', category: 'বেটিং' },
  minBetAmount:           { label: 'সর্বনিম্ন বেট', description: 'একটি বেটে সর্বনিম্ন পরিমাণ।', unit: '$', min: 0.01, max: 10, type: 'number', category: 'বেটিং' },
  maxBetAmount:           { label: 'সর্বোচ্চ বেট', description: 'একটি বেটে সর্বোচ্চ পরিমাণ। রিস্ক কন্ট্রোলের জন্য গুরুত্বপূর্ণ।', unit: '$', min: 10, max: 100000, type: 'number', category: 'বেটিং' },
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

  // Session 1: bonus + withdrawal params (admin editable)
  bonusWagerMultiplier:         { label: 'বোনাস wager multiplier', description: 'wagering প্রয়োজন = bonus × N। বেশি = বেশি wagering।', unit: '×', min: 1, max: 100, type: 'number', category: 'বোনাস' },
  bonusMaxWithdrawalMultiplier: { label: 'সর্বোচ্চ উইথড্র multiplier', description: 'bonus × N = max withdrawable from bonus. কম = কম ঝুঁকি।', unit: '×', min: 1, max: 20, type: 'number', category: 'বোনাস' },
  bonusExpiryDays:              { label: 'বোনাস মেয়াদ (দিন)', description: 'এই দিনের পর bonus expire হবে।', unit: 'দিন', min: 1, max: 90, type: 'number', category: 'বোনাস' },
  bonusMinDepositToWithdrawPct: { label: 'মিন ডিপোজিট % (of bonus)', description: 'Bonus তুলতে হলে কত % deposit লাগবে। 100 = সমপরিমাণ।', unit: '%', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusCooldownHours:           { label: 'কুলিং অফ (ঘণ্টা)', description: 'Bonus পাওয়ার পর কত ঘণ্টা withdraw বন্ধ।', unit: 'ঘণ্টা', min: 0, max: 168, type: 'number', category: 'বোনাস' },
  bonusWelcomeAmount:           { label: 'ওয়েলকাম বোনাস', description: 'নতুন ইউজার পাবে এত Coin।', unit: 'Coin', min: 0, max: 1000, type: 'number', category: 'বোনাস' },
  bonusDepositMatchPct:         { label: 'ডিপোজিট ম্যাচ %', description: 'Deposit-এর উপর এত % bonus। 0 = disabled।', unit: '%', min: 0, max: 200, type: 'number', category: 'বোনাস' },
  bonusDepositMatchCap:         { label: 'ডিপোজিট ম্যাচ ক্যাপ', description: 'প্রতি deposit-এ সর্বোচ্চ কত Coin bonus।', unit: 'Coin', min: 0, max: 10000, type: 'number', category: 'বোনাস' },

  dailyWithdrawalLimitCoins:    { label: 'দৈনিক উইথড্র সীমা', description: 'প্রতিদিন সর্বোচ্চ কত Coin withdraw করা যাবে।', unit: 'Coin', min: 0, max: 1000000, type: 'number', category: 'উইথড্রাল' },
  withdrawalMinCoins:           { label: 'মিনিমাম উইথড্র', description: 'একবারে কমপক্ষে কত Coin তোলা যাবে।', unit: 'Coin', min: 0.01, max: 100, type: 'number', category: 'উইথড্রাল' },
  withdrawalMaxCoins:           { label: 'ম্যাক্সিমাম উইথড্র', description: 'একবারে সর্বোচ্চ কত Coin তোলা যাবে।', unit: 'Coin', min: 1, max: 1000000, type: 'number', category: 'উইথড্রাল' },
  withdrawalAutoApproveThreshold: { label: 'অটো-অনুমোদন থ্রেশহোল্ড', description: 'এই পরিমাণের কম হলে auto-approve, বেশি হলে manual। 0 = সব manual।', unit: 'Coin', min: 0, max: 1000, type: 'number', category: 'উইথড্রাল' },
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

    // ডাটাবেস থেকে পড়া মান দিয়ে আপডেট করো
    for (const row of result.rows) {
      const key = row.key as keyof GameConfig;
      if (key in config) {
        const meta = CONFIG_LABELS[key];
        if (meta.type === 'boolean') {
          (config as Record<string, unknown>)[key] = row.value === 'true';
        } else if (meta.type === 'number') {
          (config as Record<string, unknown>)[key] = parseFloat(row.value);
        } else {
          (config as Record<string, unknown>)[key] = row.value;
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
