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
  /** জ্যাকপট জয়ের সম্ভাবনা (১/X) */
  jackpotHitChance: number;
  /** জ্যাকপট শুরুর পুলের পরিমাণ */
  jackpotStartPool: number;
  /** জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থ */
  jackpotPool: number;

  // ── বোনাস ও wagering সেটিং ─────────────────────────────────
  /** স্বাগতম বোনাসের পরিমাণ (কয়েন) — এডমিন যেকোনো সময় বদলাতে পারবে */
  bonusWelcomeAmount: number;
  /** বোনাস wagering multiplier (বোনাস × N = wagering required) */
  bonusWagerMultiplier: number;
  /** বোনাস উইথড্র সর্বোচ্চ (বোনাস × N) */
  bonusMaxWithdrawalMultiplier: number;
  /** বোনাস expire হতে কত দিন */
  bonusExpiryDays: number;
  /** উইথড্র করতে বোনাসের শতকরা কত % deposit করতে হবে */
  bonusMinDepositToWithdrawPct: number;
  /** বোনাস পাওয়ার পর কত ঘণ্টা cooldown */
  bonusCooldownHours: number;
  /** Deposit match bonus (% of deposit, 0 = disabled) */
  bonusDepositMatchPct: number;
  /** Max deposit match bonus per deposit (coins) */
  bonusDepositMatchCap: number;
  /** Default cashback % of net losses */
  bonusCashbackPct: number;
  /** Default monthly VIP tier bonus amount */
  bonusVipMonthlyAmount: number;
  /** Default number of free spins per welcome campaign */
  bonusFreeSpinCount: number;
  /** Default bet value per free spin (coins) */
  bonusFreeSpinValue: number;

  // ── স্ক্যাটার বোনাস সেটিং ─────────────────────────────────────
  /** স্ক্যাটার বোনাস ফিচার চালু আছে কিনা */
  scatterEnabled: boolean;
  /** স্ক্যাটার জয়ের সম্ভাবনা (১/X) */
  scatterChance: number;
  /** স্ক্যাটার পেআউটের সর্বনিম্ন মাল্টিপ্লায়ার */
  scatterMinMultiplier: number;
  /** স্ক্যাটার পেআউটের সর্বোচ্চ মাল্টিপ্লায়ার */
  scatterMaxMultiplier: number;
  /** স্ক্যাটার বোনাসের স্থির বেট মান */
  scatterStakeUsd: number;

  // ── স্ট্রিক ল্যাডার বোনাস সেটিং ─────────────────────────────
  /** স্ট্রিক ল্যাডার বোনাস ফিচার চালু আছে কিনা */
  streakEnabled: boolean;
  /** স্ট্রিক বোনাসের দৈনিক বাজেট */
  streakBudgetDailyUsd: number;
  /** রাঙ ১-এ জয়ের সংখ্যা */
  streakRung1Wins: number;
  /** রাঙ ১-এ মাল্টিপ্লায়ার */
  streakRung1Multiplier: number;
  /** রাঙ ২-এ জয়ের সংখ্যা */
  streakRung2Wins: number;
  /** রাঙ ২-এ মাল্টিপ্লায়ার */
  streakRung2Multiplier: number;
  /** রাঙ ৩-এ জয়ের সংখ্যা */
  streakRung3Wins: number;
  /** রাঙ ৩-এ মাল্টিপ্লায়ার */
  streakRung3Multiplier: number;
  /** রাঙ ৪-এ জয়ের সংখ্যা */
  streakRung4Wins: number;
  /** রাঙ ৪-এ মাল্টিপ্লায়ার */
  streakRung4Multiplier: number;
  /** রাঙ ৫-এ জয়ের সংখ্যা */
  streakRung5Wins: number;
  /** রাঙ ৫-এ মাল্টিপ্লায়ার */
  streakRung5Multiplier: number;

  /** Min withdrawal amount (coins) */
  withdrawalMinCoins: number;
  /** Max withdrawal amount per request (coins) */
  withdrawalMaxCoins: number;
  /** Auto-approve withdrawals below this (0 = always manual) */
  withdrawalAutoApproveThreshold: number;
  /** Daily withdrawal limit per user (coins) */
  dailyWithdrawalLimitCoins: number;

  // লাইটনিং / মিস্টারি মাল্টিপ্লায়ার
  lightningEnabled: boolean;
  lightningChance: number;
  lightningMinMultiplier: number;
  lightningMaxMultiplier: number;
  lightningDurationSeconds: number;
  lightningBudgetDailyUsd: number;

  // দৈনিক লগইন হুইল
  dailyWheelEnabled: boolean;
  dailyWheelPrizes: { label: string; value: number; type: 'coins'; weight: number }[];
  dailyWheelCooldownHours: number;
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

  // বোনাস ও wagering — এডমিন PATCH /api/admin/config দিয়ে লাইভ বদলাতে পারবে
  bonusWelcomeAmount: 10.0,
  bonusWagerMultiplier: 30.0,
  bonusMaxWithdrawalMultiplier: 3.0,
  bonusExpiryDays: 7.0,
  bonusMinDepositToWithdrawPct: 50.0,
  bonusCooldownHours: 24.0,
  bonusDepositMatchPct: 50.0,
  bonusDepositMatchCap: 100.0,
  bonusCashbackPct: 10.0,
  bonusVipMonthlyAmount: 25.0,
  bonusFreeSpinCount: 5.0,
  bonusFreeSpinValue: 1.0,

  // স্ক্যাটার বোনাস
  scatterEnabled: false,
  scatterChance: 500,
  scatterMinMultiplier: 0.5,
  scatterMaxMultiplier: 20,
  scatterStakeUsd: 1.0,

  // স্ট্রিক ল্যাডার বোনাস
  streakEnabled: false,
  streakBudgetDailyUsd: 100.0,
  streakRung1Wins: 1,
  streakRung1Multiplier: 1.2,
  streakRung2Wins: 2,
  streakRung2Multiplier: 1.5,
  streakRung3Wins: 3,
  streakRung3Multiplier: 2.0,
  streakRung4Wins: 4,
  streakRung4Multiplier: 3.0,
  streakRung5Wins: 5,
  streakRung5Multiplier: 5.0,

  // লাইটনিং / মিস্টারি মাল্টিপ্লায়ার রাউন্ড
  lightningEnabled: false,
  lightningChance: 50,
  lightningMinMultiplier: 2.0,
  lightningMaxMultiplier: 10.0,
  lightningDurationSeconds: 5.0,
  lightningBudgetDailyUsd: 100.0,

  // দৈনিক লগইন হুইল
  dailyWheelEnabled: true,
  dailyWheelPrizes: [
    { label: '0.5 Coins', value: 0.5, type: 'coins', weight: 35 },
    { label: '1 Coin', value: 1, type: 'coins', weight: 25 },
    { label: '2 Coins', value: 2, type: 'coins', weight: 15 },
    { label: '3 Coins', value: 3, type: 'coins', weight: 10 },
    { label: '5 Coins', value: 5, type: 'coins', weight: 8 },
    { label: '10 Coins', value: 10, type: 'coins', weight: 5 },
    { label: '25 Coins', value: 25, type: 'coins', weight: 1.5 },
    { label: '50 Coins', value: 50, type: 'coins', weight: 0.5 },
  ],
  dailyWheelCooldownHours: 24,

  withdrawalMinCoins: 1.0,
  withdrawalMaxCoins: 10000.0,
  withdrawalAutoApproveThreshold: 0.0,
  dailyWithdrawalLimitCoins: 5000.0,
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
  jackpotStartPool:       { label: 'জ্যাকপট শুরুর মান', description: 'জ্যাকপট জয়ের পর পুলটি যে প্রারম্ভিক অ্যামাউন্টে রিসেট হবে।', unit: '$', min: 0.01, max: 1000, type: 'number', category: 'জ্যাকপট' },
  jackpotPool:            { label: 'জ্যাকপট পুল ব্যালেন্স', description: 'জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থের পরিমাণ।', unit: '$', min: 0, max: 1000000, type: 'number', category: 'জ্যাকপট' },

  // বোনাস
  bonusWelcomeAmount:            { label: 'স্বাগতম বোনাস', description: 'নতুন ইউজারকে প্রথম লগইনে দেওয়া বোনাসের পরিমাণ।', unit: 'কয়েন', min: 0, max: 10000, type: 'number', category: 'বোনাস' },
  bonusWagerMultiplier:          { label: 'Wagering multiplier', description: 'বোনাস × N = wagering required (বেট করতে হবে)।', unit: '×', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusMaxWithdrawalMultiplier:  { label: 'Max withdrawal multiplier', description: 'বোনাস × N = সর্বোচ্চ উইথড্র।', unit: '×', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusExpiryDays:               { label: 'বোনাস expire দিন', description: 'বোনাস কত দিন পর expire হবে।', unit: 'দিন', min: 1, max: 365, type: 'number', category: 'বোনাস' },
  bonusMinDepositToWithdrawPct:  { label: 'Min deposit %', description: 'বোনাস তুলতে বোনাসের শতকরা কত % deposit করতে হবে।', unit: '%', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusCooldownHours:            { label: 'Cooldown hours', description: 'বোনাস পাওয়ার পর কত ঘণ্টা cooldown।', unit: 'ঘণ্টা', min: 0, max: 720, type: 'number', category: 'বোনাস' },
  bonusDepositMatchPct:          { label: 'Deposit match %', description: 'ডিপোজিটের শতকরা কত ভাগ match bonus (0 = disabled)।', unit: '%', min: 0, max: 500, type: 'number', category: 'বোনাস' },
  bonusDepositMatchCap:          { label: 'Deposit match cap', description: 'প্রতি ডিপোজিটে সর্বোচ্চ match bonus।', unit: 'কয়েন', min: 0, max: 100000, type: 'number', category: 'বোনাস' },
  bonusCashbackPct:              { label: 'Cashback %', description: 'নেট loss-এর শতকরা কত ভাগ cashback।', unit: '%', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusVipMonthlyAmount:         { label: 'VIP monthly bonus', description: 'মাসিক VIP tier bonus।', unit: 'কয়েন', min: 0, max: 10000, type: 'number', category: 'বোনাস' },
  bonusFreeSpinCount:            { label: 'Free spin count', description: 'Welcome campaign-এ ফ্রি স্পিন সংখ্যা।', unit: 'টি', min: 0, max: 100, type: 'number', category: 'বোনাস' },
  bonusFreeSpinValue:            { label: 'Free spin value', description: 'প্রতি free spin-এর বেট মান।', unit: 'কয়েন', min: 0, max: 1000, type: 'number', category: 'বোনাস' },
  scatterEnabled:                { label: 'স্ক্যাটার বোনাস চালু', description: 'স্ক্যাটার বোনাস ফিচার সম্পূর্ণ বন্ধ বা চালু করুন।', type: 'boolean', category: 'স্ক্যাটার বোনাস' },
  scatterChance:                 { label: 'স্ক্যাটার বোনাস সুযোগ (১/X)', description: 'প্রতি বেটে স্ক্যাটার বোনাস জয়ের সম্ভাবনা (১/X)।', unit: 'টি', min: 2, max: 1000000, type: 'number', category: 'স্ক্যাটার বোনাস' },
  scatterMinMultiplier:          { label: 'সর্বনিম্ন মাল্টিপ্লায়ার', description: 'স্ক্যাটার বোনাসের সর্বনিম্ন মাল্টিপ্লায়ার।', unit: '×', min: 0.1, max: 100, type: 'number', category: 'স্ক্যাটার বোনাস' },
  scatterMaxMultiplier:          { label: 'সর্বোচ্চ মাল্টিপ্লায়ার', description: 'স্ক্যাটার বোনাসের সর্বোচ্চ মাল্টিপ্লায়ার।', unit: '×', min: 0.1, max: 1000, type: 'number', category: 'স্ক্যাটার বোনাস' },
  scatterStakeUsd:               { label: 'স্ক্যাটার বোনাস স্টেক', description: 'স্ক্যাটার বোনাসের জন্য ব্যবহৃত স্থির বেট মান।', unit: '$', min: 0.01, max: 1000, type: 'number', category: 'স্ক্যাটার বোনাস' },

  streakEnabled:            { label: 'স্ট্রিক ল্যাডার চালু', description: 'স্ট্রিক ল্যাডার বোনাস ফিচার সম্পূর্ণ বন্ধ বা চালু করুন।', type: 'boolean', category: 'স্ট্রিক ল্যাডার' },
  streakBudgetDailyUsd:     { label: 'দৈনিক স্ট্রিক বাজেট', description: 'প্রতিদিন সর্বোচ্চ কত ডলার স্ট্রিক ল্যাডার বোনাস হিসেবে দেওয়া হবে।', unit: '$', min: 0, max: 10000, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung1Wins:          { label: 'রাঙ ১ জয়ের সংখ্যা', description: 'কতটি টানা জয়ের পর রাঙ ১ সক্রিয় হবে।', unit: 'বার', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung1Multiplier:    { label: 'রাঙ ১ মাল্টিপ্লায়ার', description: 'রাঙ ১-এ বোনাস টপ-আপ মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung2Wins:          { label: 'রাঙ ২ জয়ের সংখ্যা', description: 'কতটি টানা জয়ের পর রাঙ ২ সক্রিয় হবে।', unit: 'বার', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung2Multiplier:    { label: 'রাঙ ২ মাল্টিপ্লায়ার', description: 'রাঙ ২-এ বোনাস টপ-আপ মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung3Wins:          { label: 'রাঙ ৩ জয়ের সংখ্যা', description: 'কতটি টানা জয়ের পর রাঙ ৩ সক্রিয় হবে।', unit: 'বার', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung3Multiplier:    { label: 'রাঙ ৩ মাল্টিপ্লায়ার', description: 'রাঙ ৩-এ বোনাস টপ-আপ মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung4Wins:          { label: 'রাঙ ৪ জয়ের সংখ্যা', description: 'কতটি টানা জয়ের পর রাঙ ৪ সক্রিয় হবে।', unit: 'বার', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung4Multiplier:    { label: 'রাঙ ৪ মাল্টিপ্লায়ার', description: 'রাঙ ৪-এ বোনাস টপ-আপ মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung5Wins:          { label: 'রাঙ ৫ জয়ের সংখ্যা', description: 'কতটি টানা জয়ের পর রাঙ ৫ সক্রিয় হবে।', unit: 'বার', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },
  streakRung5Multiplier:    { label: 'রাঙ ৫ মাল্টিপ্লায়ার', description: 'রাঙ ৫-এ বোনাস টপ-আপ মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 50, type: 'number', category: 'স্ট্রিক ল্যাডার' },

  // লাইটনিং / মিস্টারি মাল্টিপ্লায়ার
  lightningEnabled:                { label: 'লাইটনিং রাউন্ড চালু', description: 'র‍্যান্ডমভাবে নির্দিষ্ট বেশি পেআউট মাল্টিপ্লায়ার দেখাবে।', type: 'boolean', category: 'লাইটনিং রাউন্ড' },
  lightningChance:                 { label: 'লাইটনিং সম্ভাবনা', description: 'কত বেটে ১টি লাইটনিং রাউন্ড হবে (১/X)।', unit: 'বেট', min: 1, max: 10000, type: 'number', category: 'লাইটনিং রাউন্ড' },
  lightningMinMultiplier:          { label: 'ন্যূনতম মাল্টিপ্লায়ার', description: 'লাইটনিং রাউন্ডে পেআউট কতগুণ থেকে শুরু হবে।', unit: 'x', min: 1.1, max: 100, type: 'number', category: 'লাইটনিং রাউন্ড' },
  lightningMaxMultiplier:          { label: 'সর্বোচ্চ মাল্টিপ্লায়ার', description: 'লাইটনিং রাউন্ডে পেআউট কতগুণ পর্যন্ত যেতে পারে।', unit: 'x', min: 1.1, max: 500, type: 'number', category: 'লাইটনিং রাউন্ড' },
  lightningDurationSeconds:        { label: 'প্রদর্শন সময়', description: 'কত সেকেন্ড লাইটনিং মাল্টিপ্লায়ার দেখাবে।', unit: 's', min: 1, max: 30, type: 'number', category: 'লাইটনিং রাউন্ড' },
  lightningBudgetDailyUsd:         { label: 'দৈনিক বাজেট', description: 'প্রতিদিন সর্বোচ্চ কত ডলার লাইটনিং বাড়তি পেআউট হিসেবে দেওয়া হবে।', unit: '$', min: 0, max: 10000, type: 'number', category: 'লাইটনিং রাউন্ড' },

  // তহবিল / উত্তোলন
  withdrawalMinCoins:              { label: 'ন্যূনতম উত্তোলন', description: 'একক উত্তোলনের ন্যূনতম পরিমাণ (কয়েন)।', unit: 'coin', min: 0.1, max: 10000, type: 'number', category: 'তহবিল / উত্তোলন' },
  withdrawalMaxCoins:              { label: 'সর্বোচ্চ উত্তোলন', description: 'একক উত্তোলনের সর্বোচ্চ পরিমাণ (কয়েন)।', unit: 'coin', min: 1, max: 1000000, type: 'number', category: 'তহবিল / উত্তোলন' },
  withdrawalAutoApproveThreshold:  { label: 'Auto-approve threshold', description: 'এই পরিমাণের কম হলে অটো-অনুমোদন (0 = সবসময় ম্যানুয়াল)।', unit: 'কয়েন', min: 0, max: 10000, type: 'number', category: 'উইথড্র' },
  dailyWithdrawalLimitCoins:       { label: 'Daily withdrawal limit', description: 'প্রতিদিন প্রতি ইউজার সর্বোচ্চ উইথড্র।', unit: 'কয়েন', min: 0, max: 1000000, type: 'number', category: 'উইথড্র' },

  // দৈনিক লগইন হুইল
  dailyWheelEnabled:               { label: 'ডেইলি হুইল চালু', description: 'দৈনিক ফ্রি স্পিন হুইল ফিচার চালু বা বন্ধ করুন।', type: 'boolean', category: 'ডেইলি হুইল' },
  dailyWheelCooldownHours:         { label: 'হুইল কুলডাউন (ঘণ্টা)', description: 'প্রতি স্পিনের মধ্যে কত ঘণ্টা অপেক্ষা করতে হবে।', unit: 'h', min: 1, max: 168, type: 'number', category: 'ডেইলি হুইল' },
  dailyWheelPrizes:                { label: 'হুইল পুরস্কার', description: 'JSON array: {label,value,type,weight}।', type: 'string', category: 'ডেইলি হুইল' },
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
        } else if (camelKey === 'dailyWheelPrizes') {
          try {
            (config as any)[camelKey] = JSON.parse(row.value);
          } catch {
            (config as any)[camelKey] = DEFAULT_CONFIG.dailyWheelPrizes;
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
