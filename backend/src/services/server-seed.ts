import { query, db } from '../config/database';
import crypto from 'crypto';

export interface ActiveSeed {
  id: string;
  serverSeed: string;
  serverSeedHash: string;
  activeBets: number;
  rotationThreshold: number;
  activatedAt: Date;
}

/**
 * Ensure there is exactly one active server seed.
 * Called during startup if none exists.
 */
export async function ensureActiveSeed(): Promise<ActiveSeed> {
  const active = await getActiveSeed();
  if (active) return active;

  const seed = generateSeed();
  const hash = hashSeed(seed);
  const result = await query(
    `INSERT INTO server_seeds (server_seed, server_seed_hash, rotation_threshold, is_active, activated_at)
     VALUES ($1, $2, $3, true, NOW())
     RETURNING id, server_seed, server_seed_hash, active_bets, rotation_threshold, activated_at`,
    [seed, hash, 1000]
  );
  return mapRow(result.rows[0]);
}

/**
 * Get the currently active global server seed.
 */
export async function getActiveSeed(): Promise<ActiveSeed | null> {
  const result = await query(
    `SELECT id, server_seed, server_seed_hash, active_bets, rotation_threshold, activated_at
     FROM server_seeds WHERE is_active = true LIMIT 1`
  );
  if (!result.rows.length) return null;
  return mapRow(result.rows[0]);
}

/**
 * Atomically reserve a nonce on the active seed and return the details.
 * The seed secret is NOT returned here; only the committed hash is safe to expose.
 */
export async function reserveNonce(): Promise<{ seedId: string; serverSeedHash: string; nonce: number } | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, server_seed_hash, active_bets, rotation_threshold
       FROM server_seeds WHERE is_active = true
       FOR UPDATE LIMIT 1`
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const row = result.rows[0];
    const seedId = row.id;
    const serverSeedHash = row.server_seed_hash;
    const nonce = parseInt(row.active_bets) + 1;
    const threshold = parseInt(row.rotation_threshold);

    await client.query(
      'UPDATE server_seeds SET active_bets = active_bets + 1 WHERE id = $1',
      [seedId]
    );

    await client.query('COMMIT');

    // Rotate in the background if threshold reached (do not block the bet)
    if (nonce >= threshold) {
      rotateSeedIfNeeded(seedId).catch(err => console.error('Seed rotation failed:', err));
    }

    return { seedId, serverSeedHash, nonce };
  } finally {
    client.release();
  }
}

/**
 * Get a revealed seed by its hash (after rotation).
 */
export async function getRevealedSeedByHash(hash: string): Promise<{ serverSeed: string; revealedAt: Date } | null> {
  const result = await query(
    `SELECT server_seed, revealed_at FROM server_seeds
     WHERE server_seed_hash = $1 AND is_active = false AND revealed_at IS NOT NULL`,
    [hash]
  );
  if (!result.rows.length) return null;
  return {
    serverSeed: result.rows[0].server_seed,
    revealedAt: result.rows[0].revealed_at,
  };
}

export async function getSeedSecretById(seedId: string): Promise<{ serverSeed: string; serverSeedHash: string } | null> {
  const result = await query(
    'SELECT server_seed, server_seed_hash FROM server_seeds WHERE id = $1',
    [seedId]
  );
  if (!result.rows.length) return null;
  return {
    serverSeed: result.rows[0].server_seed,
    serverSeedHash: result.rows[0].server_seed_hash,
  };
}

/**
 * Return the history of revealed (inactive) seeds.
 */
export async function getSeedHistory(limit = 50): Promise<Array<{
  id: string;
  serverSeedHash: string;
  serverSeed: string;
  activeBets: number;
  revealedAt: Date;
}>> {
  const result = await query(
    `SELECT id, server_seed_hash, server_seed, active_bets, revealed_at
     FROM server_seeds WHERE is_active = false AND revealed_at IS NOT NULL
     ORDER BY revealed_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    serverSeedHash: r.server_seed_hash,
    serverSeed: r.server_seed,
    activeBets: parseInt(r.active_bets),
    revealedAt: r.revealed_at,
  }));
}

/**
 * Rotate the active seed if it has reached its threshold.
 * This generates a new active seed, marks the old one inactive, and reveals it.
 */
export async function rotateSeedIfNeeded(currentSeedId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT active_bets, rotation_threshold FROM server_seeds WHERE id = $1 FOR UPDATE',
      [currentSeedId]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return;
    }
    const activeBets = parseInt(current.rows[0].active_bets);
    const threshold = parseInt(current.rows[0].rotation_threshold);
    if (activeBets < threshold) {
      await client.query('ROLLBACK');
      return;
    }

    // Mark old seed inactive and reveal it
    await client.query(
      `UPDATE server_seeds SET is_active = false, revealed_at = NOW(), rotated_at = NOW()
       WHERE id = $1`,
      [currentSeedId]
    );

    // Create new active seed
    const seed = generateSeed();
    const hash = hashSeed(seed);
    await client.query(
      `INSERT INTO server_seeds (server_seed, server_seed_hash, rotation_threshold, is_active, activated_at)
       VALUES ($1, $2, $3, true, NOW())`,
      [seed, hash, threshold]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function generateSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function mapRow(row: any): ActiveSeed {
  return {
    id: row.id,
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    activeBets: parseInt(row.active_bets || '0'),
    rotationThreshold: parseInt(row.rotation_threshold || '1000'),
    activatedAt: row.activated_at,
  };
}
