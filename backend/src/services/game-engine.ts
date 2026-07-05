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
  resetWinStreak, getWinStreak,
  getStreakBonusAtRisk, addStreakBonusAtRisk, resetStreakBonusAtRisk,
  getStreakBudgetSpent, incrementStreakBudgetSpent
} from '../config/redis';
import { reconcileUser } from './reconciliation-engine';
import { invalidateCache } from './cache';
import { dispatchWebhook } from './webhook';
import {
  determineBalanceSource,
  debitBalanceForBet,
  creditPayout,
  creditWagering,
} from './bonus';
import { getVipRakebackPercent } from './vip';

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
  scatter?: {
    triggered: boolean;
    pickIndex?: number;
    multiplier?: number;
    payout?: number;
    serverSeed?: string;
    clientSeed?: string;
    nonce?: number;
    scatterHash?: string;
  };
  streak?: {
    currentStreak: number;
    rungMultiplier: number;
    ladderBonus: number;
    atRisk: number;
    banked?: number;
    lost?: number;
  };
  lightning?: {
    triggered: boolean;
    multiplier: number;
    extraPayout: number;
    durationSeconds: number;
  };
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

// ── Streak Ladder Helpers ───────────────────────────────────────
interface StreakRung {
  wins: number;
  multiplier: number;
}

function getStreakRungs(config: GameConfig): StreakRung[] {
  return [
    { wins: config.streakRung1Wins, multiplier: config.streakRung1Multiplier },
    { wins: config.streakRung2Wins, multiplier: config.streakRung2Multiplier },
    { wins: config.streakRung3Wins, multiplier: config.streakRung3Multiplier },
    { wins: config.streakRung4Wins, multiplier: config.streakRung4Multiplier },
    { wins: config.streakRung5Wins, multiplier: config.streakRung5Multiplier },
  ].filter(r => r.wins > 0 && r.multiplier > 1).sort((a, b) => a.wins - b.wins);
}

function getCurrentRung(streak: number, rungs: StreakRung[]): StreakRung | null {
  let current: StreakRung | null = null;
  for (const rung of rungs) {
    if (streak >= rung.wins) current = rung;
    else break;
  }
  return current;
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
    const getVipRakebackPercentInline = (wagered: number): number => {
      if (wagered <= 1000) return 0.05;
      if (wagered <= 10000) return 0.10;
      if (wagered <= 50000) return 0.15;
      if (wagered <= 250000) return 0.20;
      return 0.25;
    };

    // ── шаг ৪: ইউজারের ব্যালেন্স চেক করো (Row Lock সহ) ──────────────────────
    const userResult = await client.query(
      'SELECT balance, bonus_balance_coins, withdrawable_balance_coins, total_wagered, pending_rakeback, referred_by FROM users WHERE id = $1 AND is_active = true FOR UPDATE',
      [req.userId]
    );
    if (!userResult.rows.length) throw new Error('ইউজার পাওয়া যায়নি।');

    const currentBalance = parseFloat(userResult.rows[0].balance);
    const totalWagered = parseFloat(userResult.rows[0].total_wagered || '0');
    const pendingRakeback = parseFloat(userResult.rows[0].pending_rakeback || '0');
    const referredBy = userResult.rows[0].referred_by;

    if (currentBalance < req.amount) {
      throw new Error(`অপর্যাপ্ত ব্যালেন্স। আপনার কাছে আছে: $${currentBalance.toFixed(2)}`);
    }

    // Transaction-scoped query wrapper compatible with the bonus service.
    const txClient = client.query.bind(client) as unknown as (
      text: string, params?: unknown[]
    ) => Promise<{ rows: any[]; rowCount: number }>;

    // ── ব্যালেন্স সোর্স নির্ধারণ করো এবং বেট ডেবিট করো ──
    const source = await determineBalanceSource(req.userId, req.amount, txClient);
    await debitBalanceForBet(req.userId, req.amount, source, txClient);

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

    // ── Scatter Bonus Roll (independent of main flip outcome) ──────
    let scatterTriggered = false;
    let scatterMultiplier = 0;
    let scatterPayout = 0;
    let scatterPickIndex = -1;
    let scatterHash = '';
    if (config.scatterEnabled) {
      const scatterSignature = `${clientSeed}:${nonce}:scatter`;
      scatterHash = crypto.createHmac('sha256', serverSeed).update(scatterSignature).digest('hex');
      const rawScatterVal = parseInt(scatterHash.slice(0, 8), 16);
      const scatterRoll = rawScatterVal % config.scatterChance;
      scatterTriggered = scatterRoll === 0; // 1-in-X chance

      if (scatterTriggered) {
        // Use a second hash slice to pick the pre-committed multiplier deterministically.
        const multiplierHash = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:scatter-multiplier`).digest('hex');
        const rawMultiplierVal = parseInt(multiplierHash.slice(0, 8), 16);
        const multiplierRange = config.scatterMaxMultiplier - config.scatterMinMultiplier;
        scatterMultiplier = config.scatterMinMultiplier + (rawMultiplierVal / 0xFFFFFFFF) * multiplierRange;
        scatterMultiplier = parseFloat(scatterMultiplier.toFixed(4));
        scatterPayout = parseFloat((config.scatterStakeUsd * scatterMultiplier).toFixed(8));
        // Pick index (0-2) is not yet chosen by the user; the client will reveal it.
        // For the server response, we store the multiplier and the final pick will
        // be applied by the client picking a coin and the server validating it later.
      }
    }

    // ── Lightning / Mystery Multiplier (independent of outcome) ─────
    let lightning: BetResponse['lightning'] = undefined;
    let lightningExtraPayout = 0;
    if (config.lightningEnabled) {
      const lightningSignature = `${clientSeed}:${nonce}:lightning`;
      const lightningHash = crypto.createHmac('sha256', serverSeed).update(lightningSignature).digest('hex');
      const rawLightningVal = parseInt(lightningHash.slice(0, 8), 16);
      const lightningRoll = rawLightningVal % config.lightningChance;
      const triggered = lightningRoll === 0;

      if (triggered) {
        const multiplierHash = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:lightning-multiplier`).digest('hex');
        const rawMultiplierVal = parseInt(multiplierHash.slice(0, 8), 16);
        const multiplierRange = config.lightningMaxMultiplier - config.lightningMinMultiplier;
        let multiplier = config.lightningMinMultiplier + (rawMultiplierVal / 0xFFFFFFFF) * multiplierRange;
        multiplier = parseFloat(multiplier.toFixed(4));
        // Extra payout is the boosted portion on top of the normal payout.
        lightningExtraPayout = parseFloat(((multiplier - 1) * outcome.payout).toFixed(8));
        const today = new Date().toISOString().slice(0, 10);
        const { getLightningBudgetSpent, incrementLightningBudgetSpent } = await import('../config/redis');
        const spent = await getLightningBudgetSpent(today);
        const remaining = Math.max(0, config.lightningBudgetDailyUsd - spent);
        const cappedExtra = Math.min(lightningExtraPayout, remaining);
        if (cappedExtra > 0) {
          await incrementLightningBudgetSpent(today, cappedExtra);
        }
        lightningExtraPayout = cappedExtra;
        lightning = {
          triggered: true,
          multiplier,
          extraPayout: lightningExtraPayout,
          durationSeconds: config.lightningDurationSeconds,
        };
      }
    }

    // ── Streak Ladder Bonus (budget funded push-your-luck) ─────────────
    let streak: BetResponse['streak'] = undefined;
    let streakBankedAmount = 0;
    let streakLostAmount = 0;
    if (config.streakEnabled) {
      const rungs = getStreakRungs(config);
      const streakBefore = await getWinStreak(req.userId);
      const atRiskBefore = await getStreakBonusAtRisk(req.userId);

      if (won) {
        const streakAfter = streakBefore + 1;
        const rung = getCurrentRung(streakAfter, rungs);
        if (rung) {
          // Top-up = (rungMultiplier - 1) * betAmount. Funded from the daily streak budget.
          const topUp = (rung.multiplier - 1) * req.amount;
          const today = new Date().toISOString().slice(0, 10);
          const budgetSpent = await getStreakBudgetSpent(today);
          const budgetRemaining = Math.max(0, config.streakBudgetDailyUsd - budgetSpent);
          const cappedTopUp = Math.min(topUp, budgetRemaining);
          if (cappedTopUp > 0) {
            await addStreakBonusAtRisk(req.userId, cappedTopUp);
            await incrementStreakBudgetSpent(today, cappedTopUp);
          }
          streak = {
            currentStreak: streakAfter,
            rungMultiplier: rung.multiplier,
            ladderBonus: cappedTopUp,
            atRisk: atRiskBefore + cappedTopUp,
          };
        } else {
          streak = {
            currentStreak: streakAfter,
            rungMultiplier: 1,
            ladderBonus: 0,
            atRisk: atRiskBefore,
          };
        }
      } else {
        // On loss, the entire at-risk bonus is lost and streak resets.
        streakLostAmount = atRiskBefore;
        await resetStreakBonusAtRisk(req.userId);
        streak = {
          currentStreak: 0,
          rungMultiplier: 1,
          ladderBonus: 0,
          atRisk: 0,
          lost: streakLostAmount,
        };
      }
    }

    // ── шаг ৭: ব্যালেন্স ও ওয়াগার/রেকব্যাক আপডেট করো ─────────────────────────────
    // Credit payout back to the same source. The DB trigger sync_user_balance
    // keeps users.balance = bonus_balance_coins + withdrawable_balance_coins.
    if (won) {
      await creditPayout(req.userId, outcome.payout, source, txClient);
    }
    if (lightningExtraPayout > 0) {
      await creditPayout(req.userId, lightningExtraPayout, source, txClient);
    }
    if (jackpotWon) {
      await creditPayout(req.userId, jackpotAmount, source, txClient);
    }

    const newTotalWagered = totalWagered + req.amount;
    const rakebackRate = getVipRakebackPercentInline(newTotalWagered);
    const rakebackAmount = req.amount * (config.houseEdgePercent / 100) * rakebackRate;
    const newPendingRakeback = parseFloat((pendingRakeback + rakebackAmount).toFixed(8));

    await client.query(
      'UPDATE users SET total_wagered = $1, pending_rakeback = $2, updated_at = NOW() WHERE id = $3',
      [newTotalWagered, newPendingRakeback, req.userId]
    );

    // ── Update Referrer's Affiliate Balance ──
    if (referredBy) {
      const referrerResult = await client.query(
        'SELECT pending_affiliate_balance, total_affiliate_earned FROM users WHERE id = $1 FOR UPDATE',
        [referredBy]
      );
      if (referrerResult.rows.length) {
        const currentAffiliatePending = parseFloat(referrerResult.rows[0].pending_affiliate_balance || '0');
        const currentAffiliateTotal = parseFloat(referrerResult.rows[0].total_affiliate_earned || '0');
        
        // Affiliate commission: 10% of the house commission (which is houseEdge% of bet amount)
        const affiliateReward = req.amount * (config.houseEdgePercent / 100) * 0.10;
        const newAffiliatePending = parseFloat((currentAffiliatePending + affiliateReward).toFixed(8));
        const newAffiliateTotal = parseFloat((currentAffiliateTotal + affiliateReward).toFixed(8));
        
        await client.query(
          'UPDATE users SET pending_affiliate_balance = $1, total_affiliate_earned = $2, updated_at = NOW() WHERE id = $3',
          [newAffiliatePending, newAffiliateTotal, referredBy]
        );
      }
    }

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

    // ── শেষ: বেট ডাটাবেসে সেভ করো ────────────────────────────
    const betId = uuidv4();
    await client.query(
      `INSERT INTO bets
        (id, user_id, choice, amount, result, won, payout, house_edge, 
         target_multiplier, actual_multiplier, win_chance, status, flip_hash, resolved_at,
         scatter_hash, scatter_multiplier, scatter_payout, scatter_picked,
         streak_before, streak_after, streak_rung_multiplier, streak_ladder_bonus, streak_at_risk, streak_banked, streak_lost,
         lightning_triggered, lightning_multiplier, lightning_extra_payout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'resolved',$12,NOW(),$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [betId, req.userId, req.choice, req.amount,
       outcome.result, won, outcome.payout, config.houseEdgePercent,
       targetMultiplier, targetMultiplier, outcome.winChance, outcome.rawHash,
       config.scatterEnabled ? scatterHash : null,
       config.scatterEnabled && scatterTriggered ? scatterMultiplier : null,
       config.scatterEnabled && scatterTriggered ? scatterPayout : null,
       false,
       streak?.currentStreak ?? null,
       won ? (streak?.currentStreak ?? null) : 0,
       streak?.rungMultiplier ?? null,
       streak?.ladderBonus ?? null,
       streak?.atRisk ?? null,
       streakBankedAmount || null,
       streakLostAmount || null,
       lightning?.triggered ?? false,
       lightning?.multiplier ?? null,
       lightning?.extraPayout ?? null]
    );

    // Run reconciliation check AFTER creditWagering so bonus/wager counters are committed
    // and the ledger matches the actual balance columns.
    await creditWagering(req.userId, req.amount, txClient);
    await reconcileUser(req.userId, client);

    await client.query('COMMIT');

    // Invalidate caches for updated stats and leaderboards
    const keysToInvalidate = [`cache:stats:${req.userId}`, 'cache:leaderboards', 'cache:stats:active'];
    if (referredBy) {
      keysToInvalidate.push(`cache:stats:${referredBy}`);
      keysToInvalidate.push(`balance:${referredBy}`);
    }
    await invalidateCache(keysToInvalidate).catch(err => {
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

    // Read the final balance from the DB (trigger keeps it synced with source columns).
    const finalBalanceResult = await client.query(
      'SELECT balance FROM users WHERE id = $1',
      [req.userId]
    );
    const newBalance = parseFloat(finalBalanceResult.rows[0]?.balance ?? '0');

    // ── ধাপ ১০: বার্তা তৈরি করো ─────────────────────────────────
    let message = won
      ? `🎉 জিতেছেন! +$${outcome.payout.toFixed(2)} আপনার ওয়ালেটে যোগ হয়েছে।`
      : `😔 হেরেছেন! -$${req.amount.toFixed(2)} বেট।`;
    if (jackpotWon) {
      message += ` 👑 আপনি $${jackpotAmount.toFixed(2)} মূল্যের জ্যাকপট জিতেছেন!`;
    }
    if (streak && streak.ladderBonus > 0) {
      message += ` 🔥 স্ট্রিক বোনাস +$${streak.ladderBonus.toFixed(2)} (x${streak.rungMultiplier.toFixed(2)}) — Bank করুন বা আরও জিতে রিস্ক নিন!`;
    }
    if (streak && streak.lost && streak.lost > 0) {
      message += ` ❌ স্ট্রিক ভেঙে গেছে। $${streak.lost.toFixed(2)} ladder bonus হারিয়ে গেছে।`;
    }

    const resultResponse: BetResponse = {
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
      scatter: config.scatterEnabled ? {
        triggered: scatterTriggered,
        multiplier: scatterTriggered ? scatterMultiplier : undefined,
        payout: scatterTriggered ? scatterPayout : undefined,
        scatterHash,
        serverSeed,
        clientSeed,
        nonce,
      } : undefined,
      streak,
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

// ═══════════════════════════════════════════════════════════════
//  BANK CURRENT STREAK LADDER BONUS
//  User can bank their at-risk bonus anytime, credited immediately.
// ═══════════════════════════════════════════════════════════════
export async function bankStreakBonus(userId: string): Promise<{ banked: number; newBalance: number; message: string }> {
  const atRisk = await getStreakBonusAtRisk(userId);
  if (atRisk <= 0) {
    return { banked: 0, newBalance: 0, message: 'Bank করার জন্য কোনো সক্রিয় স্ট্রিক বোনাস নেই।' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await creditPayout(userId, atRisk, 'withdrawable', client.query.bind(client) as any);

    // Record a streak-bonus transaction
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, metadata, completed_at)
       VALUES ($1, $2, NULL, 'streak_bonus', $3, 'completed', '{}', NOW())`,
      [uuidv4(), userId, atRisk]
    );

    await client.query(
      'UPDATE users SET updated_at = NOW() WHERE id = $1',
      [userId]
    );

    await client.query('COMMIT');

    await resetStreakBonusAtRisk(userId);

    const balanceResult = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    const newBalance = parseFloat(balanceResult.rows[0]?.balance ?? '0');

    return {
      banked: atRisk,
      newBalance,
      message: `✅ $${atRisk.toFixed(2)} স্ট্রিক বোনাস ব্যাংক হয়েছে!`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
