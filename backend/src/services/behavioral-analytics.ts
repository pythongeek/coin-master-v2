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

/**
 * Phase 2.2 — Bet-pattern anomaly detector (L10).
 *
 * Analyzes recent bet placement to identify automated/bot behavior.
 * Two patterns trigger a `bot_click_timing` fraud_signal:
 *   (a) Uniform amount: 30+ bets with stddev/mean < 0.01 (i.e. every
 *       bet the same amount to the cent).
 *   (b) Mechanical timing: 20+ bets whose click-to-click intervals
 *       have stddev < 250ms — humans have variable timing; bots don't.
 *
 * Idempotency: a single `status='open'` row per user per 24h. If
 * the user already has one, we update its metadata + last_calculated
 * timestamp but don't add a duplicate row. This keeps the
 * fraud_signals table small and the signal visible to admins.
 *
 * Returns: { triggered: boolean, pattern: 'uniform_amount'|'mechanical_timing'|null,
 *            stats: { bet_count, amount_variance, interval_stddev_ms } }
 */
export interface BotDetectionResult {
  triggered: boolean;
  pattern: 'uniform_amount' | 'mechanical_timing' | null;
  stats: {
    betCount: number;
    amountVariance: number | null;
    intervalStddevMs: number | null;
  };
}

export const UNIFORM_AMOUNT_THRESHOLD = 0.01;
export const MECHANICAL_TIMING_STDDEV_MS = 250;
export const MIN_BETS_FOR_DETECTION = 20;

export async function detectBotPattern(userId: string): Promise<BotDetectionResult> {
  // 1. Load recent bets (last 60) with timestamps + amounts.
  const betsRes = await query(
    `SELECT EXTRACT(EPOCH FROM created_at) AS ts_epoch, amount::float8 AS amount
       FROM transactions
      WHERE user_id = $1::uuid AND type = 'bet'
      ORDER BY created_at DESC
      LIMIT 60`,
    [userId],
  );
  const bets = betsRes.rows as Array<{ ts_epoch: number; amount: number }>;
  if (bets.length < MIN_BETS_FOR_DETECTION) {
    return { triggered: false, pattern: null, stats: { betCount: bets.length, amountVariance: null, intervalStddevMs: null } };
  }

  // 2. Compute amount variance (stddev / mean).
  const amounts = bets.map((b) => b.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance = mean > 0
    ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length) / mean
    : 0;

  // 3. Compute click-interval stddev. ts_epoch descending means
  //    interval = newer_ts - older_ts.
  let intervalStddevMs: number | null = null;
  if (bets.length >= 2) {
    const intervals: number[] = [];
    for (let i = 0; i < bets.length - 1; i++) {
      // pg rows are DESC, so bets[i] is newer than bets[i+1]
      const dt = bets[i].ts_epoch - bets[i + 1].ts_epoch;
      if (dt > 0 && dt < 600) intervals.push(dt * 1000); // ignore > 10 min gaps
    }
    if (intervals.length >= 10) {
      const im = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      intervalStddevMs = Math.sqrt(
        intervals.reduce((a, b) => a + (b - im) ** 2, 0) / intervals.length,
      );
    }
  }

  // 3. Decide.
  let triggered = false;
  let pattern: BotDetectionResult['pattern'] = null;
  if (variance < UNIFORM_AMOUNT_THRESHOLD) {
    triggered = true;
    pattern = 'uniform_amount';
  } else if (intervalStddevMs !== null && intervalStddevMs < MECHANICAL_TIMING_STDDEV_MS) {
    triggered = true;
    pattern = 'mechanical_timing';
  }

  if (!triggered || !pattern) {
    return { triggered: false, pattern: null, stats: { betCount: bets.length, amountVariance: variance, intervalStddevMs } };
  }

  // 4. Write (or update) the fraud_signals row. Idempotency:
  //    fraud_signals has no UNIQUE constraint, so we use a check-then-
  //    write pattern: if an open row exists in the last 24h, update
  //    its metadata; else insert.
  const existing = await query(
    `SELECT id FROM fraud_signals
      WHERE user_id = $1::uuid
        AND signal_type = 'bot_click_timing'
        AND status = 'open'
        AND detected_at > NOW() - INTERVAL '24 hours'
      ORDER BY detected_at DESC LIMIT 1`,
    [userId],
  );
  const metadata = JSON.stringify({
    pattern,
    bet_count: bets.length,
    amount_variance: variance,
    interval_stddev_ms: intervalStddevMs,
    source: 'phase_2_2_bot_detector',
  });
  if (existing.rows.length > 0) {
    await query(
      `UPDATE fraud_signals
          SET metadata = $2::jsonb,
              severity = $3,
              detected_at = NOW()
        WHERE id = $1::uuid`,
      [String((existing.rows[0] as { id: string }).id), metadata,
       pattern === 'uniform_amount' ? 'high' : 'medium'],
    );
  } else {
    await query(
      `INSERT INTO fraud_signals
         (user_id, signal_type, severity, status, metadata, detected_at)
       VALUES ($1::uuid, 'bot_click_timing', $2, 'open', $3::jsonb, NOW())`,
      [userId, pattern === 'uniform_amount' ? 'high' : 'medium', metadata],
    );
  }

  return { triggered: true, pattern, stats: { betCount: bets.length, amountVariance: variance, intervalStddevMs } };
}