/**
 * P0-01 focused test: AES-GCM migration of TOTP secret encryption.
 *
 * This test exercises ONLY the encryption layer (utils/totp.ts) and
 * its interaction with services/secret-vault.ts. It does NOT touch
 * the route layer, because the route-level mocks in totp.test.ts
 * drift from the live auth-2fa.ts queries (predating the column
 * rename two_factor_secret -> totp_secret_encrypted).
 *
 * Coverage:
 *  1. encryptSecret produces AES-GCM base64 output (no legacy colon).
 *  2. Round-trip encryptSecret -> decryptSecret yields the original plaintext.
 *  3. A 1-byte flip in the ciphertext causes decryptSecret to throw
 *     (GCM auth tag is enforced).
 *  4. decryptSecretWithMigration transparently decrypts an existing
 *     AES-GCM blob WITHOUT invoking the persist callback.
 *  5. decryptSecretWithMigration accepts a legacy AES-CBC `iv:ciphertext`
 *     hex blob, recovers the plaintext, and invokes the persist callback
 *     with a fresh AES-GCM re-encrypted value.
 *  6. The re-encrypted value is decryptable by the GCM-only decryptSecret.
 */

import { encryptSecret, decryptSecret, decryptSecretWithMigration } from '../utils/totp';
import crypto from 'crypto';

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

(async () => {
  // eslint-disable-next-line no-console
  console.log('🧪 P0-01: AES-GCM TOTP encryption migration tests\n');

  const testSecret = 'MY_SUPER_SECRET_KEY';

  // ── 1 + 2. Round-trip with GCM ───────────────────────────────────────
  const encrypted = encryptSecret(testSecret);
  assert(!encrypted.includes(':'), 'encryptSecret emits AES-GCM format (no legacy iv:ciphertext colon)');
  const decrypted = decryptSecret(encrypted);
  assert(decrypted === testSecret, 'encryptSecret + decryptSecret round-trip preserves plaintext');

  // ── 3. Tamper detection ──────────────────────────────────────────────
  const encBuf = Buffer.from(encrypted, 'base64');
  if (encBuf.length < 32) {
    assert(false, 'encrypted blob length >= 32 bytes (iv + authTag + at least 1 byte ciphertext)');
  } else {
    encBuf[encBuf.length - 1] = encBuf[encBuf.length - 1] ^ 0xff;
    const tampered = encBuf.toString('base64');
    let threw = false;
    try { decryptSecret(tampered); } catch { threw = true; }
    assert(threw, 'Tampered ciphertext (last byte flipped) is rejected by GCM auth tag');
  }

  // ── 4. GCM passthrough via decryptSecretWithMigration ────────────────
  let gcmPersistCalled = false;
  const plainAgain = await decryptSecretWithMigration(encrypted, async () => {
    gcmPersistCalled = true;
  });
  assert(plainAgain === testSecret, 'decryptSecretWithMigration returns plaintext for GCM input');
  assert(!gcmPersistCalled, 'decryptSecretWithMigration does NOT invoke persist callback for GCM input');

  // ── 5 + 6. Legacy CBC fallback ───────────────────────────────────────
  // Build a legacy AES-256-CBC `hex(iv):hex(ciphertext)` blob using the
  // pre-P0-01 key derivation (sha256(JWT_SECRET)).
  const legacyKey = crypto.createHash('sha256').update(process.env.JWT_SECRET || '').digest();
  const legacyIv = crypto.randomBytes(16);
  const legacyCipher = crypto.createCipheriv('aes-256-cbc', legacyKey, legacyIv);
  const legacyEnc = Buffer.concat([legacyCipher.update(testSecret, 'utf8'), legacyCipher.final()]);
  const legacyBlob = legacyIv.toString('hex') + ':' + legacyEnc.toString('hex');

  let persistedBlob: string | null = null;
  const migratedPlain = await decryptSecretWithMigration(legacyBlob, async (newBlob) => {
    persistedBlob = newBlob;
  });
  assert(migratedPlain === testSecret, 'Legacy CBC blob decrypts to original plaintext via migration path');
  assert(persistedBlob !== null, 'decryptSecretWithMigration invokes persist callback for legacy CBC input');
  if (persistedBlob) {
    const pb: string = persistedBlob;
    assert(!pb.includes(':'), 'Persisted blob uses AES-GCM layout (no legacy colon)');
    let reDecrypted = '';
    try { reDecrypted = decryptSecret(pb); } catch { /* ignore */ }
    assert(reDecrypted === testSecret, 'Re-encrypted blob round-trips through GCM-only decryptSecret');
  }

  // ── Summary ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('');
  if (failed) {
    // eslint-disable-next-line no-console
    console.error('❌ P0-01 tests FAILED');
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.log('🎉 All P0-01 AES-GCM TOTP encryption tests passed');
    process.exit(0);
  }
})();
