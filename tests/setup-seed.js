/**
 * tests/setup-seed.js — Gap 13
 *
 * Seeds 2 fake test users with confirmed-deposit history so the
 * integration/smoke/fraud tests can run end-to-end against the live
 * Postgres. Idempotent — re-running the seed is a no-op if the users
 * already exist.
 *
 * Pure JS (no TypeScript) to avoid the `pg` type-resolution issue
 * when this file lives outside the backend's src/ tree.
 *
 * Run with: node tests/setup-seed.js
 */

const { Client } = require('/root/coin-master/backend/node_modules/pg');

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://cryptoflip:***@127.0.0.1:55432/cryptoflip';

// bcrypt('K6TestLoad2026!', 8)
const PASSWORD_HASH = '$2a$08$5dQH9N3WB1FX9rGPf6DM9eN9p8h3r4N4Wx6g8WV2EYR1kK9Cjj4rC';

const USERS = [
  { id: '0fd1b26a-d82c-4968-a370-46198fd945cc', username: 'k6test_0', country: 'BD', lifetimeDeposit: 100, withdrawableBalance: 1000 },
  { id: '01affa37-0e1d-4dfd-81a9-b6ade0094321', username: 'k6test_19', country: 'BD', lifetimeDeposit: 100, withdrawableBalance: 1000 },
];

async function main() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    for (const u of USERS) {
      // Upsert user
      await pg.query(
        `INSERT INTO users
           (id, username, password_hash, is_active, is_admin, kyc_tier, kyc_status,
            kyc_country, total_deposited_coins, withdrawable_balance_coins,
            bonus_balance_coins, total_wagered, pending_rakeback)
         VALUES ($1, $2, $3, true, false, 1, 'unverified', $4, $5, $6, 0, 0, 0)
         ON CONFLICT (id) DO UPDATE
           SET kyc_country = EXCLUDED.kyc_country,
               kyc_tier = EXCLUDED.kyc_tier,
               kyc_status = EXCLUDED.kyc_status,
               is_active = true,
               password_hash = EXCLUDED.password_hash,
               total_deposited_coins = EXCLUDED.total_deposited_coins,
               withdrawable_balance_coins = EXCLUDED.withdrawable_balance_coins`,
        [u.id, u.username, PASSWORD_HASH, u.country, u.lifetimeDeposit, u.withdrawableBalance],
      );

      // Ensure at least one confirmed deposit row
      const existing = await pg.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'confirmed' LIMIT 1`,
        [u.id],
      );
      if (existing.rows.length === 0) {
        await pg.query(
          `INSERT INTO transactions
             (user_id, type, amount, currency, direction, status, metadata)
           VALUES ($1, 'deposit', $2, 'USD', 'credit', 'confirmed', $3)`,
          [u.id, u.lifetimeDeposit.toFixed(8),
           JSON.stringify({ source: 'test_seed', reason: 'gap13_setup', userId: u.id })],
        );
        console.log(`seeded deposit for ${u.username}`);
      } else {
        console.log(`deposit already exists for ${u.username}`);
      }
    }
    console.log(JSON.stringify({ ok: true, users: USERS.map(u => ({ id: u.id, username: u.username })) }, null, 2));
  } finally {
    await pg.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
