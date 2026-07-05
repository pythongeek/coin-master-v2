/**
 * Challenges / Missions service
 * Daily configurable missions with auto-reward on completion.
 */

import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';
import { creditPayout } from './bonus';

export interface Challenge {
  id: string;
  label: string;
  target: number;
  reward: number;
  metric: 'wager' | 'wins' | 'bets' | 'streak';
}

export interface ChallengeProgress {
  id: string;
  label: string;
  target: number;
  current: number;
  reward: number;
  completed: boolean;
  claimed: boolean;
}

export async function getChallengeDefinitions(): Promise<Challenge[]> {
  const config = await getConfig();
  return config.challengesEnabled ? config.dailyChallenges : [];
}

export async function getUserChallengeProgress(userId: string): Promise<ChallengeProgress[]> {
  const challenges = await getChallengeDefinitions();
  if (!challenges.length) return [];

  const [wagerResult, winsResult, betsResult, streakResult] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM bets WHERE user_id = $1 AND status = 'resolved' AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total FROM bets WHERE user_id = $1 AND status = 'resolved' AND result = 'win' AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total FROM bets WHERE user_id = $1 AND status = 'resolved' AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    ),
    getLongestWinStreak(userId),
  ]);

  const metrics: Record<string, number> = {
    wager: parseFloat(wagerResult.rows[0].total),
    wins: parseInt(winsResult.rows[0].total),
    bets: parseInt(betsResult.rows[0].total),
    streak: streakResult,
  };

  const progressResult = await query(
    `SELECT challenge_id, claimed_at FROM challenge_progress WHERE user_id = $1 AND progress_date = CURRENT_DATE`,
    [userId]
  );
  const claimedMap = new Map<string, string | null>();
  for (const row of progressResult.rows) {
    claimedMap.set(row.challenge_id, row.claimed_at);
  }

  return challenges.map((c) => {
    const current = metrics[c.metric] || 0;
    const completed = current >= c.target;
    const claimedAt = claimedMap.get(c.id);
    return {
      id: c.id,
      label: c.label,
      target: c.target,
      current,
      reward: c.reward,
      completed,
      claimed: !!claimedAt,
    };
  });
}

async function getLongestWinStreak(userId: string): Promise<number> {
  const result = await query(
    `SELECT result FROM bets WHERE user_id = $1 AND status = 'resolved' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at ASC`,
    [userId]
  );
  let maxStreak = 0;
  let current = 0;
  for (const row of result.rows) {
    if (row.result === 'win') {
      current++;
      maxStreak = Math.max(maxStreak, current);
    } else {
      current = 0;
    }
  }
  return maxStreak;
}

export async function claimChallengeReward(userId: string, challengeId: string): Promise<ChallengeProgress[]> {
  const challenges = await getChallengeDefinitions();
  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) throw new Error('Challenge not found');

  const progress = await getUserChallengeProgress(userId);
  const item = progress.find((p) => p.id === challengeId);
  if (!item) throw new Error('Progress not found');
  if (!item.completed) throw new Error('Challenge not completed');
  if (item.claimed) throw new Error('Reward already claimed');

  return withTransaction(async (txQ) => {
    const txQuery = txQ as any;
    await creditPayout(userId, challenge.reward, 'withdrawable', txQuery);
    await txQuery(
      `INSERT INTO challenge_progress (user_id, challenge_id, reward, claimed_at, progress_date)
       VALUES ($1, $2, $3, NOW(), CURRENT_DATE)
       ON CONFLICT (user_id, challenge_id, progress_date) DO UPDATE
       SET reward = EXCLUDED.reward, claimed_at = NOW()`,
      [userId, challengeId, challenge.reward]
    );
    return getUserChallengeProgress(userId);
  });
}

export async function getChallengeStats(): Promise<{ total_completions: string; total_rewards: string; completions_24h: string }> {
  const result = await query(`
    SELECT
      COUNT(*) AS total_completions,
      COALESCE(SUM(reward), 0) AS total_rewards,
      COUNT(*) FILTER (WHERE claimed_at > NOW() - INTERVAL '24 hours') AS completions_24h
    FROM challenge_progress
  `);
  return result.rows[0] as any;
}
