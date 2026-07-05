/**
 * Leaderboard service — wagering volume tournaments with auto prize distribution.
 */

import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';
import { creditPayout } from './bonus';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  totalWagered: number;
  totalBets: number;
  prize: number;
}

export async function getLeaderboard(period: 'daily' | 'weekly' = 'daily'): Promise<LeaderboardEntry[]> {
  const config = await getConfig();
  if (!config.leaderboardEnabled) return [];

  const interval = period === 'weekly' ? '7 days' : '1 day';
  const result = await query(
    `
    SELECT
      u.id AS user_id,
      u.username,
      COALESCE(SUM(b.amount), 0) AS total_wagered,
      COUNT(b.id) AS total_bets
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
      AND b.status = 'resolved'
      AND b.created_at > NOW() - INTERVAL '${interval}'
    GROUP BY u.id, u.username
    HAVING COALESCE(SUM(b.amount), 0) > 0
    ORDER BY total_wagered DESC
    LIMIT 50
    `,
  );

  const prizes = config.leaderboardPrizes || [];
  return result.rows.map((r: any, idx: number) => {
    const rank = idx + 1;
    const prizeConfig = prizes.find((p: any) => p.rank === rank);
    return {
      rank,
      userId: r.user_id,
      username: r.username,
      totalWagered: parseFloat(r.total_wagered),
      totalBets: parseInt(r.total_bets),
      prize: prizeConfig ? prizeConfig.prize : 0,
    };
  });
}

export async function getLeaderboardPosition(userId: string, period: 'daily' | 'weekly' = 'daily') {
  const leaderboard = await getLeaderboard(period);
  const position = leaderboard.find((e) => e.userId === userId);
  return {
    position: position ? position.rank : null,
    totalWagered: position ? position.totalWagered : 0,
    prize: position ? position.prize : 0,
  };
}

export async function distributeLeaderboardPrizes(period: 'daily' | 'weekly' = 'daily') {
  const config = await getConfig();
  if (!config.leaderboardEnabled) return { distributed: 0, total: 0 };

  return withTransaction(async (txQ) => {
    const txQuery = txQ as any;
    const interval = period === 'weekly' ? '7 days' : '1 day';

    const result = await txQuery(
      `
      SELECT
        u.id AS user_id,
        COALESCE(SUM(b.amount), 0) AS total_wagered
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
        AND b.status = 'resolved'
        AND b.created_at > NOW() - INTERVAL '${interval}'
      GROUP BY u.id
      HAVING COALESCE(SUM(b.amount), 0) > 0
      ORDER BY total_wagered DESC
      LIMIT 50
      `
    );

    const prizes = config.leaderboardPrizes || [];
    let total = 0;
    let distributed = 0;

    for (let i = 0; i < result.rows.length; i++) {
      const rank = i + 1;
      const prizeConfig = prizes.find((p: any) => p.rank === rank);
      if (!prizeConfig || prizeConfig.prize <= 0) continue;

      const userId = result.rows[i].user_id;
      await creditPayout(userId, prizeConfig.prize, 'withdrawable', txQuery);
      await txQuery(
        `INSERT INTO leaderboard_prizes (user_id, period, rank, amount, distributed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, period, rank, prizeConfig.prize]
      );
      total += prizeConfig.prize;
      distributed++;
    }

    return { distributed, total };
  });
}

export async function getLeaderboardStats() {
  const result = await query(`
    SELECT
      COUNT(*) AS total_prizes,
      COALESCE(SUM(amount), 0) AS total_given,
      COUNT(*) FILTER (WHERE distributed_at > NOW() - INTERVAL '24 hours') AS prizes_24h
    FROM leaderboard_prizes
  `);
  return result.rows[0];
}
