/**
 * Rakeback / Cashback service
 * Wager-based rebates that users can claim as withdrawable coins.
 */

import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';
import { getVipRakebackPercent } from './vip';
import { creditPayout } from './bonus';

export interface RakebackStatus {
  pending: number;
  claimed: number;
  totalWagered: number;
  rate: number;
  canClaim: boolean;
  minClaim: number;
}

export async function getRakebackStatus(userId: string): Promise<RakebackStatus> {
  const config = await getConfig();
  if (!config.rakebackEnabled) {
    return { pending: 0, claimed: 0, totalWagered: 0, rate: 0, canClaim: false, minClaim: 0 };
  }

  const [wagerResult, claimedResult] = await Promise.all([
    query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_wagered
      FROM bets
      WHERE user_id = $1 AND status = 'resolved'
        AND created_at > NOW() - INTERVAL '24 hours'
      `,
      [userId]
    ),
    query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_claimed
      FROM rakeback_claims
      WHERE user_id = $1 AND claimed_at > NOW() - INTERVAL '24 hours'
      `,
      [userId]
    ),
  ]);

  const totalWagered = parseFloat(wagerResult.rows[0].total_wagered);
  const claimed = parseFloat(claimedResult.rows[0].total_claimed);
  const vipRate = getVipRakebackPercent(totalWagered);
  const rate = config.rakebackPercent * config.rakebackVipMultiplier + vipRate;
  const pending = Math.max(0, totalWagered * (rate / 100) - claimed);
  const canClaim = pending >= config.rakebackMinClaimCoins;

  return {
    pending,
    claimed,
    totalWagered,
    rate,
    canClaim,
    minClaim: config.rakebackMinClaimCoins,
  };
}

export async function claimRakeback(userId: string): Promise<RakebackStatus> {
  const config = await getConfig();
  if (!config.rakebackEnabled) {
    throw new Error('Rakeback is currently disabled');
  }

  return withTransaction(async (txQ) => {
    const txQuery = txQ as any;

    const [wagerResult, claimedResult] = await Promise.all([
      txQuery(
        `
        SELECT COALESCE(SUM(amount), 0) AS total_wagered
        FROM bets
        WHERE user_id = $1 AND status = 'resolved'
          AND created_at > NOW() - INTERVAL '24 hours'
        `,
        [userId]
      ),
      txQuery(
        `
        SELECT COALESCE(SUM(amount), 0) AS total_claimed
        FROM rakeback_claims
        WHERE user_id = $1 AND claimed_at > NOW() - INTERVAL '24 hours'
        `,
        [userId]
      ),
    ]);

    const totalWagered = parseFloat(wagerResult.rows[0].total_wagered);
    const claimed = parseFloat(claimedResult.rows[0].total_claimed);
    const vipRate = getVipRakebackPercent(totalWagered);
    const rate = config.rakebackPercent * config.rakebackVipMultiplier + vipRate;
    const pending = Math.max(0, totalWagered * (rate / 100) - claimed);

    if (pending < config.rakebackMinClaimCoins) {
      throw new Error(`Minimum claim amount is ${config.rakebackMinClaimCoins} coins`);
    }

    await creditPayout(userId, pending, 'withdrawable', txQuery);
    await txQuery(
      `INSERT INTO rakeback_claims (user_id, amount, claimed_at) VALUES ($1, $2, NOW())`,
      [userId, pending]
    );

    const newStatus = await getRakebackStatus(userId);
    return newStatus;
  });
}

export async function getRakebackStats(): Promise<{ total_claimed: string; total_claims: string; claims_24h: string }> {
  const result = await query(`
    SELECT
      COALESCE(SUM(amount), 0) AS total_claimed,
      COUNT(*) AS total_claims,
      COUNT(*) FILTER (WHERE claimed_at > NOW() - INTERVAL '24 hours') AS claims_24h
    FROM rakeback_claims
  `);
  return result.rows[0] as any;
}
