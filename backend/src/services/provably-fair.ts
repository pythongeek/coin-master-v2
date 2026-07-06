/**
 * ═══════════════════════════════════════════════════════════════
 *  PROVABLY FAIR ALGORITHM — গেমের মূল সততার প্রমাণ ব্যবস্থা
 * ═══════════════════════════════════════════════════════════════
 *
 *  এই অ্যালগরিদম প্রমাণ করে যে গেমের রেজাল্ট আগে থেকে ঠিক
 *  করা হয়নি এবং সার্ভার কোনো কারচুপি করেনি।
 *
 *  কীভাবে কাজ করে (সহজ বাংলায়):
 *  ──────────────────────────────────────────────────────────────
 *  ধরুন আপনি টস করার আগে একটি খাম সিল করলেন।
 *  খামের ভেতরে আছে টসের রেজাল্ট।
 *  খেলা শেষে খাম খুললে দেখা যাবে রেজাল্ট আগেই নির্ধারিত ছিল।
 *
 *  এখানে:
 *  📦 খাম = Server Seed Hash (খেলার আগে ইউজারকে দেওয়া)
 *  🔑 চাবি = Server Seed (খেলা শেষে প্রকাশ করা)
 *  🎲 ইউজারের অংশ = Client Seed (ইউজার নিজে দেয়)
 *  🔢 গেম নম্বর = Nonce (প্রতি গেমে ১ বাড়ে)
 *
 *  রেজাল্ট বের করার সূত্র:
 *  HMAC-SHA256(serverSeed, clientSeed + ":" + nonce)
 *  → প্রথম ৪ বাইট → সংখ্যায় রূপান্তর → জোড় = Heads, বেজোড় = Tails
 *
 *  হাউজ এজ (House Edge):
 *  উদাহরণ: ২% হাউজ এজে ইউজার ১০০ টাকা বেট করলে জিতলে পাবে ৯৬ টাকা।
 *  বাকি ৪ টাকা প্ল্যাটফর্মের লাভ (২% × ২ = ৪%)।
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';

// ── ধাপ ১: ফলাফলের ধরন নির্ধারণ ──────────────────────────────
export type FlipResult = 'heads' | 'tails';

export interface SeedPair {
  serverSeed: string;      // গোপন সিড (খেলা শেষে প্রকাশ)
  serverSeedHash: string;  // হ্যাশ করা সিড (আগেই ইউজারকে দেওয়া)
  clientSeed: string;      // ইউজারের সিড
  nonce: number;           // গেম নম্বর
}

export interface FlipOutcome {
  result: FlipResult;          // হেডস বা টেইলস
  rawHash: string;             // কম্পিউটেশনের কাঁচা হ্যাশ (ভেরিফিকেশনের জন্য)
  rawValue: number;            // হ্যাশ থেকে বের করা সংখ্যা
  serverSeedHash: string;      // ইউজার ভেরিফাই করতে পারবে
  payout: number;              // জিতলে কত পাবে
  houseEdge: number;           // প্ল্যাটফর্মের ফি %
  targetMultiplier: number;    // টার্গেট মাল্টিপ্লায়ার
  actualMultiplier: number;    // প্রকৃত মাল্টিপ্লায়ার
  winChance: number;           // জয়ের সম্ভাবনা %
  won: boolean;                // জিতেছে কিনা
  roll: number;                // প্রাপ্ত রোল (০-১০০)
}

export interface VerificationInput {
  serverSeed: string;   // গেম শেষে প্রকাশিত সার্ভার সিড
  clientSeed: string;   // ইউজারের সিড
  nonce: number;        // গেম নম্বর
  serverSeedHash: string; // মিলিয়ে দেখতে হবে
  choice: FlipResult;   // ইউজারের পছন্দ
  targetMultiplier: number; // টার্গেট মাল্টিপ্লায়ার
  houseEdge: number;    // প্ল্যাটফর্মের ফি %
}

export interface VerificationResult {
  isValid: boolean;       // সিড হ্যাশ মিলেছে কিনা
  result: FlipResult;     // কম্পিউটেড ফলাফল
  rawHash: string;
  hashMatches: boolean;   // খেলার সময়ের হ্যাশ মিলেছে কিনা
  explanation: string;    // বাংলায় ব্যাখ্যা
}

// ═══════════════════════════════════════════════════════════════
//  CORE FUNCTIONS — মূল ফাংশনগুলো
// ═══════════════════════════════════════════════════════════════

/**
 * নতুন সার্ভার সিড তৈরি করো
 * প্রতি সেশনের শুরুতে একটি নতুন সিড তৈরি হয়।
 * এটি সম্পূর্ণ র্যান্ডম — সার্ভারও আগে থেকে রেজাল্ট জানে না।
 */
export function generateServerSeed(): string {
  // ৩২ বাইট = ২৫৬ বিট র্যান্ডম ডেটা → হেক্স স্ট্রিং
  return crypto.randomBytes(32).toString('hex');
}

/**
 * সার্ভার সিডের SHA-256 হ্যাশ তৈরি করো
 * এটি খেলার আগে ইউজারকে দেওয়া হয় — প্রতিশ্রুতির মতো।
 * পরে সার্ভার সিড প্রকাশ করলে ইউজার নিজেই যাচাই করতে পারবে।
 * সিডটি হেক্স এনকোডেড ৩২ বাইট, তাই হ্যাশ করার আগে বাইট বাফারে রূপান্তর করি।
 */
export function hashServerSeed(serverSeed: string): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(serverSeed, 'hex'))
    .digest('hex');
}

/**
 * কয়েন ফ্লিপের ফলাফল বের করো
 *
 * সূত্র: HMAC-SHA256(serverSeed, clientSeed:nonce)
 * → প্রথম ৪ বাইট নাও → সংখ্যায় রূপান্তর করো
 * → জোড় সংখ্যা = HEADS | বেজোড় সংখ্যা = TAILS
 */
export function computeFlip(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): { result: FlipResult; rawHash: string; rawValue: number } {

  // ধাপ ১: ক্লায়েন্ট সিড + নন্স মিশিয়ে বার্তা তৈরি
  const message = `${clientSeed}:${nonce}`;

  // ধাপ ২: HMAC-SHA256 দিয়ে হ্যাশ তৈরি
  const rawHash = crypto
    .createHmac('sha256', serverSeed)
    .update(message)
    .digest('hex');

  // ধাপ ৩: হ্যাশের প্রথম ৪ বাইট (৮ হেক্স ক্যারেক্টার) নাও
  const firstFourBytes = rawHash.slice(0, 8);

  // ধাপ ৪: হেক্স → দশমিক সংখ্যায় রূপান্তর
  const rawValue = parseInt(firstFourBytes, 16);

  // ধাপ ৫: জোড় = HEADS, বেজোড় = TAILS
  const result: FlipResult = rawValue % 2 === 0 ? 'heads' : 'tails';

  return { result, rawHash, rawValue };
}

/**
 * প্রোগ্রেসিভ মাল্টিপ্লায়ার সহ কয়েন ফ্লিপ কম্পিউট করো
 */
export function computeFlipWithMultiplier(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  choice: FlipResult,
  targetMultiplier: number,
  houseEdge: number
): { result: FlipResult; rawHash: string; rawValue: number; roll: number } {
  const message = `${clientSeed}:${nonce}`;

  const rawHash = crypto
    .createHmac('sha256', serverSeed)
    .update(message)
    .digest('hex');

  const firstFourBytes = rawHash.slice(0, 8);
  const rawValue = parseInt(firstFourBytes, 16);

  // ০ থেকে ৯৯.৯৯৯৯৯৯ পরিসরে রোল রূপান্তর
  const roll = (rawValue / 0xFFFFFFFF) * 100;

  const winChance = (100 - houseEdge) / targetMultiplier;
  const won = roll < winChance;

  // জিতলে কয়েন পড়বে ইউজারের পছন্দে, হারলে বিপরীতে
  const result: FlipResult = won ? choice : (choice === 'heads' ? 'tails' : 'heads');

  return { result, rawHash, rawValue, roll };
}

/**
 * সম্পূর্ণ গেম পরিচালনা করো এবং পেআউট হিসাব করো
 *
 * @param seeds            - সার্ভার সিড, ক্লায়েন্ট সিড, নন্স
 * @param choice           - ইউজার কী বেছেছে (heads/tails)
 * @param betAmount        - বেট পরিমাণ
 * @param houseEdge        - প্ল্যাটফর্মের ফি % (ডিফল্ট ২%)
 * @param targetMultiplier - টার্গেট মাল্টিপ্লায়ার (ডিফল্ট ২x)
 */
export function resolveFlip(
  seeds: SeedPair,
  choice: FlipResult,
  betAmount: number,
  houseEdge: number = 2.0,
  targetMultiplier: number = 2.0
): FlipOutcome {
  const winChance = (100 - houseEdge) / targetMultiplier;

  // কয়েন ফ্লিপ কম্পিউট করো
  const { result, rawHash, rawValue, roll } = computeFlipWithMultiplier(
    seeds.serverSeed,
    seeds.clientSeed,
    seeds.nonce,
    choice,
    targetMultiplier,
    houseEdge
  );

  const won = roll < winChance;
  const payout = won ? parseFloat((betAmount * targetMultiplier).toFixed(8)) : 0;

  return {
    result,
    rawHash,
    rawValue,
    serverSeedHash: seeds.serverSeedHash,
    payout,
    houseEdge,
    targetMultiplier,
    actualMultiplier: targetMultiplier,
    winChance,
    won,
    roll
  };
}

/**
 * ইউজার নিজে ভেরিফাই করতে পারবে
 */
export function verifyFlip(input: VerificationInput): VerificationResult {
  const hashMatches = hashServerSeed(input.serverSeed) === input.serverSeedHash;

  const { result, rawHash, roll } = computeFlipWithMultiplier(
    input.serverSeed,
    input.clientSeed,
    input.nonce,
    input.choice,
    input.targetMultiplier || 2.0,
    input.houseEdge || 2.0
  );

  const winChance = (100 - (input.houseEdge || 2.0)) / (input.targetMultiplier || 2.0);
  const won = roll < winChance;

  let explanation: string;
  if (!hashMatches) {
    explanation = `❌ যাচাই ব্যর্থ! সার্ভার সিডের হ্যাশ মিলছে না। সম্ভাব্য কারচুপি!`;
  } else {
    explanation = `✅ যাচাই সফল! ` +
      `HMAC-SHA256("${input.serverSeed}", "${input.clientSeed}:${input.nonce}") = ${rawHash.slice(0,8)}... → Roll: ${roll.toFixed(4)}% (Win chance: ${winChance.toFixed(4)}%) → Result: ${result} (${won ? 'Win' : 'Loss'})`;
  }

  return {
    isValid: hashMatches,
    result,
    rawHash,
    hashMatches,
    explanation,
  };
}

/**
 * নতুন ক্লায়েন্ট সিড অটো-জেনারেট করো
 * ইউজার চাইলে নিজেও লিখতে পারবে।
 */
export function generateClientSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}
