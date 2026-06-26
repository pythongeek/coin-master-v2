import { execSync } from 'child_process';
import path from 'path';

const testFiles = [
  'provably-fair.test.ts',
  'validation.test.ts',
  'geoip.test.ts',
  'rate-limiter.test.ts',
  'rbac.test.ts',
  'security.test.ts',
  'totp.test.ts',
  'kyc.test.ts',
  'wallet.test.ts',
  'withdrawal.test.ts',
  'bankroll.test.ts',
  'reconciliation.test.ts',
  'jackpot.test.ts',
  'leaderboards.test.ts',
  'dashboard.test.ts',
  'audit.test.ts',
];

console.log(`🚀 Running ${testFiles.length} backend tests...`);

let failed = false;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`\n========================================`);
  console.log(`🧪 Running test: ${file}`);
  console.log(`========================================`);
  try {
    execSync(`npx ts-node "${filePath}"`, { stdio: 'inherit' });
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
