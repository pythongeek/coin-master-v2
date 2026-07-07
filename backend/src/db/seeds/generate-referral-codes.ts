/**
 * ═══════════════════════════════════════════════════════════════
 *  ONE-TIME SEED: Generate referral codes for existing users
 *  Run manually: npx ts-node src/db/seeds/generate-referral-codes.ts
 * ═══════════════════════════════════════════════════════════════
 */
import crypto from 'crypto';
import { query } from '../config/database';

async function seed() {
  console.log('Checking for users without referral codes...');

  const { rows } = await query(
    'SELECT id FROM users WHERE referral_code IS NULL'
  );

  if (rows.length === 0) {
    console.log('All users already have referral codes. Nothing to do.');
    return;
  }

  console.log(`Found ${rows.length} users without referral codes. Generating...`);

  for (const row of rows) {
    let code = '';
    let isUnique = false;
    while (!isUnique) {
      const rand = crypto.randomInt(100000, 1000000);
      code = `CF${rand}`;
      const check = await query('SELECT id FROM users WHERE referral_code = $1', [code]);
      if (check.rows.length === 0) {
        isUnique = true;
      }
    }
    await query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, row.id]);
  }

  console.log(`Generated referral codes for ${rows.length} users.`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
