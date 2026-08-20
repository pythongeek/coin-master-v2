/**
 * P1-08 focused test: encryption key derivation is unified in
 * services/secret-vault.ts. utils/totp.ts no longer performs its own
 * crypto.createHash calls for key derivation; the only createHash
 * invocation is the RFC-6238 HOTP HMAC-SHA1 inside generateHotp,
 * which is unrelated to encryption key derivation.
 *
 * Run with:  npx ts-node --require ./src/test/setup.ts src/test/totp-key-derivation.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';
import {
  getEncryptionKey,
  getLegacyEncryptionKey,
  encryptSecret,
  decryptSecret,
} from '../services/secret-vault';
import { decryptSecretWithMigration } from '../utils/totp';

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
  console.log('P1-08: encryption key derivation is unified in secret-vault');

  // -- 1. Modern key shape ---------------------------------
  const k = getEncryptionKey();
  assert(Buffer.isBuffer(k), 'getEncryptionKey() returns a Buffer');
  assert(k.length === 32, 'getEncryptionKey() returns a 32-byte AES key');

  // -- 2. Determinism --------------------------------------
  const k2 = getEncryptionKey();
  assert(k.equals(k2), 'getEncryptionKey() is deterministic for identical process.env');

  // -- 3. Honors env input -------------------------------------------
  const savedKyc = process.env.KYC_SECRET_ENCRYPTION_KEY;
  const longA = String.fromCharCode(...Array(64).fill(65));
  const longB = String.fromCharCode(...Array(64).fill(66));
  Object.assign(process.env, { KYC_SECRET_ENCRYPTION_KEY: longA });
  const kA = getEncryptionKey();
  Object.assign(process.env, { KYC_SECRET_ENCRYPTION_KEY: longB });
  const kB = getEncryptionKey();
  if (savedKyc === undefined) {
    delete process.env.KYC_SECRET_ENCRYPTION_KEY;
  } else {
    Object.assign(process.env, { KYC_SECRET_ENCRYPTION_KEY: savedKyc });
  }
  assert(!kA.equals(kB), 'getEncryptionKey() honors its input — different inputs produce different keys');
  assert(kA.length === 32 && kB.length === 32, 'getEncryptionKey() always returns 32 bytes regardless of input');

  // -- 4. Legacy derivation is sha256(JWT_SECRET) ---------------------
  const legacy = getLegacyEncryptionKey();
  assert(Buffer.isBuffer(legacy), 'getLegacyEncryptionKey() returns a Buffer');
  assert(legacy.length === 32, 'getLegacyEncryptionKey() returns a 32-byte AES key');
  const expectedLegacy = crypto.createHash('sha256').update(process.env.JWT_SECRET || '').digest();
  assert(
    legacy.equals(expectedLegacy),
    'getLegacyEncryptionKey() equals sha256(JWT_SECRET) (pre-P0-01 derivation, preserved for migration)',
  );

  // -- 5. Modern key != legacy key (NOT interchangeable) -------------
  assert(
    !k.equals(legacy),
    'Modern (scrypt) key != legacy (sha256) key — both must remain valid simultaneously during migration',
  );

  // -- 6. End-to-end: encryption round-trip + legacy fallback works ---
  const plain = 'TBK-TEST-PLAINTEXT-P1-08';
  const modern = encryptSecret(plain);
  assert(decryptSecret(modern) === plain, 'Modern GCM round-trip via secret-vault works');

  // Build a legacy CBC blob with sha256(JWT_SECRET) — the OLD pre-P0-01 path.
  const legacyKey = crypto.createHash('sha256').update(process.env.JWT_SECRET || '').digest();
  const legacyIv = crypto.randomBytes(16);
  const legacyCipher = crypto.createCipheriv('aes-256-cbc', legacyKey, legacyIv);
  const legacyEnc = Buffer.concat([
    legacyCipher.update(plain, 'utf8'),
    legacyCipher.final(),
  ]);
  const legacyBlob = legacyIv.toString('hex') + ':' + legacyEnc.toString('hex');

  const migratedPlain = await decryptSecretWithMigration(legacyBlob);
  assert(
    migratedPlain === plain,
    'Legacy CBC blob decrypted via secret-vault.getLegacyEncryptionKey() — totp.ts has no local sha256 path',
  );

  // -- 7. totp.ts source: no `crypto.createHash(` call sites --------
  const totpSrc = readFileSync(
    path.resolve(__dirname, '..', 'utils', 'totp.ts'),
    'utf8',
  );
  const noBlockComment = totpSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const noLineComment = noBlockComment.replace(/^\s*\/\/.*$/gm, (m) => '');
  const createHashCalls = (noLineComment.match(/crypto\.createHash\s*\(/g) || []).length;
  assert(
    createHashCalls === 0,
    'utils/totp.ts contains 0 crypto.createHash( call sites (found ' + createHashCalls + ')',
  );

  console.log('');
  if (failed) {
    console.error('FAILED: P1-08 tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-08 key-derivation unification tests passed');
    process.exit(0);
  }
})();
