import { execSync } from 'child_process';
import path from 'path';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_that_is_at_least_32_characters_long';

process.env.ADMIN_2FA_REQUIRED = process.env.ADMIN_2FA_REQUIRED || 'false';

const testFiles = [
  'provably-fair.test.ts',
  'validation.test.ts',
  'geoip.test.ts',
  'rate-limiter.test.ts',
  'rbac.test.ts',
  'security.test.ts',
  'totp.test.ts',
  'totp-gcm.test.ts',
  'totp-key-derivation.test.ts',
  'withdrawal-payout-memory.test.ts',
  'metrics-security.test.ts',
  'tron-mcp.test.ts',
  'p1-12-hcaptcha.test.ts',
  'p1-12-fingerprint-cap.test.ts',
  'p1-12-register-strict-limiter.test.ts',
  'kyc.test.ts',
  'wallet.test.ts',
  'withdrawal.test.ts',
  'bankroll.test.ts',
  'reconciliation.test.ts',
  'jackpot.test.ts',
  'leaderboards.test.ts',
  'dashboard.test.ts',
  'audit.test.ts',
  'affiliate.test.ts',
  'promo.test.ts',
  'fraud.test.ts',
  'maxmind.test.ts',
  'admin-geoip.test.ts',
  'daily-fraud-report.test.ts',
  'cohort-analysis.test.ts',
  'game-fraud-controls.test.ts',
  'concurrency.test.ts',
];

console.log(`🚀 Running ${testFiles.length} backend tests...`);

let failed = false;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`\n========================================`);
  console.log(`🧪 Running test: ${file}`);
  console.log(`========================================`);
  try {
    execSync(`npx ts-node --require "${path.join(__dirname, 'setup.ts')}" "${filePath}"`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        JWT_SECRET: JWT_SECRET,
        ADMIN_2FA_REQUIRED: 'false',
      },
    });
    console.log(`✅ Passed: ${file}`);
  } catch (error) {
    console.error(`❌ Failed: ${file}`);
    failed = true;
  }
}

console.log(`\n========================================`);
if (failed) {
  console.error('❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('🎉 All backend tests passed successfully!');
  process.exit(0);
}
