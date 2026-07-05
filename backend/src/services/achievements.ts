/**
 * Achievement engine — computes user progress and unlocks from `bets` table.
 */

import { query, withTransaction } from '../config/database';
import { creditPayout } from './bonus';

export interface AchievementDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  conditionType: string;
  conditionValue: number;
  coinReward: number;
  isActive: boolean;
  sortOrder: number;
}

export interface UserAchievementRow {
  id: string;
  userId: string;
  achievementId: string;
  progress: number;
  unlockedAt: Date | null;
  rewardedAt: Date | null;
  achievement: AchievementDefinition;
}

export async function getAchievements(): Promise<AchievementDefinition[]> {
  const result = await query<AchievementDefinition>(`
    SELECT id, key, name, description, icon, category, condition_type as "conditionType",
           condition_value as "conditionValue", coin_reward as "coinReward",
           is_active as "isActive", sort_order as "sortOrder"
    FROM achievements
    WHERE is_active = true
    ORDER BY sort_order ASC, name ASC
  `);
  return result.rows;
}

export async function computeUserStats(userId: string) {
  const stats = await query(`
    SELECT
      COUNT(*) AS total_bets,
      COUNT(*) FILTER (WHERE won = true) AS total_wins,
      COALESCE(SUM(amount), 0) AS total_wagered,
      COALESCE(SUM(payout) - SUM(amount), 0) AS net_pnl,
      COALESCE(MAX(payout), 0) AS biggest_win
    FROM bets
    WHERE user_id = $1 AND status = 'resolved'
  `, [userId]);

  const streakResult = await query(`
    WITH numbered AS (
      SELECT won,
        ROW_NUMBER() OVER (ORDER BY created_at ASC) -
        ROW_NUMBER() OVER (PARTITION BY won ORDER BY created_at ASC) AS grp
      FROM bets
      WHERE user_id = $1 AND status = 'resolved'
    )
    SELECT COALESCE(MAX(cnt), 0) AS max_win_streak
    FROM (
      SELECT COUNT(*) AS cnt
      FROM numbered
      WHERE won = true
      GROUP BY grp
    ) s
  `, [userId]);

  const s = stats.rows[0];
  return {
    totalBets: parseInt(s.total_bets),
    totalWins: parseInt(s.total_wins),
    totalWagered: parseFloat(s.total_wagered),
    netPnl: parseFloat(s.net_pnl),
    biggestWin: parseFloat(s.biggest_win),
    maxWinStreak: parseInt(streakResult.rows[0].max_win_streak),
  };
}

export async function getUserAchievements(userId: string): Promise<UserAchievementRow[]> {
  const result = await query(`
    SELECT
      ua.id,
      ua.user_id AS "userId",
      ua.achievement_id AS "achievementId",
      ua.progress,
      ua.unlocked_at AS "unlockedAt",
      ua.rewarded_at AS "rewardedAt",
      a.id AS "achievement.id",
      a.key AS "achievement.key",
      a.name AS "achievement.name",
      a.description AS "achievement.description",
      a.icon AS "achievement.icon",
      a.category AS "achievement.category",
      a.condition_type AS "achievement.conditionType",
      a.condition_value AS "achievement.conditionValue",
      a.coin_reward AS "achievement.coinReward",
      a.is_active AS "achievement.isActive",
      a.sort_order AS "achievement.sortOrder"
    FROM user_achievements ua
    JOIN achievements a ON a.id = ua.achievement_id
    WHERE ua.user_id = $1
    ORDER BY a.sort_order ASC, a.name ASC
  `, [userId]);

  return result.rows.map((r: any) => ({
    id: r.id,
    userId: r.userId,
    achievementId: r.achievementId,
    progress: parseFloat(r.progress),
    unlockedAt: r.unlockedAt,
    rewardedAt: r.rewardedAt,
    achievement: {
      id: r['achievement.id'],
      key: r['achievement.key'],
      name: r['achievement.name'],
      description: r['achievement.description'],
      icon: r['achievement.icon'],
      category: r['achievement.category'],
      conditionType: r['achievement.conditionType'],
      conditionValue: parseFloat(r['achievement.conditionValue']),
      coinReward: parseFloat(r['achievement.coinReward']),
      isActive: r['achievement.isActive'],
      sortOrder: r['achievement.sortOrder'],
    },
  }));
}

function getStatValue(stats: Awaited<ReturnType<typeof computeUserStats>>, conditionType: string): number {
  switch (conditionType) {
    case 'total_bets': return stats.totalBets;
    case 'total_wins': return stats.totalWins;
    case 'win_streak': return stats.maxWinStreak;
    case 'total_wagered': return stats.totalWagered;
    case 'net_pnl': return stats.netPnl;
    case 'biggest_win': return stats.biggestWin;
    default: return 0;
  }
}

export async function checkAndUnlockAchievements(userId: string) {
  return withTransaction(async (txQ) => {
    const txQuery = txQ as unknown as typeof query;
    const [achievements, currentRows] = await Promise.all([
      txQuery(`
        SELECT id, key, condition_type, condition_value, coin_reward
        FROM achievements WHERE is_active = true
      `),
      txQuery(`
        SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = $1
      `, [userId]),
    ]);

    const unlockedSet = new Set(currentRows.rows.filter((r: any) => r.unlocked_at).map((r: any) => r.achievement_id));
    const existingSet = new Set(currentRows.rows.map((r: any) => r.achievement_id));
    const stats = await computeUserStats(userId);

    const newlyUnlocked: { id: string; key: string; coinReward: number; name: string }[] = [];

    for (const a of achievements.rows) {
      const progress = getStatValue(stats, a.condition_type);
      const target = parseFloat(a.condition_value);

      if (!existingSet.has(a.id)) {
        await txQuery(
          `INSERT INTO user_achievements (user_id, achievement_id, progress) VALUES ($1, $2, $3)`,
          [userId, a.id, progress]
        );
      } else {
        await txQuery(
          `UPDATE user_achievements SET progress = $3 WHERE user_id = $1 AND achievement_id = $2`,
          [userId, a.id, progress]
        );
      }

      if (progress >= target && !unlockedSet.has(a.id)) {
        await txQuery(
          `UPDATE user_achievements SET unlocked_at = NOW(), rewarded_at = NOW() WHERE user_id = $1 AND achievement_id = $2`,
          [userId, a.id]
        );
        newlyUnlocked.push({ id: a.id, key: a.key, coinReward: parseFloat(a.coin_reward), name: a.key });
      }
    }

    for (const u of newlyUnlocked) {
      if (u.coinReward > 0) {
        await creditPayout(userId, u.coinReward, 'withdrawable');
      }
    }

    return newlyUnlocked;
  });
}

export async function getAchievementStats() {
  const result = await query(`
    SELECT
      a.name,
      a.key,
      COUNT(ua.id) AS total_unlocks,
      COUNT(ua.id) FILTER (WHERE ua.unlocked_at > NOW() - INTERVAL '24 hours') AS unlocks_24h
    FROM achievements a
    LEFT JOIN user_achievements ua ON ua.achievement_id = a.id
    GROUP BY a.id, a.name, a.key
    ORDER BY a.sort_order
  `);
  return result.rows;
}
