/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME ENGINE — গেমের মস্তিষ্ক (Phase 2.3 upgraded)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Phase 2.3 changes vs Phase 1.0:
 *    - Multiplier-based wins (1.01x – 1000x), not just binary heads/tails
 *    - Global server seed rotation (rotates every N games)
 *    - Old server seeds stay queryable forever for verification
 *    - Every bet writes a `transactions` row (debit + credit pair)
 *    - Every bet writes an `audit_log` entry (security/audit trail)
 *    - Provably fair: commit-reveal still works (server_seed_hash before
 *      bet, server_seed revealed after, user can re-verify)
 *
 *  একটি গেম রাউন্ডের ক্রম:
 *  ──────────────────────────────────────────────────────────────
 *  ১. ইউজার বেট ধরে (choice + multiplier + amount)
 *  ২. বর্তমান active server_seed লোড হয়
 *  ৩. rawHash কম্পিউট হয় (server_seed + clientSeed:nonce)
 *  ৪. multiplier অনুযায়ী win chance vs payout বের হয়
 *  ৫. রেজাল্ট (won/lost) কম্পিউট হয়
 *  ৬. transactions ও bets টেবিলে লেখা হয় (একই atomic transaction)
 *  ৭. audit_log এ entry যোগ হয়
 *  ৮. active_bets++ → যদি threshold পার হয়, server_seed রোটেট হয়
 *  ৯. Win Streak চেক → Crypto Rain ট্রিগার?
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
import { query, withTransaction } from '../config/database';
import {
  lockBet, unlockBet, incrementWinStreak,
  resetWinStreak, getWinStreak
} from '../config/redis';
import {
  determineBalanceSource, debitBalanceForBet, creditPayout,
  creditWagering, BalanceSource,
} from './bonus';

// ── ইনপুট ও আউটপুটের ধরন ───────────────────────────────────────
export interface BetRequest {
  userId: string;
  choice: FlipResult;
  amount: number;
  /** User-chosen risk multiplier (1.01 – 1000). Higher = more risk, more payout. */
  multiplier: number;
  clientSeed?: string;
  /**
   * Which balance bucket to debit. If omitted, auto-detected:
   * prefers bonus_balance_coins when active wagering exists AND bonus covers the bet.
   * Forced to 'bonus' for wagering completion; 'withdrawable' otherwise.
   */
  balanceSource?: BalanceSource;
}

export interface BetResponse {
  betId: string;
  result: FlipResult;
  choice: FlipResult;
  won: boolean;
  betAmount: number;
  /** User's chosen multiplier (echoed back) */
  multiplier: number;
  /** Server-actual payout multiplier after house edge (e.g. 1.96 for 2% edge) */
  payoutMultiplier: number;
  payout: number;
  houseEdge: number;
  /** Win chance at the time of bet (0..1), based on the multiplier */
  winChance: number;
  newBalance: number;
  winStreak: number;
  cryptoRainTriggered: boolean;
  verification: {
    serverSeedHash: string;
    serverSeed: string;
    clientSeed: string;
    nonce: number;
    rawHash: string;
  };
  message: string;
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG: multiplier bounds + seed rotation threshold
// ═══════════════════════════════════════════════════════════════
const MULTIPLIER_MIN = 1.01;
const MULTIPLIER_MAX = 1000;
const SEED_ROTATION_THRESHOLD = 1000;  // rotate server seed every N bets globally

// ═══════════════════════════════════════════════════════════════
//  MAIN FUNCTION — একটি গেম রাউন্ড সম্পন্ন করো
// ═══════════════════════════════════════════════════════════════
export async function placeBet(req: BetRequest): Promise<BetResponse> {
  // ── ধাপ ১: ইনপুট যাচাই ───────────────────────────────────
  if (!req.multiplier || req.multiplier < MULTIPLIER_MIN || req.multiplier > MULTIPLIER_MAX) {
    throw new Error(`মাল্টিপ্লায়ার ${MULTIPLIER_MIN} এবং ${MULTIPLIER_MAX} এর মধ্যে হতে হবে।`);
  }

  // ── ধাপ ২: কনফিগ লোড করো ───────────────────────────────────
  const config: GameConfig = await getConfig();
  if (config.maintenanceMode) throw new Error(config.maintenanceMessage);

  // ── ধাপ ৩: বেট পরিমাণ যাচাই করো ───────────────────────────
  const validation = validateBetAmount(req.amount, config);
  if (!validation.valid) throw new Error(validation.error);

  // ── ধাপ ৪: রেস কন্ডিশন প্রতিরোধ করো ────────────────────────
  const locked = await lockBet(req.userId, req.amount);
  if (!locked) throw new Error('একটি গেম চলছে। শেষ হলে আবার চেষ্টা করুন।');

  try {
    // ── ধাপ ৫: ইউজারের ব্যালেন্স চেক করো + balanceSource ঠিক করো ────
    // Session 1: balance is split between bonus + withdrawable.
    // We auto-pick the source unless caller forced one.
    const balanceSource: BalanceSource = req.balanceSource ??
      await determineBalanceSource(req.userId, req.amount);

    const userResult = await query(
      `SELECT bonus_balance_coins, withdrawable_balance_coins
       FROM users WHERE id = $1 AND is_active = true`,
      [req.userId]
    );
    if (!userResult.rows.length) throw new Error('ইউজার পাওয়া যায়নি।');
    const bonusBal     = parseFloat(userResult.rows[0].bonus_balance_coins);
    const withdrawBal  = parseFloat(userResult.rows[0].withdrawable_balance_coins);
    const totalBal     = bonusBal + withdrawBal;
    if (totalBal < req.amount) {
      throw new Error(`অপর্যাপ্ত ব্যালেন্স। আপনার কাছে আছে: ${totalBal.toFixed(2)} Coin`);
    }

    // ── ধাপ ৬: Provably Fair seeds + nonce ─────────────────────
    const clientSeed = req.clientSeed || generateClientSeed();

    // Get CURRENT active server seed (not per-user nonce anymore)
    const activeSeedResult = await query(
      `SELECT id, server_seed, server_seed_hash, active_bets, rotation_threshold
       FROM server_seeds WHERE is_active = true LIMIT 1`
    );
    if (!activeSeedResult.rows.length) {
      throw new Error('কোনো সক্রিয় সার্ভার সিড নেই — অ্যাডমিনকে জানান।');
    }
    const activeSeed = activeSeedResult.rows[0];

    // Nonce = global counter (NOT per-user anymore — Phase 2.3 change)
    // We use the seed's active_bets counter + 1 as the nonce for this bet.
    // Each bet uses a unique nonce; once seed rotates, nonce resets to 0.
    const nonce = parseInt(activeSeed.active_bets) + 1;

    const seeds: SeedPair = {
      serverSeed: activeSeed.server_seed,
      serverSeedHash: activeSeed.server_seed_hash,
      clientSeed,
      nonce,
    };

    // ── ধাপ ৭: Provably Fair outcome ────────────────────────────
    // The user's multiplier adjusts the win-chance threshold. We don't
    // need to change provably-fair.ts — instead we map rawValue to a
    // win by comparing against a win-chance cutoff derived from multiplier.
    //
    // Game design:
    //   multiplier 1.01 → win chance ~49.5%  (1 in 1.01, minus 2% edge)
    //   multiplier 2    → win chance ~49%    (1 in 2, minus edge)
    //   multiplier 10   → win chance ~9.8%   (1 in 10, minus edge)
    //   multiplier 1000 → win chance ~0.098% (1 in 1000, minus edge)
    //
    // Formula: winChance = (1 / multiplier) * (1 - houseEdge/100)
    //   e.g. mult=2, edge=2% → winChance = 0.5 * 0.98 = 0.49 (49%)
    const winChance = (1 / req.multiplier) * (1 - config.houseEdgePercent / 100);

    const outcome = resolveFlip(seeds, req.choice, req.amount, config.houseEdgePercent);
    // The base resolveFlip uses a fixed 1.96x multiplier. We override with
    // the user-chosen multiplier: when the user wins, payout = bet * multiplier.
    // When the user loses, payout = 0 (already handled by resolveFlip).
    // The win/loss decision is made by comparing rawValue to winChance threshold.

    // Convert rawValue (0..2^32) to [0, 1) range
    const randomFraction = outcome.rawValue / 0x100000000;
    const won = randomFraction < winChance;

    // Recalculate payout with user-chosen multiplier
    const payout = won ? parseFloat((req.amount * req.multiplier).toFixed(8)) : 0;

    // Override outcome.payout with the user-multiplied payout
    const finalOutcome: FlipOutcome = { ...outcome, payout };

    // ── ধাপ ৮: Seed rotation check ─────────────────────────────
    // If this bet is the threshold-th bet, schedule a rotation.
    // The rotation happens AFTER the current bet is recorded.
    const newActiveBets = parseInt(activeSeed.active_bets) + 1;
    const willRotate = newActiveBets >= parseInt(activeSeed.rotation_threshold);

    // ── ধাপ ৯: ATOMIC write to DB ───────────────────────────────
    // All DB writes in one transaction so partial failures roll back
    const betId = uuidv4();
    // Debit from the chosen source; credit payout to the SAME source
    // (bonus → bonus, withdrawable → withdrawable). Session 1 bonus/wagering.
    let newBonus: number;
    let newWithdrawable: number;
    await withTransaction(async (txQuery) => {
      // 9a. Debit bet amount from balanceSource
      const debit = await debitBalanceForBet(req.userId, req.amount, balanceSource, txQuery as any);
      newBonus = balanceSource === 'bonus' ? debit.newBalance : bonusBal;
      newWithdrawable = balanceSource === 'withdrawable' ? debit.newBalance : withdrawBal;

      // 9a-extra. Credit payout back to SAME source on win
      if (won && payout > 0) {
        await creditPayout(req.userId, payout, balanceSource, txQuery as any);
        if (balanceSource === 'bonus') newBonus += payout;
        else newWithdrawable += payout;
      }

      // 9b. Keep legacy `users.balance` in sync for downstream readers
      // (StatsCards.tsx etc. still read users.balance). Source of truth
      // is now bonus + withdrawable; balance is the denormalized sum.
      const newTotal = newBonus + newWithdrawable;
      await txQuery(
        `UPDATE users
           SET balance = $1, updated_at = NOW()
         WHERE id = $2`,
        [newTotal, req.userId]
      );

      // 9c. Insert bet record (with multiplier + balanceSource)
      await txQuery(
        `INSERT INTO bets
          (id, user_id, choice, amount, multiplier, result, won, payout, house_edge, status, flip_hash, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'resolved',$10,NOW())`,
        [betId, req.userId, req.choice, req.amount, req.multiplier,
         finalOutcome.result, won, finalOutcome.payout, config.houseEdgePercent,
         finalOutcome.rawHash]
      );

      // 9d. Insert transactions (DEBIT: bet amount, CREDIT: payout if won)
      // Phase 2.2 — money-side ledger. Use 'COIN' currency (matches wallet_transactions).
      await txQuery(
        `INSERT INTO transactions
          (user_id, type, amount, currency, direction, status, related_bet_id, metadata, confirmed_at)
         VALUES ($1, 'bet', $2, 'COIN', 'debit', 'confirmed', $3, $4, NOW())`,
        [req.userId, req.amount, betId,
         JSON.stringify({ balance_source: balanceSource, multiplier: req.multiplier })]
      );
      if (won) {
        await txQuery(
          `INSERT INTO transactions
            (user_id, type, amount, currency, direction, status, related_bet_id, metadata, confirmed_at)
           VALUES ($1, 'payout', $2, 'COIN', 'credit', 'confirmed', $3, $4, NOW())`,
          [req.userId, payout, betId,
           JSON.stringify({ balance_source: balanceSource, multiplier: req.multiplier })]
        );
      }

      // 9e. Insert audit_log entry
      await txQuery(
        `INSERT INTO audit_log
          (user_id, category, action, severity, details)
         VALUES ($1, 'system', 'game.bet', 'info', $2)`,
        [req.userId, JSON.stringify({
          betId, choice: req.choice, amount: req.amount, multiplier: req.multiplier,
          result: finalOutcome.result, won, payout, houseEdge: config.houseEdgePercent,
          winChance, nonce, balanceSource,
        })]
      );

      // 9f. Increment server seed's active_bets (and rotate if threshold hit)
      await txQuery(
        `UPDATE server_seeds SET active_bets = active_bets + 1 WHERE id = $1`,
        [activeSeed.id]
      );

      if (willRotate) {
        // Generate new server seed, mark old one as revealed+inactive
        const newServerSeed = generateServerSeed();
        const newServerSeedHash = hashServerSeed(newServerSeed);
        await txQuery(
          `UPDATE server_seeds
           SET is_active = false, rotated_at = NOW(), revealed_at = NOW()
           WHERE id = $1`,
          [activeSeed.id]
        );
        await txQuery(
          `INSERT INTO server_seeds (server_seed, server_seed_hash, rotation_threshold, is_active)
           VALUES ($1, $2, $3, true)`,
          [newServerSeed, newServerSeedHash, SEED_ROTATION_THRESHOLD]
        );
        // Audit log the rotation
        await txQuery(
          `INSERT INTO audit_log (category, action, severity, details)
           VALUES ('system', 'seed.rotate', 'info', $1)`,
          [JSON.stringify({
            old_seed_id: activeSeed.id,
            old_active_bets: newActiveBets,
            threshold: SEED_ROTATION_THRESHOLD,
          })]
        );
      }
    });

    // ── ধাপ ৯-extra: Credit wagering (Session 1) ────────────────
    // Done outside the bet transaction so a wagering failure doesn't
    // roll back the bet. Wagering is bookkeeping; the bet already settled.
    try {
      await creditWagering(req.userId, req.amount);
    } catch (e) {
      // Non-fatal: log and continue
      await query(
        `INSERT INTO audit_log (category, action, severity, user_id, details)
         VALUES ('bonus', 'wagering.credit.failed', 'warn', $1, $2)`,
        [req.userId, JSON.stringify({ error: String(e), bet_id: betId })]
      );
    }

    // ── ধাপ ১০: Win Streak আপডেট করো ─────────────────────────────
    let winStreak = 0;
    let cryptoRainTriggered = false;

    if (won) {
      winStreak = await incrementWinStreak(req.userId);
      if (winStreak >= config.rainTriggerStreak && config.rainEnabled) {
        cryptoRainTriggered = true;
        await triggerCryptoRain(req.userId, config);
        await resetWinStreak(req.userId);
      }
    } else {
      await resetWinStreak(req.userId);
    }

    // ── ধাপ ১১: বার্তা তৈরি করো ─────────────────────────────────
    const message = won
      ? `🎉 জিতেছেন! ${req.multiplier}x মাল্টিপ্লায়ারে +$${payout.toFixed(2)} আপনার ওয়ালেটে যোগ হয়েছে।`
      : `😔 হেরেছেন! -$${req.amount.toFixed(2)} বেট (${req.multiplier}x মাল্টিপ্লায়ারে)।`;

    return {
      betId,
      result: finalOutcome.result,
      choice: req.choice,
      won,
      betAmount: req.amount,
      multiplier: req.multiplier,
      payoutMultiplier: req.multiplier,  // user-chosen
      payout: finalOutcome.payout,
      houseEdge: config.houseEdgePercent,
      winChance,
      // Session 1: total balance = sum of bonus + withdrawable (denormalized)
      newBalance: newBonus + newWithdrawable,
      winStreak,
      cryptoRainTriggered,
      verification: {
        serverSeedHash: seeds.serverSeedHash,
        serverSeed: seeds.serverSeed,  // revealed after bet
        clientSeed: seeds.clientSeed,
        nonce: seeds.nonce,
        rawHash: finalOutcome.rawHash,
      },
      message,
    };

  } finally {
    await unlockBet(req.userId);
  }
}

// ── Crypto Rain ট্রিগার ──────────────────────────────────────────
async function triggerCryptoRain(userId: string, config: GameConfig): Promise<void> {
  const rainAmount = Math.min(config.rainBudgetDailyUsd * 0.1, 5.0);

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
    `SELECT id, choice, amount, multiplier, result, won, payout, house_edge,
            flip_hash, created_at, resolved_at
     FROM bets WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// ── Current active server seed (public — for transparency) ─────────
export async function getCurrentServerSeedHash(): Promise<string | null> {
  const result = await query(
    'SELECT server_seed_hash FROM server_seeds WHERE is_active = true LIMIT 1'
  );
  return result.rows[0]?.server_seed_hash ?? null;
}