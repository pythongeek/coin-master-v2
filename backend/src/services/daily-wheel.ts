/**
 * Daily login wheel service
 * One free weighted spin per cooldown period.
 */

import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';
import { creditPayout } from './bonus';
import { generateServerSeed, hashServerSeed } from './provably-fair';

export interface DailyWheelPrize {
  label: string;
  value: number;
  type: 'coins';
  weight: number;
}

export interface WheelSpinResult {
  prize: DailyWheelPrize;
  nextSpinAt: Date;
}

export async function getWheelStatus(userId: string) {
  const config = await getConfig();
  if (!config.dailyWheelEnabled) {
    return { enabled: false, canSpin: false, nextSpinAt: null };
  }

  const result = await query(
    `SELECT last_spin_at FROM daily_wheel_spins WHERE user_id = $1`,
    [userId]
  );

  const lastSpin = result.rows[0]?.last_spin_at;
  const nextSpinAt = lastSpin
    ? new Date(new Date(lastSpin).getTime() + config.dailyWheelCooldownHours * 60 * 60 * 1000)
    : new Date(0);
  const canSpin = new Date() >= nextSpinAt;

  return { enabled: true, canSpin, nextSpinAt };
}

export async function spinDailyWheel(userId: string, clientSeed: string): Promise<WheelSpinResult> {
  const config = await getConfig();
  if (!config.dailyWheelEnabled) {
    throw new Error('Daily wheel is disabled.');
  }

  const status = await getWheelStatus(userId);
  if (!status.canSpin) {
    throw new Error('Wheel is on cooldown.');
  }

  const prizes = config.dailyWheelPrizes || [];
  if (!prizes.length) throw new Error('Wheel prizes not configured.');

  const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
  const serverSeed = generateServerSeed();
  const serverSeedHash = hashServerSeed(serverSeed);
  const hmacInput = `${serverSeedHash}:${clientSeed}:dailywheel:${Date.now()}`;

  const crypto = await import('crypto');
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(hmacInput);
  const rollHex = hmac.digest('hex');
  const roll = (parseInt(rollHex.slice(0, 8), 16) / 0xffffffff) * totalWeight;

  let cumulative = 0;
  const prize = prizes.find((p) => {
    cumulative += p.weight;
    return roll < cumulative;
  }) || prizes[prizes.length - 1];

  const cooldownHours = config.dailyWheelCooldownHours || 24;
  const nextSpinAt = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);

  await withTransaction(async (txQ) => {
    const txQuery = txQ as any;
    await txQuery(
      `INSERT INTO daily_wheel_spins (user_id, last_spin_at, last_prize_label, last_prize_value, server_seed_hash)
       VALUES ($1, NOW(), $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET last_spin_at = NOW(), last_prize_label = $2, last_prize_value = $3, server_seed_hash = $4`,
      [userId, prize.label, prize.value, serverSeedHash]
    );

    if (prize.value > 0) {
      await creditPayout(userId, prize.value, 'withdrawable', txQuery);
    }
  });

  return { prize, nextSpinAt };
}

export async function getWheelStats() {
  const result = await query(`
    SELECT
      COUNT(*) AS total_spins,
      COUNT(*) FILTER (WHERE last_spin_at > NOW() - INTERVAL '24 hours') AS spins_24h,
      COALESCE(SUM(last_prize_value), 0) AS total_given
    FROM daily_wheel_spins
  `);
  return result.rows[0];
}
