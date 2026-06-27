import { z } from 'zod';

// Helper regex for alphanumeric + underscores
const usernameRegex = /^[a-zA-Z0-9_]+$/;

// ══════════════════════════════════════════════════════════════
//  AUTH SCHEMAS
// ══════════════════════════════════════════════════════════════

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে।')
    .max(30, 'ইউজারনেম সর্বোচ্চ ৩০ অক্ষরের হতে হবে।')
    .regex(usernameRegex, 'ইউজারনেমে শুধুমাত্র ইংরেজি অক্ষর, সংখ্যা এবং আন্ডারস্কোর (_) ব্যবহার করা যাবে।'),
  email: z
    .string()
    .email('সঠিক ইমেইল অ্যাড্রেস প্রদান করুন।')
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  password: z
    .string()
    .min(6, 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'),
  referralCode: z
    .string()
    .max(50, 'রেফারেল কোড সর্বোচ্চ ৫০ অক্ষরের হতে হবে।')
    .optional()
    .or(z.literal('')),
  fingerprint: z
    .string()
    .optional(),
});

export const loginSchema = z.object({
  username: z
    .string()
    .min(1, 'ইউজারনেম প্রয়োজন।'),
  password: z
    .string()
    .min(1, 'পাসওয়ার্ড প্রয়োজন।'),
});

export const walletAuthSchema = z.object({
  walletAddress: z
    .string()
    .min(10, 'সঠিক ওয়ালেট অ্যাড্রেস প্রয়োজন।'),
  signature: z
    .string()
    .optional(),
  fingerprint: z
    .string()
    .optional(),
});

// ══════════════════════════════════════════════════════════════
//  2FA SCHEMAS
// ══════════════════════════════════════════════════════════════

export const twoFactorVerifySchema = z.object({
  token: z
    .string()
    .length(6, '২এফএ কোড অবশ্যই ৬ সংখ্যার হতে হবে।')
    .regex(/^\d+$/, '২এফএ কোড শুধুমাত্র সংখ্যা হতে পারে।'),
});

export const twoFactorDisableSchema = z.object({
  token: z
    .string()
    .length(6, '২এফএ কোড অবশ্যই ৬ সংখ্যার হতে হবে।')
    .regex(/^\d+$/, '২এফএ কোড শুধুমাত্র সংখ্যা হতে পারে।'),
});

export const twoFactorLoginSchema = z.object({
  tempToken: z
    .string()
    .min(1, 'টেম্পোরারি টোকেন প্রয়োজন।'),
  token: z
    .string()
    .length(6, '২এফএ কোড অবশ্যই ৬ সংখ্যার হতে হবে।')
    .regex(/^\d+$/, '২এফএ কোড শুধুমাত্র সংখ্যা হতে পারে।'),
});

// ══════════════════════════════════════════════════════════════
//  GAME SCHEMAS
// ══════════════════════════════════════════════════════════════

export const betSchema = z.object({
  userId: z
    .string()
    .uuid('সঠিক ইউজার আইডি (UUID) প্রয়োজন।'),
  choice: z
    .enum(['heads', 'tails'], {
      message: 'choice শুধুমাত্র "heads" অথবা "tails" হতে পারে।'
    }),
  amount: z.coerce
    .number()
    .positive('বেটের পরিমাণ অবশ্যই পজিটিভ সংখ্যা হতে হবে।')
    .min(0.01, 'সর্বনিম্ন বেটের পরিমাণ $০.০১।')
    .max(1000, 'সর্বোচ্চ বেটের পরিমাণ $১,০০০।'),
  clientSeed: z
    .string()
    .optional(),
  targetMultiplier: z.coerce
    .number()
    .min(1.01, 'targetMultiplier অবশ্যই ১.০১ থেকে ১,০২৭,৬০৪.৪৮ এর মধ্যে হতে হবে।')
    .max(1027604.48, 'targetMultiplier অবশ্যই ১.০১ থেকে ১,০২৭,৬০৪.৪৮ এর মধ্যে হতে হবে।')
    .optional(),
});

export const verifySchema = z.object({
  serverSeed: z
    .string()
    .min(1, 'serverSeed প্রয়োজন।'),
  clientSeed: z
    .string()
    .min(1, 'clientSeed প্রয়োজন।'),
  nonce: z.coerce
    .number()
    .int('nonce অবশ্যই পূর্ণসংখ্যা হতে হবে।')
    .nonnegative('nonce পজিটিভ হতে হবে।'),
  serverSeedHash: z
    .string()
    .min(1, 'serverSeedHash প্রয়োজন।'),
  choice: z
    .enum(['heads', 'tails'], {
      message: 'choice শুধুমাত্র "heads" অথবা "tails" হতে পারে।'
    }),
  targetMultiplier: z.coerce
    .number()
    .positive()
    .optional(),
  houseEdge: z.coerce
    .number()
    .positive()
    .optional(),
  jackpotHitChance: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
});

// ══════════════════════════════════════════════════════════════
//  WALLET SCHEMAS
// ══════════════════════════════════════════════════════════════

export const depositAddressSchema = z.object({
  chain: z
    .enum(['ethereum', 'solana', 'tron'], {
      message: 'Invalid chain. Supported: ethereum, solana, tron'
    }),
});

export const depositMerchantSchema = z.object({
  amount: z.coerce
    .number()
    .positive('ডিপোজিট পরিমাণ অবশ্যই পজিটিভ হতে হবে।')
    .min(0.01, 'সর্বনিম্ন ডিপোজিট $০.০১।'),
  provider: z
    .enum(['binance', 'redotpay'], {
      message: 'Invalid provider. Supported: binance, redotpay'
    }),
  currency: z
    .string()
    .optional(),
});

export const withdrawSchema = z.object({
  walletId: z
    .string()
    .uuid('সঠিক ওয়ালেট আইডি (UUID) প্রয়োজন।'),
  toAddress: z
    .string()
    .min(10, 'উত্তোলন ওয়ালেট অ্যাড্রেস কমপক্ষে ১০ অক্ষরের হতে হবে।'),
  amount: z.coerce
    .number()
    .positive('উত্তোলনের পরিমাণ পজিটিভ সংখ্যা হতে হবে।')
    .min(0.01, 'সর্বনিম্ন উত্তোলন পরিমাণ $০.০১।'),
});

// ══════════════════════════════════════════════════════════════
//  KYC SCHEMAS
// ══════════════════════════════════════════════════════════════

export const verifyAISchema = z.object({
  document: z
    .string()
    .min(10, 'বৈধ ডকুমেন্ট ইমেজ (base64 string) প্রয়োজন।'),
  selfie: z
    .string()
    .min(10, 'বৈধ সেলফি ইমেজ (base64 string) প্রয়োজন।'),
});

// ══════════════════════════════════════════════════════════════
//  ADMIN SCHEMAS
// ══════════════════════════════════════════════════════════════

export const adminSettingsSchema = z.object({
  houseEdgePercent: z.coerce
    .number()
    .min(0.1, 'হাউজ এজ সর্বনিম্ন ০.১% হতে হবে।')
    .max(10, 'হাউজ এজ সর্বোচ্চ ১০% হতে হবে।')
    .optional(),
  minBetAmount: z.coerce
    .number()
    .min(0.01, 'সর্বনিম্ন বেট সর্বনিম্ন $০.০১ হতে হবে।')
    .max(10, 'সর্বনিম্ন বেট সর্বোচ্চ $১০ হতে হবে।')
    .optional(),
  maxBetAmount: z.coerce
    .number()
    .min(10, 'সর্বোচ্চ বেট সর্বনিম্ন $১০ হতে হবে।')
    .max(100000, 'সর্বোচ্চ বেট সর্বোচ্চ $১০০,০০০ হতে হবে।')
    .optional(),
  maxWinAmount: z.coerce
    .number()
    .min(100, 'সর্বোচ্চ জয়ের সীমা সর্বনিম্ন $১০০ হতে হবে।')
    .max(1000000, 'সর্বোচ্চ জয়ের সীমা সর্বোচ্চ $১,০০০,০০০ হতে হবে।')
    .optional(),
  maxConcurrentBets: z.coerce
    .number()
    .int()
    .min(1, 'একসাথে বেট সংখ্যা সর্বনিম্ন ১টি হতে হবে।')
    .max(5, 'একসাথে বেট সংখ্যা সর্বোচ্চ ৫টি হতে হবে।')
    .optional(),
  rainTriggerStreak: z.coerce
    .number()
    .int()
    .min(3, 'রেইন ট্রিগার স্ট্রিক সর্বনিম্ন ৩বার হতে হবে।')
    .max(20, 'রেইন ট্রিগার স্ট্রিক সর্বোচ্চ ২০বার হতে হবে।')
    .optional(),
  rainBudgetDailyUsd: z.coerce
    .number()
    .min(1, 'দৈনিক রেইন বাজেট সর্বনিম্ন $১ হতে হবে।')
    .max(10000, 'দৈনিক রেইন বাজেট সর্বোচ্চ $১০,০০০ হতে হবে।')
    .optional(),
  rainClaimPerUserUsd: z.coerce
    .number()
    .min(0.01, 'প্রতি ইউজার ক্লেইম সর্বনিম্ন $০.০১ হতে হবে।')
    .max(10, 'প্রতি ইউজার ক্লেইম সর্বোচ্চ $১০ হতে হবে।')
    .optional(),
  rainDurationSeconds: z.coerce
    .number()
    .min(10, 'রেইনের স্থায়িত্ব সর্বনিম্ন ১০সেকেন্ড হতে হবে।')
    .max(300, 'রেইনের স্থায়িত্ব সর্বোচ্চ ৩০০সেকেন্ড হতে হবে।')
    .optional(),
  rainEnabled: z.boolean().optional(),
  maxSquadSize: z.coerce
    .number()
    .int()
    .min(2, 'স্কোয়াড সাইজ সর্বনিম্ন ২জন হতে হবে।')
    .max(10, 'স্কোয়াড সাইজ সর্বোচ্চ ১০জন হতে হবে।')
    .optional(),
  squadEnabled: z.boolean().optional(),
  squadHouseEdgePercent: z.coerce
    .number()
    .min(0.1, 'স্কোয়াড হাউজ এজ সর্বনিম্ন ০.১% হতে হবে।')
    .max(5, 'স্কোয়াড হাউজ এজ সর্বোচ্চ ৫% হতে হবে।')
    .optional(),
  coinSpinDurationMs: z.coerce
    .number()
    .min(1000, 'কয়েন স্পিন সময় সর্বনিম্ন ১০০০ms হতে হবে।')
    .max(10000, 'কয়েন স্পিন সময় সর্বোচ্চ ১০০০০ms হতে হবে।')
    .optional(),
  cooldownBetweenGamesMs: z.coerce
    .number()
    .min(500, 'গেমের মধ্যে বিরতি সর্বনিম্ন ৫০০ms হতে হবে।')
    .max(10000, 'গেমের মধ্যে বিরতি সর্বোচ্চ ১০০০০ms হতে হবে।')
    .optional(),
  seedRotationAfterGames: z.coerce
    .number()
    .int()
    .min(10, 'সিড রোটেশন সর্বনিম্ন ১০গেম হতে হবে।')
    .max(1000, 'সিড রোটেশন সর্বোচ্চ ১০০০গেম হতে হবে।')
    .optional(),
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: z.string().optional(),
  jackpotEnabled: z.boolean().optional(),
  jackpotMinBet: z.coerce
    .number()
    .min(0.01, 'জ্যাকপট সর্বনিম্ন বেট $০.০১ হতে হবে।')
    .optional(),
  jackpotContributionPercent: z.coerce
    .number()
    .min(0, 'জন্ট্রিবিউশন শতকরা ০ এর নিচে হতে পারবে না।')
    .max(10, 'জন্ট্রিবিউশন শতকরা ১০ এর উপরে হতে পারবে না।')
    .optional(),
  jackpotHitChance: z.coerce
    .number()
    .int()
    .min(2, 'জ্যাকপট জয়ের সুযোগ কমপক্ষে ১/২ হতে হবে।')
    .optional(),
  jackpotStartPool: z.coerce
    .number()
    .min(0.01, 'জ্যাকপট শুরুর পুলের পরিমাণ কমপক্ষে $০.০১ হতে হবে।')
    .optional(),
  jackpotPool: z.coerce
    .number()
    .min(0, 'জ্যাকপট পুল নেতিবাচক হতে পারবে না।')
    .optional(),
});
