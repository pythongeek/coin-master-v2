/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN BONUS CONFIG — bonus, scatter, streak, lightning, daily
 *  wheel, leaderboard, rakeback, challenges. All promotional and
 *  reward-related typed config.
 *
 *  Part of the P1-11 refactor. See admin-game-config.ts header for
 *  the full architectural overview.
 * ═══════════════════════════════════════════════════════════════
 */

import type { GameConfig } from './admin-game-config';

/**
 * UI label / description / type metadata for the bonus-config slice.
 * Merged in the barrel `admin-config.ts` into the full CONFIG_LABELS.
 */
export const BONUS_CONFIG_LABELS: Partial<Record<keyof GameConfig, {
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}>> = {
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
  // দৈনিক লগইন হুইল
  dailyWheelEnabled:               { label: 'ডেইলি হুইল চালু', description: 'দৈনিক ফ্রি স্পিন হুইল ফিচার চালু বা বন্ধ করুন।', type: 'boolean', category: 'ডেইলি হুইল' },
  dailyWheelCooldownHours:         { label: 'হুইল কুলডাউন (ঘণ্টা)', description: 'প্রতি স্পিনের মধ্যে কত ঘণ্টা অপেক্ষা করতে হবে।', unit: 'h', min: 1, max: 168, type: 'number', category: 'ডেইলি হুইল' },
  dailyWheelPrizes:                { label: 'হুইল পুরস্কার', description: 'JSON array: {label,value,type,weight}।', type: 'string', category: 'ডেইলি হুইল' },
  // লিডারবোর্ড / টুর্নামেন্ট
  leaderboardEnabled:              { label: 'লিডারবোর্ড চালু', description: 'ওয়েজারিং লিডারবোর্ড ফিচার চালু বা বন্ধ করুন।', type: 'boolean', category: 'লিডারবোর্ড' },
  leaderboardPrizePool:            { label: 'প্রাইজ পুল', description: 'প্রতি সেশনে সর্বমোট পুরস্কারের পরিমাণ।', unit: 'কয়েন', min: 0, max: 10000, type: 'number', category: 'লিডারবোর্ড' },
  leaderboardPrizes:               { label: 'পুরস্কার বন্টন', description: 'JSON array: {rank,prize}।', type: 'string', category: 'লিডারবোর্ড' },
  leaderboardResetHours:             { label: 'রিসেট সময়', description: 'কত ঘণ্টা পর লিডারবোর্ড রিসেট হবে।', unit: 'h', min: 1, max: 168, type: 'number', category: 'লিডারবোর্ড' },
  // রেকব্যাক / ক্যাশব্যাক
  rakebackEnabled:                 { label: 'রেকব্যাক চালু', description: 'ওয়েজারিং-ভিত্তিক ক্যাশব্যাক ফিচার চালু বা বন্ধ করুন।', type: 'boolean', category: 'রেকব্যাক' },
  rakebackPercent:                 { label: 'রেকব্যাক %', description: 'মোট বেটের শতকরা কত ভাগ রেকব্যাক হিসেবে ফেরত পাবে।', unit: '%', min: 0, max: 10, type: 'number', category: 'রেকব্যাক' },
  rakebackMinClaimCoins:           { label: 'ন্যূনতম ক্লেইম', description: 'কত কয়েন জমা হলে ক্লেইম করা যাবে।', unit: 'কয়েন', min: 0.01, max: 1000, type: 'number', category: 'রেকব্যাক' },
  rakebackVipMultiplier:           { label: 'VIP মাল্টিপ্লায়ার', description: 'VIP র‌্যাঙ্ক অনুযায়ী রেকব্যাক মাল্টিপ্লায়ার।', unit: '×', min: 1, max: 10, type: 'number', category: 'রেকব্যাক' },
  // চ্যালেঞ্জ / মিশন
  challengesEnabled:               { label: 'চ্যালেঞ্জ চালু', description: 'দৈনিক চ্যালেঞ্জ / মিশন ফিচার চালু বা বন্ধ করুন।', type: 'boolean', category: 'চ্যালেঞ্জ' },
  dailyChallenges:                 { label: 'দৈনিক চ্যালেঞ্জ', description: 'JSON array: {id,label,target,reward,metric}।', type: 'string', category: 'চ্যালেঞ্জ' },
};

/**
 * Default values for the bonus-config slice. Merged in the barrel
 * `admin-config.ts` to produce the full `DEFAULT_CONFIG`.
 */
export const BONUS_DEFAULT_CONFIG: Partial<GameConfig> = {
  // বোনাস ও wagering
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
  // লিডারবোর্ড / টুর্নামেন্ট
  leaderboardEnabled: true,
  leaderboardPrizePool: 100,
  leaderboardPrizes: [
    { rank: 1, prize: 30 },
    { rank: 2, prize: 20 },
    { rank: 3, prize: 15 },
    { rank: 4, prize: 10 },
    { rank: 5, prize: 5 },
    { rank: 6, prize: 5 },
    { rank: 7, prize: 5 },
    { rank: 8, prize: 5 },
    { rank: 9, prize: 5 },
    { rank: 10, prize: 10 },
  ],
  leaderboardResetHours: 24,
  // রেকব্যাক / ক্যাশব্যাক
  rakebackEnabled: true,
  rakebackPercent: 0.5,
  rakebackMinClaimCoins: 1.0,
  rakebackVipMultiplier: 1.5,
  // চ্যালেঞ্জ / মিশন
  challengesEnabled: true,
  dailyChallenges: [
    { id: 'wager_50', label: 'Wager $50', target: 50, reward: 5, metric: 'wager' },
    { id: 'win_5', label: 'Win 5 flips', target: 5, reward: 3, metric: 'wins' },
    { id: 'bet_20', label: 'Place 20 bets', target: 20, reward: 2, metric: 'bets' },
    { id: 'streak_3', label: '3-win streak', target: 3, reward: 5, metric: 'streak' },
  ],
};
