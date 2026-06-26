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

import crypto from 'crypto';
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
import { invalidateCache } from './cache';
import { dispatchWebhook } from './webhook';

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
  jackpotWon?: boolean;
  jackpotAmount?: number;
  jackpotRoll?: number;
  jackpotPool?: number;
  // Provably Fair ডেটা (ইউজার ভেরিফাই করতে পারবে)
  verification: {
    serverSeedHash: string;   // খেলার আগে দেওয়া হয়েছিল
    serverSeed: string;       // খেলার পরে প্রকাশ করা হলো
    clientSeed: string;
    nonce: number;
    rawHash: string;
    roll: number;
    winChance: number;
    jackpotSignature?: string;
    jackpotHash?: string;
    jackpotRoll?: number;
    jackpotHitChance?: number;
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

    // ── 🔍 VIP Rakeback Helper ──
    const getVipRakebackPercent = (wagered: number): number => {
      if (wagered <= 1000) return 0.05;
      if (wagered <= 10000) return 0.10;
      if (wagered <= 50000) return 0.15;
      if (wagered <= 250000) return 0.20;
      return 0.25;
    };

    // ── шаг ৪: ইউজারের ব্যালেন্স চেক করো (Row Lock সহ) ──────────────────────
    const userResult = await client.query(
      'SELECT balance, total_wagered, pending_rakeback FROM users WHERE id = $1 AND is_active = true FOR UPDATE',
      [req.userId]
    );
    if (!userResult.rows.length) throw new Error('ইউজার পাওয়া যায়নি।');

    const currentBalance = parseFloat(userResult.rows[0].balance);
    const totalWagered = parseFloat(userResult.rows[0].total_wagered || '0');
    const pendingRakeback = parseFloat(userResult.rows[0].pending_rakeback || '0');

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

    // ── Progressive Jackpot Accumulator & Roll ────────────────
    let jackpotWon = false;
    let jackpotAmount = 0;
    let jackpotRoll = -1;
    let finalJackpotPool = config.jackpotPool;

    if (config.jackpotEnabled && req.amount >= config.jackpotMinBet) {
      const contribution = req.amount * (config.jackpotContributionPercent / 100);
      const tempPool = config.jackpotPool + contribution;
      
      const jackpotSignature = `${clientSeed}:${nonce}:jackpot`;
      const jackpotHash = crypto.createHmac('sha256', serverSeed).update(jackpotSignature).digest('hex');
      const rawJackpotVal = parseInt(jackpotHash.slice(0, 8), 16);
      jackpotRoll = rawJackpotVal % config.jackpotHitChance;

      if (jackpotRoll === 777) {
        jackpotWon = true;
        jackpotAmount = parseFloat(tempPool.toFixed(8));
        finalJackpotPool = config.jackpotStartPool;
      } else {
        finalJackpotPool = tempPool;
      }
    }

    // ── шаг ৭: ব্যালেন্স ও ওয়াগার/রেকব্যাক আপডেট করো ─────────────────────────────
    let balanceChange = won ? outcome.payout - req.amount : -req.amount;
    if (jackpotWon) {
      balanceChange += jackpotAmount;
    }
    const newBalance = parseFloat((currentBalance + balanceChange).toFixed(8));

    const newTotalWagered = totalWagered + req.amount;
    const rakebackRate = getVipRakebackPercent(newTotalWagered);
    const rakebackAmount = req.amount * (config.houseEdgePercent / 100) * rakebackRate;
    const newPendingRakeback = parseFloat((pendingRakeback + rakebackAmount).toFixed(8));

    await client.query(
      'UPDATE users SET balance = $1, total_wagered = $2, pending_rakeback = $3, updated_at = NOW() WHERE id = $4',
      [newBalance, newTotalWagered, newPendingRakeback, req.userId]
    );

    // Save final jackpot pool value to admin_settings table
    if (config.jackpotEnabled && req.amount >= config.jackpotMinBet) {
      await client.query(
        "INSERT INTO admin_settings (key, value, updated_at) VALUES ('jackpot_pool', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
        [String(finalJackpotPool.toFixed(8))]
      );

      if (jackpotWon) {
        // Record jackpot transaction log
        const txId = uuidv4();
        await client.query(
          `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, metadata, completed_at)
           VALUES ($1, $2, NULL, 'jackpot', $3, 'completed', '{}', NOW())`,
          [txId, req.userId, jackpotAmount]
        );

        // Emit socket notification to all connected clients
        try {
          const { io } = require('../index');
          if (io) {
            io.emit('jackpot_hit', {
              userId: req.userId,
              amount: jackpotAmount,
              roll: jackpotRoll
            });
          }
        } catch (err) {
          console.warn('Socket emit failed for jackpot:', err);
        }

        // Dispatch jackpot.won webhook
        await dispatchWebhook('jackpot.won', {
          userId: req.userId,
          amount: jackpotAmount,
          roll: jackpotRoll,
          timestamp: new Date().toISOString()
        });
      }
    }

    // ──剧৮: বেট ডাটাবেসে সেভ করো ────────────────────────────
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

    // Invalidate caches for updated stats and leaderboards
    await invalidateCache([`cache:stats:${req.userId}`, 'cache:leaderboards', 'cache:stats:active']).catch(err => {
      console.warn('Cache invalidation failed:', err);
    });

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
    let message = won
      ? `🎉 জিতেছেন! +$${outcome.payout.toFixed(2)} আপনার ওয়ালেটে যোগ হয়েছে।`
      : `😔 হেরেছেন! -$${req.amount.toFixed(2)} বেট।`;
    if (jackpotWon) {
      message += ` 👑 আপনি $${jackpotAmount.toFixed(2)} মূল্যের জ্যাকপট জিতেছেন!`;
    }

    const resultResponse = {
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
      jackpotWon,
      jackpotAmount,
      jackpotRoll,
      jackpotPool: finalJackpotPool,
      verification: {
        serverSeedHash,
        serverSeed,  // এখন প্রকাশ করা হলো
        clientSeed,
        nonce,
        rawHash: outcome.rawHash,
        roll: outcome.roll,
        winChance: outcome.winChance,
        jackpotSignature: config.jackpotEnabled && req.amount >= config.jackpotMinBet ? `${clientSeed}:${nonce}:jackpot` : undefined,
        jackpotHash: config.jackpotEnabled && req.amount >= config.jackpotMinBet ? crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:jackpot`).digest('hex') : undefined,
        jackpotRoll: config.jackpotEnabled && req.amount >= config.jackpotMinBet ? jackpotRoll : undefined,
        jackpotHitChance: config.jackpotEnabled && req.amount >= config.jackpotMinBet ? config.jackpotHitChance : undefined
      },
      message,
    };

    // Dispatch game.resolved webhook
    await dispatchWebhook('game.resolved', resultResponse);

    return resultResponse;

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
