/**
 * Phase 2.1 — Behavioral Analytics Service (L09 + L10)
 *
 * Computes per-user behavioral signals from raw gameplay data
 * (transactions table + fraud_signals). These signals feed the
 * risk engine (Phase 1.2) which then turns them into weighted
 * contributions to the user's risk score.
 *
 * Signals computed:
 *   - deposit_to_claim_latency_seconds : time between first deposit
 *       and first bonus claim. < 30s is a strong bot signal.
 *   - bet_amount_variance               : stddev / mean of recent bet
 *       amounts. < 0.01 (i.e. perfectly uniform) is a bot signal.
 *   - avg_bet_amount_coins               : for cross-checking variance.
 *   - bets_per_minute_avg                : session velocity.
 *   - session_duration_avg_minutes       : how long a "session" lasts.
 *   - game_variety_index                 : number of distinct game
 *       types played. 1 = played only one game.
 *   - only_bonus_bets                     : boolean — every bet was
 *       funded by bonus_balance (vs withdrawable_balance).
 *   - bot_click_timing                   : boolean — fraud_signals
 *       row of type 'bot_click_timing' or click-interval variance
 *       below threshold from bot-detector service (Phase 2.2 adds
 *       the real detector; for now we mirror what Phase 1.2 already
 *       reads via fraud_signals).
 *
 * All functions are read-only queries + lightweight math. No writes.
 */

import { query } from '../config/database';

export interface BehavioralSignals {
  depositToClaimLatencySec: number | null;
  betAmountVariance: number | null;
  avgBetAmountCoins: number | null;
  betsPerMinuteAvg: number | null;
  sessionDurationAvgMinutes: number | null;
  gameVarietyIndex: number | null;
  onlyBonusBets: boolean;
  botClickTiming: boolean;
  totalBetsLast24h: number;
  totalDepositsLast7d: number;
  computedAt: Date;
}

/**
 * Compute all behavioral signals for a user. Cheap (8 small SELECTs,
 * no joins larger than indexed). Safe to call from /api/admin/fraud/*
 * endpoints on every render.
 *
 * All math happens in SQL where possible (STDDEV, EXTRACT) so the
 * node-side work is minimal.
 */
export async function computeBehavioralSignals(userId: string): Promise<BehavioralSignals> {
  const result: BehavioralSignals = {
    depositToClaimLatencySec: null,
    betAmountVariance: null,
    avgBetAmountCoins: null,
    betsPerMinuteAvg: null,
    sessionDurationAvgMinutes: null,
    gameVarietyIndex: null,
    onlyBonusBets: false,
    botClickTiming: false,
    totalBetsLast24h: 0,
    totalDepositsLast7d: 0,
    computedAt: new Date(),
  };

  // 1. Deposit-to-claim latency. First deposit's created_at → first
  //    bonus claim's claimed_at. EXTRACT EPOCH gives seconds.
  const latencyRes = await query(
    `SELECT EXTRACT(EPOCH FROM (bc.claimed_at - d.created_at))::int AS seconds
       FROM transactions d
       JOIN bonus_claims bc ON bc.user_id = d.user_id
      WHERE d.user_id = $1::uuid
        AND d.type = 'deposit'
        AND bc.claimed_at > d.created_at
      ORDER BY d.created_at ASC, bc.claimed_at ASC
      LIMIT 1`,
    [userId],
  );
  if (latencyRes.rows.length > 0) {
    const v = (latencyRes.rows[0] as { seconds: number | null }).seconds;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      result.depositToClaimLatencySec = Math.round(v);
    }
  }

  // 2. Bet amount variance + mean (last 50 bets).
  const betStats = await query(
    `SELECT
       COALESCE(STDDEV(amount), 0)::float8 AS stddev,
       COALESCE(AVG(amount), 0)::float8    AS mean,
       COUNT(*)::int                       AS n
     FROM (
       SELECT amount FROM transactions
        WHERE user_id = $1::uuid AND type = 'bet'
        ORDER BY created_at DESC LIMIT 50
     ) recent`,
    [userId],
  );
  const bs = betStats.rows[0] as { stddev: number; mean: number; n: number };
  if (bs.n >= 3 && bs.mean > 0) {
    result.betAmountVariance = Number((bs.stddev / bs.mean).toFixed(6));
    result.avgBetAmountCoins = Number(bs.mean.toFixed(6));
  }

  // 3. Bets per minute (last 24h) + session duration. Session = a run
  //    of bets within 30 minutes of each other. Approximation: take
  //    the time gap between min and max bet created_at over the last
  //    100 bets and divide.
  const speedRes = await query(
    `SELECT
       COUNT(*)::int AS n,
       EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::int AS span_seconds
     FROM (
       SELECT created_at FROM transactions
        WHERE user_id = $1::uuid AND type = 'bet'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 100
     ) recent`,
    [userId],
  );
  const sp = speedRes.rows[0] as { n: number; span_seconds: number | null };
  if (sp.n > 0) {
    result.totalBetsLast24h = sp.n;
    const span = sp.span_seconds ?? 0;
    if (span > 60) {
      result.betsPerMinuteAvg = Number(((sp.n / span) * 60).toFixed(3));
      result.sessionDurationAvgMinutes = Number((span / 60).toFixed(2));
    }
  }

  // 4. Game variety index. Count distinct metadata.game_type values
  //    in bet rows. Without game_type column, fall back to counting
  //    distinct minutes-with-bets (rough proxy: "1 variety" = "always
  //    same game per minute"). Simplest: count distinct metadata keys.
  const varietyRes = await query(
    `SELECT
       COUNT(DISTINCT metadata->>'game_type')::int AS n
     FROM transactions
     WHERE user_id = $1::uuid AND type = 'bet'
       AND created_at > NOW() - INTERVAL '7 days'
       AND metadata->>'game_type' IS NOT NULL`,
    [userId],
  );
  const vRow = varietyRes.rows[0] as { n: number };
  // If metadata.game_type is null (legacy rows), treat variety as 1
  // to keep the signal meaningful. Future rows with game_type set will
  // override.
  result.gameVarietyIndex = vRow.n > 0 ? vRow.n : 1;

  // 5. only_bonus_bets: every bet was funded from bonus_balance.
  //    We approximate by checking if the user's bonus_balance_coins
  //    went DOWN alongside bet volume but withdrawable didn't move.
  //    A cleaner test would join each bet to a balance snapshot; for
  //    now, this is a useful proxy: if bets > bonus_withdrawn, suspect.
  const balanceRes = await query(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE user_id = $1::uuid AND type = 'bet')::int AS total_bets,
       GREATEST(0, COALESCE(total_bonus_claimed_coins, 0) - COALESCE(wagering_required_coins, 0))::float8 AS bonus_left,
       (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = $1::uuid AND type = 'bet')::float8 AS bet_volume
     FROM users WHERE id = $1::uuid`,
    [userId],
  );
  const br = balanceRes.rows[0] as { total_bets: number; bonus_left: number; bet_volume: number };
  result.onlyBonusBets = br.total_bets > 0
    && br.bet_volume > 0
    && br.bonus_left <= 0
    && br.total_bets >= 3;

  // 6. bot_click_timing: look for a fraud_signals row of that type
  //    in the last 24h. If Phase 2.2 (bot-pattern detector) writes
  //    them, this auto-picks them up.
  const botRes = await query(
    `SELECT 1 FROM fraud_signals
      WHERE user_id = $1::uuid
        AND signal_type = 'bot_click_timing'
        AND detected_at > NOW() - INTERVAL '24 hours'
      LIMIT 1`,
    [userId],
  );
  result.botClickTiming = botRes.rows.length > 0;

  // 7. Total deposits in last 7 days (context: how active is the user?).
  const depRes = await query(
    `SELECT COUNT(*)::int AS n FROM transactions
      WHERE user_id = $1::uuid AND type = 'deposit'
        AND created_at > NOW() - INTERVAL '7 days'`,
    [userId],
  );
  result.totalDepositsLast7d = (depRes.rows[0] as { n: number }).n;

  return result;
}

/**
 * Wire the computed behavioral signals into the risk engine context.
 * Returns a partial UserContext that callers can merge with their own
 * loadUserContext() result.
 */
export async function getBehavioralContext(userId: string): Promise<{
  depositToClaimLatencySec: number | null;
  betAmountVariance: number | null;
  onlyBonusBets: boolean;
  botLikeClickTiming: boolean;
}> {
  const s = await computeBehavioralSignals(userId);
  return {
    depositToClaimLatencySec: s.depositToClaimLatencySec,
    betAmountVariance: s.betAmountVariance,
    onlyBonusBets: s.onlyBonusBets,
    botLikeClickTiming: s.botClickTiming,
  };
}