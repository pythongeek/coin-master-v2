/**
 * ══════════════════════════════════════════════════════════════
 *  TOTP (RFC 6238) utilities — base32 / HOTP / verify.
 * ══════════════════════════════════════════════════════════════
 *
 *  Encryption of TOTP secrets is delegated to `secret-vault.ts`,
 *  which uses AES-256-GCM with a 16-byte IV + 16-byte auth tag.
 *  This eliminates the AES-CBC malleability that previously
 *  allowed ciphertext-bit-flipping attacks against the stored
 *  2FA seed (P0-01).
 *
 *  Backward compatibility: the previous implementation used
 *  AES-256-CBC and stored ciphertexts as `iv:ciphertext` hex.
 *  On read, `decryptSecretWithMigration` first tries GCM
 *  (base64-encoded `iv|authTag|ciphertext` blob); on failure it
 *  falls back to legacy CBC via `decryptLegacyCBCSecret` (which
 *  itself uses the deprecated `getLegacyEncryptionKey` from
 *  `secret-vault.ts`) and invokes the supplied callback so the
 *  caller can persist the value re-encrypted with GCM.
 *
 *  P1-08 — Key derivation unification:
 *    - All key derivation for AES (modern and legacy) lives in
 *      `services/secret-vault.ts`. This file does NOT call
 *      `crypto.createHash` directly anymore — the only `createHash`
 *      reference is the legacy-CBC-internal HOTP HMAC-SHA1, which
 *      is unrelated to encryption key derivation.
 *    - The encryption API stays unchanged: `encryptSecret` /
 *      `decryptSecret` / `decryptSecretWithMigration` all keep the
 *      same shape, so existing callers (`auth-2fa.ts`,
 *      `routes/admin.ts`, etc.) and tests don't change.
 *
 *  After the one-shot re-encryption window (operator-managed),
 *  remove the legacy CBC fallback entirely — at that point every
 *  stored secret will be GCM and the migration fast-path becomes
 *  a no-op.
 * ══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import {
  encryptSecret as vaultEncrypt,
  decryptSecret as vaultDecrypt,
  decryptLegacyCBCSecret,
} from '../services/secret-vault';

// ---------------------------------------------------------------------------
// Encryption: canonical implementation lives in secret-vault.ts.
// Re-export under the names `auth-2fa.ts` and `totp.test.ts` already use.
// ---------------------------------------------------------------------------

/**
 * Encrypt a plain-text secret using AES-256-GCM (via secret-vault).
 * Output is base64 of `iv (16) || authTag (16) || ciphertext`.
 */
export function encryptSecret(plainText: string): string {
  return vaultEncrypt(plainText);
}

/**
 * Decrypt a blob produced by `encryptSecret`. Throws on tampering
 * (GCM auth-tag mismatch) or wrong key.
 */
export function decryptSecret(cipherText: string): string {
  return vaultDecrypt(cipherText);
}

/**
 * Read a stored TOTP secret, transparently handling legacy
 * AES-256-CBC ciphertexts by re-encrypting with AES-GCM
 * and persisting back to the DB via `persistReencrypted`.
 *
 * @param cipherText the stored value (GCM base64 OR legacy CBC `iv:ciphertext` hex)
 * @param persistReencrypted optional async callback invoked ONLY when
 *   a legacy CBC value was successfully decrypted — the caller should
 *   write the GCM-encrypted plaintext back to the DB. Not invoked for
 *   already-modern ciphertexts.
 * @returns the plaintext TOTP seed
 *
 * Throws if both formats fail (key mismatch, tampering, or corruption).
 */
export async function decryptSecretWithMigration(
  cipherText: string,
  persistReencrypted?: (newCipherText: string) => Promise<void>,
): Promise<string> {
  // Fast path: try the modern AES-GCM format first.
  try {
    return vaultDecrypt(cipherText);
  } catch (gcmErr) {
    // Fall through to legacy CBC attempt.
  }

  // Slow path: legacy AES-256-CBC + sha256(JWT_SECRET) derivation,
  // both delegated to `secret-vault.ts`.
  const plain = decryptLegacyCBCSecret(cipherText);

  // Re-encrypt under AES-GCM and hand back to the caller for
  // persistence. If persistence fails, we still return the plaintext
  // so the user can complete their action this session — but log loudly.
  if (persistReencrypted) {
    const reencrypted = vaultEncrypt(plain);
    try {
      await persistReencrypted(reencrypted);
    } catch (persistErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[totp] legacy CBC secret decrypted but re-encryption persistence failed;',
        'will retry on next read.',
        persistErr,
      );
    }
  }

  return plain;
}

// ---------------------------------------------------------------------------
// Base32 / HOTP / TOTP — unchanged from original implementation.
// ---------------------------------------------------------------------------

/**
 * Decodes a Base32 string to Buffer
 */
export function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanStr = str.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (let i = 0; i < cleanStr.length; i++) {
    const val = alphabet.indexOf(cleanStr[i]);
    if (val === -1) {
      throw new Error('Invalid Base32 character');
    }
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generates an HOTP token based on secret and counter
 */
export function generateHotp(secret: string, counter: number): string {
  const key = base32Decode(secret);

  // counter needs to be an 8-byte big-endian buffer
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter % 0x100000000, 4);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buffer);
  const hmacResult = hmac.digest();

  // Dynamic Truncation
  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const binary =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

/**
 * Verifies a TOTP token against a secret
 */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  if (!/^\d{6}$/.test(token)) {
    return false;
  }

  const timeStep = 30; // 30 seconds
  const currentStep = Math.floor(Date.now() / 1000 / timeStep);

  // Check window to allow for time drift (constant-time compare to avoid timing leaks)
  for (let i = -window; i <= window; i++) {
    const calculated = generateHotp(secret, currentStep + i);
    const calcBuf = Buffer.alloc(6, 0, 'utf8');
    const tokenBuf = Buffer.alloc(6, 0, 'utf8');
    calcBuf.write(calculated, 'utf8');
    tokenBuf.write(token, 'utf8');
    if (crypto.timingSafeEqual(calcBuf, tokenBuf)) {
      return true;
    }
  }

  return false;
}

/**
 * Generates a random Base32 TOTP secret and its corresponding otpauth url
 */
export function generateTotpSecret(email: string, issuer = 'CoinMaster'): { secret: string; otpauthUrl: string } {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const bytes = crypto.randomBytes(32);
  for (let i = 0; i < 32; i++) {
    secret += alphabet[bytes[i] % 32];
  }

  const cleanEmail = encodeURIComponent(email);
  const cleanIssuer = encodeURIComponent(issuer);
  const otpauthUrl = `otpauth://totp/${cleanIssuer}:${cleanEmail}?secret=${secret}&issuer=${cleanIssuer}`;

  return { secret, otpauthUrl };
}
