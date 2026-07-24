/**
 * P1-12 fingerprint cap test — uses the in-memory mock DB.
 *
 * The mock DB has handlers for SELECT id, UPDATE, INSERT, etc., but
 * has no handler for the specific count(*) FROM users WHERE
 * fingerprint = $1 query that `countFingerprintsInWindow` runs.
 * We hook in via the `__TEST_MOCK_QUERY__` global to provide a
 * deterministic response.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/p1-12-fingerprint-cap.test.ts
 */

import { createHash } from 'node:crypto';
import { checkFingerprintRegistrationCap } from '../services/fingerprint-fraud-cap';
import { query } from '../config/database';

// ── Test-mock hook ────────────────────────────────────────────
// Map of fingerprint hash → count. Tests insert entries to control
// what the mock returns for the count(*) query.
const fingerprintCounts: Map<string, number> = new Map();

(global as any).__TEST_MOCK_QUERY__ = async (text: string, params: any[] = []) => {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  // admin_settings lookup
  if (normalized.includes('select value from admin_settings where key =')) {
    const key = params[0];
    if (key === 'fraud_max_accounts_per_fingerprint_24h') {
      // If a special override was set via the global, use it.
      const override = (global as any).__p1_12_cap_override;
      if (typeof override === 'number') {
        return { rows: [{ value: String(override) }] };
      }
      return { rows: [{ value: '3' }] };
    }
    return { rows: [] };
  }
  // count(*) from users where fingerprint
  if (normalized.includes('from users') && normalized.includes('fingerprint =')) {
    const fingerprintHash = params[0];
    const cnt = fingerprintCounts.get(fingerprintHash) || 0;
    return { rows: [{ cnt }] };
  }
  // Default: empty rows.
  return { rows: [] };
};

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

(async () => {
  console.log('P1-12: per-device fingerprint 24h cap');

  // 1. null → allowed, no-fingerprint
  {
    const r = await checkFingerprintRegistrationCap(null, '127.0.0.1');
    assert(r.allowed, 'null fingerprint → allowed');
    assert(r.reason === 'no-fingerprint', 'null → reason="no-fingerprint"');
    assert(r.fingerprintHash === null, 'null → fingerprintHash=null');
  }

  // 2. empty string → allowed, no-fingerprint
  {
    const r = await checkFingerprintRegistrationCap('', '127.0.0.1');
    assert(r.allowed, 'empty fingerprint → allowed');
    assert(r.reason === 'no-fingerprint', 'empty → reason="no-fingerprint"');
  }

  // 3. too short → allowed, no-fingerprint
  {
    const r = await checkFingerprintRegistrationCap('short', '127.0.0.1');
    assert(r.allowed, 'too-short fingerprint → allowed');
    assert(r.reason === 'no-fingerprint', 'too-short → reason="no-fingerprint"');
  }

  // 4. valid random fingerprint, count=0 → under-cap, allowed
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 0);
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.reason === 'under-cap', 'count=0 → under-cap (got ' + r.reason + ')');
    assert(r.allowed, 'count=0 → allowed');
    assert(r.countInLast24h === 0, 'count=0 → countInLast24h=0');
    assert(r.fingerprintHash === hash, 'fingerprintHash matches sha256(trim + lowercase)');
    assert(r.cap === 3, 'default cap is 3 (got ' + r.cap + ')');
  }

  // 5. valid fingerprint, count=2, cap=3 → under-cap (count < cap)
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 2);
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.reason === 'under-cap', 'count=2 + cap=3 → under-cap');
    assert(r.allowed, 'count=2 + cap=3 → allowed');
    assert(r.countInLast24h === 2, 'count=2 reflected');
  }

  // 6. valid fingerprint, count=3, cap=3 → at-cap, NOT allowed
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 3);
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.reason === 'at-cap', 'count=3 + cap=3 → at-cap');
    assert(!r.allowed, 'count=3 + cap=3 → NOT allowed');
    assert(r.countInLast24h === 3, 'count=3 reflected');
  }

  // 7. valid fingerprint, count=10 → at-cap regardless of cap
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 10);
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.reason === 'at-cap', 'count=10 → at-cap');
    assert(!r.allowed, 'count=10 → NOT allowed');
  }

  // 8. cap override via admin setting (set cap=5, count=4 → under-cap)
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 4);
    (global as any).__p1_12_cap_override = 5;
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.cap === 5, 'admin override cap=5 (got ' + r.cap + ')');
    assert(r.reason === 'under-cap', 'count=4 + cap=5 → under-cap');
    assert(r.allowed, 'count=4 + cap=5 → allowed');
  }

  // 9. cap override, count = cap → at-cap
  {
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 5);
    // cap is still 5 from previous test
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.reason === 'at-cap', 'count=5 + cap=5 → at-cap');
    assert(!r.allowed, 'count=5 + cap=5 → NOT allowed');
  }

  // 10. cap=0 (admin typo) → clamped to 1
  {
    (global as any).__p1_12_cap_override = 0;
    const validFp = 'test-fingerprint-' + Math.random().toString(36).slice(2);
    const hash = createHash('sha256').update(validFp.trim().toLowerCase()).digest('hex');
    fingerprintCounts.set(validFp, 1);
    const r = await checkFingerprintRegistrationCap(validFp, '127.0.0.1');
    assert(r.cap === 1, 'cap=0 → clamped to 1 (got ' + r.cap + ')');
    assert(r.reason === 'at-cap', 'count=1 + cap=1 → at-cap');
    assert(!r.allowed, 'count=1 + cap=1 → NOT allowed');
  }
  delete (global as any).__p1_12_cap_override;

  // Cleanup
  fingerprintCounts.clear();
  delete (global as any).__TEST_MOCK_QUERY__;

  // Suppress the query import in the bundle (it's used inside checkFingerprintRegistrationCap)
  void query;

  console.log('');
  if (failed) {
    console.error('FAILED: P1-12 fingerprint cap tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-12 fingerprint cap tests passed');
    process.exit(0);
  }
})();
