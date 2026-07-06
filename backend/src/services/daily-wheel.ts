import crypto from 'crypto';
import { query, withTransaction } from '../config/database';
import { getConfig } from './admin-config';
import { creditPayout } from './bonus';
import { reserveNonce, getSeedSecretById } from './server-seed';

export interface DailyWheelPrize {
  label: string;
  value: number;
  type: 'coins';
  weight: number;
}

export interface WheelSpinResult {
  prize: DailyWheelPrize;
  nextSpinAt: Date;
  serverSeedHash: string;
  nonce: number;
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

export async function spinDailyWheel(
  userId: string,
  clientSeed: string
): Promise<WheelSpinResult> {
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

  // ── Provably Fair: reserve a nonce on the global active seed ──────
  const seedReservation = await reserveNonce();
  if (!seedReservation) {
    throw new Error('কোনো সক্রিয় সার্ভার সিড পাওয়া যায়নি। পরে আবার চেষ্টা করুন।');
  }
  const { seedId, serverSeedHash, nonce } = seedReservation;

  const secret = await getSeedSecretById(seedId);
  if (!secret) {
    throw new Error('সার্ভার সিড লোড করতে ব্যর্থ হয়েছে।');
  }
  const serverSeed = secret.serverSeed;
  if (secret.serverSeedHash !== serverSeedHash) {
    throw new Error('সার্ভার সিড হ্যাশ মিলছে না।');
  }

  const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
  const hmacInput = `${serverSeedHash}:${clientSeed}:dailywheel:${Date.now()}`;

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
      `INSERT INTO daily_wheel_spins
         (user_id, last_spin_at, last_prize_label, last_prize_value, server_seed_hash, seed_id, nonce)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
       SET last_spin_at = NOW(),
           last_prize_label = $2,
           last_prize_value = $3,
           server_seed_hash = $4,
           seed_id = $5,
           nonce = $6`,
      [userId, prize.label, prize.value, serverSeedHash, seedId, nonce]
    );

    if (prize.value > 0) {
      await creditPayout(userId, prize.value, 'withdrawable', txQuery);
    }
  });

  return { prize, nextSpinAt, serverSeedHash, nonce };
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
