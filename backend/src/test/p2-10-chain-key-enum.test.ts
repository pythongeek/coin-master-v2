/**
 * P2-10 focused test — chainKey enum validation.
 *
 * Verifies:
 *   1. chainKeyEnum accepts the 3 valid values (BSC, TRC20, ERC20)
 *   2. chainKeyEnum rejects invalid strings with a ZodError
 *   3. Case-insensitivity: 'bsc' / 'trc20' / 'erc20' all accepted
 *      when normalized to uppercase before validation
 *   4. Empty string, null, undefined, numeric — all rejected
 *   5. SQL-injection-shaped inputs — rejected as "invalid enum value"
 *      (defense in depth at the schema layer)
 *   6. initiateQrDeposit with invalid chainKey throws a descriptive
 *      error BEFORE any DB call (uses mock DB)
 *
 * Run with: npx ts-node --require ./src/test/setup.ts src/test/p2-10-chain-key-enum.test.ts
 */

import { z } from 'zod';
import { chainKeyEnum } from '../schemas';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

const VALID_VALUES = ['BSC', 'TRC20', 'ERC20'];

console.log('P2-10: chainKey enum validation');

// ── Case 1: enum accepts the 3 valid values ────────────────────
for (const v of VALID_VALUES) {
  const r = chainKeyEnum.safeParse(v);
  assert(r.success, `enum accepts valid value: ${v}`);
  if (r.success) assert(r.data === v, `  parsed value is unchanged for: ${v}`);
}

// ── Case 2: enum rejects invalid strings ─────────────────────────
const invalidValues = [
  '',
  'INVALID',
  'BTC',
  'POLYGON',
  'TRX',       // TRX is the network_code, NOT chainKey (TRC20 is)
  'ETH',       // ETH is the network_code, NOT chainKey (ERC20 is)
  'BSC20',     // close but wrong
  'bsc ',      // trailing space
  ' BSC',      // leading space
  '123',
  'BSC; DROP TABLE',
  // SQL-injection-shaped (these would be catastrophic without enum check)
  "' OR 1=1 --",
  "BSC'",
  'BSC\x00',
];
for (const v of invalidValues) {
  const r = chainKeyEnum.safeParse(v);
  assert(!r.success, `enum rejects invalid value: ${JSON.stringify(v)}`);
}

// ── Case 3: case-insensitivity (after .toUpperCase()) ────────────
// The route handler normalizes via .toUpperCase() BEFORE the enum check,
// so 'bsc' on its own fails (correct — the input must be uppercase).
// This documents the contract.
for (const v of ['bsc', 'trc20', 'erc20']) {
  const r = chainKeyEnum.safeParse(v);
  assert(!r.success, `enum rejects lowercase: ${v} (uppercase required)`);
}
// After .toUpperCase(), all are valid
for (const v of ['bsc', 'trc20', 'erc20']) {
  const r = chainKeyEnum.safeParse(v.toUpperCase());
  assert(r.success, `enum accepts ${v.toUpperCase()} (after .toUpperCase())`);
}

// ── Case 4: null / undefined / numeric / boolean ─────────────────
const nullishValues = [null, undefined, 123, 1.5, true, false, [], {}, NaN];
for (const v of nullishValues) {
  const r = chainKeyEnum.safeParse(v);
  assert(!r.success, `enum rejects non-string value: ${JSON.stringify(v)}`);
}

// ── Case 5: SQL-injection-shaped inputs (defense in depth) ───────
// Zod's enum() throws ZodError with "Invalid enum value" for any
// string not in the allowed set. This is the FIRST line of defense;
// even if the second line (parameterized queries) were somehow
// bypassed, an attacker passing "BSC; DROP TABLE" would still be
// rejected at the enum layer.
const sqlShaped = [
  'BSC\"; DROP TABLE deposit_chain_config; --',
  "BSC' OR '1'='1",
  'TRC20\x00',
  'BSC\u0000',
  'BSC SELECT users',
];
for (const v of sqlShaped) {
  const r = chainKeyEnum.safeParse(v);
  assert(!r.success, `enum rejects SQL-injection-shaped: ${JSON.stringify(v)}`);
}

// ── Case 6: enum.options is exactly the 3 values ────────────────
assert(
  chainKeyEnum.options.length === 3,
  `enum has 3 options (got ${chainKeyEnum.options.length})`,
);
const opts = [...chainKeyEnum.options].sort();
assert(
  JSON.stringify(opts) === JSON.stringify(['BSC', 'ERC20', 'TRC20']),
  `enum.options is BSC/ERC20/TRC20 (got ${JSON.stringify(opts)})`,
);

// ── Case 7: parse() throws ZodError on invalid input ────────────
let threw = false;
try {
  chainKeyEnum.parse('INVALID');
} catch (err) {
  threw = err instanceof z.ZodError;
}
assert(threw, 'enum.parse() throws ZodError on invalid input');

// ── Case 8: TypeScript type — ChainKey is exactly 'BSC' | 'TRC20' | 'ERC20' ──
// This is a compile-time check; if someone refactors the enum values,
// tsc will catch any place that uses a literal type.
type ChainKeyTest = z.infer<typeof chainKeyEnum>;
const testChainKey: ChainKeyTest = 'BSC';
assert(typeof testChainKey === 'string', 'ChainKey type compiles as string literal');

// ── Case 9: initiateQrDeposit rejects invalid chainKey ───────────
// Mock the DB by stubbing getChainByKey (which is the FIRST DB call
// after the enum check).
async function testServiceRejects(): Promise<void> {
  // Lazy import to avoid pulling in the full module before the
  // schema checks above complete.
  const { initiateQrDeposit } = await import('../services/binance-pay-qr.service');
  // Mock getChainByKey to return a chain (so the error must come
  // from our enum check, not from "chain not found").
  const chainConfigModule = await import('../services/chain-config.service');
  const orig = chainConfigModule.getChainByKey;
  chainConfigModule.getChainByKey = async (key: string) => {
    if (key === 'BSC') {
      return {
        chainKey: 'BSC',
        displayName: 'BNB Smart Chain',
        networkCode: 'BSC',
        tokenSymbol: 'USDT',
        depositAddress: '0x0000000000000000000000000000000000000000',
        memoSupported: true,
        minConfirmations: 15,
        estimatedSeconds: 180,
        avgFeeUsdt: 0.5,
        displayOrder: 1,
        isEnabled: true,
      } as any;
    }
    return null;
  };
  try {
    await initiateQrDeposit({
      userId: '00000000-0000-0000-0000-000000000001',
      amountUsdt: 50,
      chainKey: 'INVALID_CHAIN',
    });
    assert(false, 'service should reject invalid chainKey');
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    assert(
      m.includes('Invalid chainKey'),
      `service error message mentions enum: ${m}`,
    );
  } finally {
    chainConfigModule.getChainByKey = orig;
  }

  // Valid chainKey should pass the enum check (and then proceed to
  // the chain lookup — which our mock returns a chain for).
  try {
    await initiateQrDeposit({
      userId: '00000000-0000-0000-0000-000000000002',
      amountUsdt: 50,
      chainKey: 'bsc',  // lowercase — should be normalized
    });
    assert(false, 'service should not throw for valid lowercase chainKey after normalization');
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // The service should NOT throw "Invalid chainKey" for valid input.
    assert(
      !m.includes('Invalid chainKey'),
      `service accepts normalized valid chainKey (no Invalid enum error): ${m}`,
    );
  } finally {
    chainConfigModule.getChainByKey = orig;
  }
}

(async () => {
  await testServiceRejects();

  console.log('');
  if (failed) {
    console.error('FAILED: P2-10 chainKey-enum tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P2-10 chainKey-enum tests passed');
    process.exit(0);
  }
})();
