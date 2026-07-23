/**
 * P0-02 focused test: fail-closed on missing or default-test MNEMONIC.
 *
 * The original `wallet-derivation.ts` silently fell back to the
 * well-known Ethereum test mnemonic when MNEMONIC was unset, so every
 * deposit address on every chain was derived from publicly-known
 * seed material. This test confirms that the fail-closed contract
 * now holds:
 *
 *   1. `validateMnemonic('')` throws.
 *   2. `validateMnemonic(<forbidden test mnemonic>)` throws.
 *   3. `validateMnemonic(<unknown BIP39 word>)` throws.
 *   4. `validateMnemonic(<valid 12-word phrase>)` returns the phrase.
 *   5. With MNEMONIC unset, `getOrCreateUserWallet()` throws the FATAL
 *      "required" error before any DB query.
 *   6. With MNEMONIC=forbidden, `getOrCreateUserWallet()` throws the
 *      FATAL "well-known test mnemonic" error before any DB query.
 *   7. With MNEMONIC=<valid phrase>, `getOrCreateUserWallet()` reaches
 *      the DB query path (mocked; we assert it was called).
 *
 * Cases 5/6/7 stub the config/database `query()` and config/redis
 * `redis.incr()` so we can isolate the validation check from the rest
 * of the derivation pipeline. A `module._cache` reset between cases
 * guarantees a clean requireMnemonic() each time.
 */

import Module from 'module';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Test-local mocks: must be installed BEFORE wallet-derivation.ts loads
// (because it transitively imports config/database and config/redis).
// ---------------------------------------------------------------------------
const originalResolve = (Module as any)._resolveFilename;
const originalRequire = Module.prototype.require;

let dbQueryCalls = 0;
let redisIncrCalls = 0;

const stubDb = {
  query: async (_text: string, _params: any[] = []) => {
    dbQueryCalls++;
    // Simulate "no existing wallet" so the function would proceed to
    // the derivation branch if the mnemonic check passed.
    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  withTransaction: async () => undefined,
};

const stubRedisInstance = {
  incr: async (_key: string) => {
    redisIncrCalls++;
    return 0;
  },
  get: async () => null,
  set: async () => 'OK',
  on: () => undefined,
  connect: async () => undefined,
  quit: async () => 'OK',
  disconnect: async () => 'OK',
  del: async () => 1,
  expire: async () => 1,
};

// Stub matches the export shape of backend/src/config/redis.ts:
//   export const redis = new Redis();   // also default
const stubRedis = {
  redis: stubRedisInstance,
  default: stubRedisInstance,
};

Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on() { return this; }
      async connect() { return this; }
      async quit() { return 'OK'; }
      async disconnect() { return 'OK'; }
      async get() { return null; }
      async set() { return 'OK'; }
      async incr() { return 1; }
      async del() { return 1; }
      async expire() { return 1; }
    };
  }
  // The two transitive deps that wallet-derivation.ts imports.
  if (id === '../config/database' || id === '../../config/database' || id === '../config/redis' || id === '../../config/redis') {
    return id.endsWith('redis') ? stubRedis : stubDb;
  }
  return originalRequire.apply(this, arguments as any);
};

let failed = false;
function assert(cond: boolean, msg: string) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log('✅', msg);
  } else {
    // eslint-disable-next-line no-console
    console.error('❌', msg);
    failed = true;
  }
}

// Reset module cache between cases so requireMnemonic() re-evaluates
// against the freshly-set process.env.MNEMONIC.
function resetModule() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('wallet-derivation')) {
      delete require.cache[key];
    }
  }
}

(async () => {
  // eslint-disable-next-line no-console
  console.log('🧪 P0-02: MNEMONIC fail-closed contract tests\n');

  // ── Cases 1–4: validateMnemonic() direct ─────────────────────────────
  const { validateMnemonic } = require('../services/wallet-derivation');

  let threw = false;
  try { validateMnemonic(''); } catch { threw = true; }
  assert(threw, 'validateMnemonic("") throws');

  threw = false;
  try {
    validateMnemonic('test test test test test test test test test test test junk');
  } catch { threw = true; }
  assert(threw, 'validateMnemonic(forbidden test mnemonic) throws');

  threw = false;
  try {
    validateMnemonic('hello world this is not a valid bip39 phrase at all');
  } catch { threw = true; }
  assert(threw, 'validateMnemonic(<unknown words>) throws (BIP39 wordlist check)');

  // "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  // is a well-known 12-word mnemonic with a valid checksum. We use a
  // *different* valid phrase here to avoid accidentally matching the
  // forbidden test mnemonic.
  const validPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  let returned: string | null = null;
  try { returned = validateMnemonic(validPhrase); } catch { /* ignore */ }
  assert(returned === validPhrase, 'validateMnemonic(<valid 12-word phrase>) returns the normalized phrase');

  // ── Case 5: MNEMONIC unset ───────────────────────────────────────────
  resetModule();
  delete process.env.MNEMONIC;
  dbQueryCalls = 0;
  redisIncrCalls = 0;
  let wd: any;
  try { wd = require('../services/wallet-derivation'); } catch (e: any) {
    assert(false, `importing wallet-derivation with MNEMONIC unset should not throw (validation is lazy): ${e.message}`);
  }
  threw = false;
  let msg = '';
  try {
    await wd.getOrCreateUserWallet('user-1', 'ethereum');
  } catch (e: any) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'getOrCreateUserWallet throws when MNEMONIC is unset');
  assert(
    msg.includes('FATAL: MNEMONIC environment variable is required'),
    `unset-MNEMONIC error message includes "required" sentinel (got: "${msg.slice(0, 120)}")`,
  );
  assert(dbQueryCalls === 0, 'No DB query is issued when MNEMONIC is unset (validation happens before query)');
  assert(redisIncrCalls === 0, 'No Redis INCR is issued when MNEMONIC is unset');

  // ── Case 6: MNEMONIC = forbidden test mnemonic ────────────────────────
  resetModule();
  process.env.MNEMONIC = 'test test test test test test test test test test test junk';
  dbQueryCalls = 0;
  redisIncrCalls = 0;
  try { wd = require('../services/wallet-derivation'); } catch (e: any) {
    assert(false, `importing wallet-derivation with forbidden MNEMONIC should not throw (validation is lazy): ${e.message}`);
  }
  threw = false;
  msg = '';
  try {
    await wd.getOrCreateUserWallet('user-2', 'tron');
  } catch (e: any) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'getOrCreateUserWallet throws when MNEMONIC equals the forbidden test mnemonic');
  assert(
    msg.includes('well-known Ethereum test mnemonic'),
    `forbidden-MNEMONIC error message includes "well-known test mnemonic" sentinel (got: "${msg.slice(0, 120)}")`,
  );
  assert(dbQueryCalls === 0, 'No DB query is issued when MNEMONIC is forbidden');
  assert(redisIncrCalls === 0, 'No Redis INCR is issued when MNEMONIC is forbidden');

  // ── Case 7: MNEMONIC = valid phrase ──────────────────────────────────
  resetModule();
  process.env.MNEMONIC = validPhrase;
  dbQueryCalls = 0;
  redisIncrCalls = 0;
  try { wd = require('../services/wallet-derivation'); } catch (e: any) {
    assert(false, `importing wallet-derivation with valid MNEMONIC should not throw: ${e.message}`);
  }
  // We don't care about the derivation result here, only that the
  // validation gate passed and the function reached the DB query path.
  // The mocks return empty rows + index 0; deriveEVMWallet then runs
  // against the real ethers library — it should not throw.
  threw = false;
  try {
    const w = await wd.getOrCreateUserWallet('user-3', 'ethereum');
    assert(typeof w.address === 'string' && w.address.startsWith('0x'), `derived address is an EVM-style hex string (got prefix: "${w.address.slice(0, 4)}")`);
    assert(typeof w.index === 'number', 'derived wallet has a numeric index');
  } catch (e: any) {
    threw = true;
    assert(false, `getOrCreateUserWallet succeeded with valid MNEMONIC: ${e.message}`);
  }
  if (!threw) {
    assert(dbQueryCalls > 0, 'DB query was issued after validation passed');
    assert(redisIncrCalls > 0, 'Redis INCR was issued after validation passed');
  }

  // ── Case 8: derived address differs from the forbidden-mnemonic
  //             derivation, proving the swap is real ──────────────────
  // Using the validPhrase at index 0 should NOT produce the address
  // the well-known test mnemonic produces at index 0.
  // (Reference address from test mnemonic index 0:
  //  0x9858EfFD232B4033E47d90003D41EC34EcaEda94 — public on chain.)
  resetModule();
  process.env.MNEMONIC = validPhrase;
  const wd2 = require('../services/wallet-derivation');
  const w = wd2.deriveEVMWallet(validPhrase, 0);
  assert(
    w.address.toLowerCase() !== '0x9858effd232b4033e47d90003d41ec34ecaeda94',
    'Valid-phrase derivation produces a DIFFERENT address from the forbidden-mnemonic derivation (no seed reuse)',
  );

  // ── Summary ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('');
  if (failed) {
    // eslint-disable-next-line no-console
    console.error('❌ P0-02 tests FAILED');
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.log('🎉 All P0-02 MNEMONIC fail-closed tests passed');
    process.exit(0);
  }
})();
