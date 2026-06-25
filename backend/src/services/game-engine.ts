/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME ENGINE — গেমের মস্তিষ্ক
 * ═══════════════════════════════════════════════════════════════
 *
 *  এই ফাইলটি Provably Fair আর Admin Config একত্রিত করে
 *  একটি সম্পূর্ণ গেম রাউন্ড পরিচালনা করে।
 *
 *  একটি গেম রাউন্ডের ক্রম:
 *  ──────────────────────────────────────────────────────────────
 *  ১. ইউজার বেট ধরে (choice + amount)
 *  ২. সার্ভার নতুন সিড তৈরি করে → হ্যাশ ইউজারকে দেয়
 *  ৩. কয়েন স্পিন শুরু হয় (অ্যানিমেশন)
 *  ৪. রেজাল্ট কম্পিউট হয় (Provably Fair)
 *  ৫. স্পিন থামে → রেজাল্ট দেখায়
 *  ৬. ব্যালেন্স আপডেট হয়
 *  ৭. সার্ভার সিড প্রকাশ করা হয় (ভেরিফিকেশনের জন্য)
 *  ৮. Win Streak চেক → Crypto Rain ট্রিগার?
 * ═══════════════════════════════════════════════════════════════
 */

import { v4 as uuidv4 } from 'uuid';
import {
  generateServerSeed, hashServerSeed, resolveFlip,
  generateClientSeed, FlipResult, FlipOutcome, SeedPair
} from './provably-fair';
import {
  getConfig, validateBetAmount, GameConfig
} from './admin-config';
import { db, query } from '../config/database';
import {
  lockBet, unlockBet, incrementWinStreak,
  resetWinStreak, getWinStreak
} from '../config/redis';
import { reconcileUser } from './reconciliation-engine';

// ── ইনপুট ও আউটপুটের ধরন ───────────────────────────────────────
export interface BetRequest {
  userId: string;
  choice: FlipResult;
  amount: number;
  clientSeed?: string;  // ইউজার না দিলে অটো-জেনারেট
  targetMultiplier?: number;
}

export interface BetResponse {
  betId: string;
  result: FlipResult;
  choice: FlipResult;
  won: boolean;
  betAmount: number;
  payout: number;
  houseEdge: number;
  targetMultiplier: number;
  actualMultiplier: number;
  winChance: number;
  roll: number;
  newBalance: number;
  winStreak: number;
  cryptoRainTriggered: boolean;
  // Provably Fair ডেটা (ইউজার ভেরিফাই করতে পারবে)
  verification: {
    serverSeedHash: string;   // খেলার আগে দেওয়া হয়েছিল
    serverSeed: string;       // খেলার পরে প্রকাশ করা হলো
    clientSeed: string;
    nonce: number;
    rawHash: string;
    roll: number;
    winChance: number;
  };
  message: string;  // বাংলায় ফলাফলের বার্তা
}

/**
 * একটি ফ্লিপ বেট প্লেস এবং প্রসেস করো (Provably Fair)
 */
export async function placeBet(req: BetRequest): Promise<BetResponse> {
  // ── ধাপ ১: গেম কনফিগ লোড করো ──────────────────────────────
  const config = await getConfig();

  if (config.maintenanceMode) {
    throw new Error(config.maintenanceMessage);
  }

  // ── ধাপ ২: বেট পরিমাণ যাচাই করো ───────────────────────────
  const validation = validateBetAmount(req.amount, config);
  if (!validation.valid) throw new Error(validation.error);

  // ── জয়ের সর্বোচ্চ সীমা চেক করো ──
  const targetMultiplier = req.targetMultiplier || 2.00;
  const potentialPayout = req.amount * targetMultiplier;
  if (potentialPayout > config.maxWinAmount) {
    throw new Error(`বেটের সম্ভাব্য জয় আপনার জয়ের সীমা $${config.maxWinAmount} অতিক্রম করেছে।`);
  }

  // ── ধাপ ৩: রেস কন্ডিশন প্রতিরোধ করো (একসাথে ২টি বেট নয়) ──
  const locked = await lockBet(req.userId, req.amount);
  if (!locked) throw new Error('একটি গেম চলছে। শেষ হলে আবার চেষ্টা করুন।');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── ধাপ ৪: ইউজারের ব্যালেন্স চেক করো (Row Lock সহ) ──────────────────────
    const userResult = await client.query(
      'SELECT balance FROM users WHERE id = $1 AND is_active = true FOR UPDATE',
      [req.userId]
    );
    if (!userResult.rows.length) throw new Error('ইউজার পাওয়া যায়নি।');

    const currentBalance = parseFloat(userResult.rows[0].balance);
    if (currentBalance < req.amount) {
      throw new Error(`অপর্যাপ্ত ব্যালেন্স। আপনার কাছে আছে: $${currentBalance.toFixed(2)}`);
    }

    // ── Provably Fair সিড তৈরি করো ──────────────────────
    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = req.clientSeed || generateClientSeed();

    // নন্স বের করো (এই ইউজারের কততম গেম)
    const nonceResult = await client.query(
      'SELECT COUNT(*) as count FROM bets WHERE user_id = $1',
      [req.userId]
    );
    const nonce = parseInt(nonceResult.rows[0].count) + 1;

    const seeds: SeedPair = { serverSeed, serverSeedHash, clientSeed, nonce };

    // ── গেম রেজাল্ট বের করো ─────────────────────────────
    const outcome: FlipOutcome = resolveFlip(
      seeds, req.choice, req.amount, config.houseEdgePercent, targetMultiplier
    );
    const won = outcome.won;

    // ── ধাপ ৭: ব্যালেন্স আপডেট করো ─────────────────────────────
    const balanceChange = won ? outcome.payout - req.amount : -req.amount;
    const newBalance = parseFloat((currentBalance + balanceChange).toFixed(8));

    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [newBalance, req.userId]
    );

    // ── ধাপ ৮: বেট ডাটাবেসে সেভ করো ────────────────────────────
    const betId = uuidv4();
    await client.query(
      `INSERT INTO bets
        (id, user_id, choice, amount, result, won, payout, house_edge, 
         target_multiplier, actual_multiplier, win_chance, status, flip_hash, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'resolved',$12,NOW())`,
      [betId, req.userId, req.choice, req.amount,
       outcome.result, won, outcome.payout, config.houseEdgePercent,
       targetMultiplier, targetMultiplier, outcome.winChance, outcome.rawHash]
    );

    // Run reconciliation check
    await reconcileUser(req.userId, client);

    await client.query('COMMIT');

    // ── ধাপ ৯: Win Streak আপডেট করো ─────────────────────────────
    let winStreak = 0;
    let cryptoRainTriggered = false;

    if (won) {
      winStreak = await incrementWinStreak(req.userId);
      // Crypto Rain ট্রিগার চেক
      if (winStreak >= config.rainTriggerStreak && config.rainEnabled) {
        cryptoRainTriggered = true;
        await triggerCryptoRain(req.userId, config);
        await resetWinStreak(req.userId); // ট্রিগারের পর রিসেট
      }
    } else {
      await resetWinStreak(req.userId);
    }

    // ── ধাপ ১০: বার্তা তৈরি করো ─────────────────────────────────
    const message = won
      ? `🎉 জিতেছেন! +$${outcome.payout.toFixed(2)} আপনার ওয়ালেটে যোগ হয়েছে।`
      : `😔 হেরেছেন! -$${req.amount.toFixed(2)} বেট।`;

    return {
      betId,
      result: outcome.result,
      choice: req.choice,
      won,
      betAmount: req.amount,
      payout: outcome.payout,
      houseEdge: config.houseEdgePercent,
      targetMultiplier,
      actualMultiplier: targetMultiplier,
      winChance: outcome.winChance,
      roll: outcome.roll,
      newBalance,
      winStreak,
      cryptoRainTriggered,
      verification: {
        serverSeedHash,
        serverSeed,  // এখন প্রকাশ করা হলো
        clientSeed,
        nonce,
        rawHash: outcome.rawHash,
        roll: outcome.roll,
        winChance: outcome.winChance,
      },
      message,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    // সবসময় লক খুলে দাও (এরর হলেও)
    await unlockBet(req.userId);
  }
}

// ── Crypto Rain ট্রিগার ──────────────────────────────────────────
async function triggerCryptoRain(userId: string, config: GameConfig): Promise<void> {
  const rainAmount = Math.min(
    config.rainBudgetDailyUsd * 0.1,  // বাজেটের ১০% প্রতি রেইনে
    5.0  // সর্বোচ্চ $৫ প্রতি রেইন
  );

  await query(
    `INSERT INTO crypto_rain_events
      (triggered_by, trigger_type, total_amount, max_claims, expires_at)
     VALUES ($1, 'win_streak', $2, $3, NOW() + INTERVAL '${config.rainDurationSeconds} seconds')`,
    [userId, rainAmount, Math.floor(rainAmount / config.rainClaimPerUserUsd)]
  );
}

// ── ইউজারের বেট হিস্ট্রি ─────────────────────────────────────────
export async function getBetHistory(userId: string, limit: number = 20) {
  const result = await query(
    `SELECT id, choice, amount, result, won, payout, house_edge,
            target_multiplier, actual_multiplier, win_chance,
            flip_hash, created_at, resolved_at
     FROM bets WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}
