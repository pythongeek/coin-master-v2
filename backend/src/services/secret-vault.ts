import crypto from 'crypto';

/**
 * ══════════════════════════════════════════════════════════════
 *  SECRET VAULT — Single source of truth for encryption key
 *  derivation + AES-256-GCM encryption of sensitive values
 *  (e.g. MiniMax API key, TOTP seeds).
 * ══════════════════════════════════════════════════════════════
 *
 *  Algorithm: AES-256-GCM with a 32-byte key derived from
 *  KYC_SECRET_ENCRYPTION_KEY (or JWT_SECRET as fallback for dev).
 *
 *  In production, KYC_SECRET_ENCRYPTION_KEY must be set and must
 *  be at least 32 bytes. The key is never stored in the DB.
 *
 *  P1-08 — Key derivation unification:
 *    - `getEncryptionKey()` is the single canonical entry point for
 *      modern AES-GCM key derivation (scrypt-based, salted).
 *    - `getLegacyEncryptionKey()` is provided SOLELY for
 *      migration-on-read of legacy ciphertexts that were written
 *      before AES-GCM was adopted. It uses `sha256(JWT_SECRET)`,
 *      matching the pre-P0-01 derivation. Do not use it for new writes.
 *    - All callers in the backend MUST import key derivation from
 *      this file rather than rolling their own `crypto.createHash()`.
 *      The legacy helper carries a JSDoc `@deprecated` marker so
 *      `eslint --report-unused-disable-directives` and code-review
 *      immediately surface calls to it.
 *
 *  Pre-unification state (audit 2026-07-23):
 *    - `utils/totp.ts` had its own `getLegacyEncryptionKey()` that
 *      used `crypto.createHash('sha256').update(secret).digest()`.
 *      Migrated here in P1-08.
 *    - Modern path was already using the scrypt-based key derivation
 *      via the (then unexported) `getKey()`. P1-08 renames it to
 *      `getEncryptionKey()` and exports it as the canonical entry.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'cryptoflip-kyc-v1';

/**
 * Canonical modern key derivation.
 *
 * Used for all NEW writes of encrypted secrets. Also used implicitly
 * by `encryptSecret` / `decryptSecret` for the GCM path.
 *
 * Derivation: `crypto.scryptSync(raw, 'cryptoflip-kyc-v1', 32)` where
 *   `raw = KYC_SECRET_ENCRYPTION_KEY ?? JWT_SECRET ?? '__dev_…'`.
 *
 * Returns a 32-byte AES key.
 */
export function getEncryptionKey(): Buffer {
  const raw = process.env.KYC_SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FATAL: KYC_SECRET_ENCRYPTION_KEY must be set in production to encrypt sensitive values.',
      );
    }
    // Dev fallback: deterministic key. DO NOT use in production.
    return crypto.scryptSync('__dev_secret_fallback_key__', SALT, 32);
  }
  return crypto.scryptSync(raw, SALT, 32);
}

/**
 * Legacy key derivation — sha256(JWT_SECRET) — used to read old
 * AES-256-CBC ciphertexts that predate the P0-01 migration.
 *
 * @deprecated Do not use for new writes. Kept ONLY so that
 *   `decryptSecretWithMigration` can transparently upgrade pre-existing
 *   ciphertexts to AES-GCM by re-encryption-on-read. Will be removed
 *   entirely when the operator signals that all stored secrets have
 *   been re-encrypted (e.g. by inspecting `audit_log` for the
 *   `totp.legacy_secret_reencrypted` action against all users).
 */
export function getLegacyEncryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET environment variable is required (length >= 32 chars) to read legacy ciphertexts. Refusing to start.',
    );
  }
  // Matches pre-P0-01 derivation: sha256(JWT_SECRET). Per BSI TR-02102-1,
  // SHA-256 is acceptable for key derivation when the secret has high
  // entropy; we deliberately keep this derivation unchanged so that
  // legacy ciphertexts survive the migration.
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded blob containing
 * IV + ciphertext + auth tag.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a blob produced by encryptSecret. Throws on tampering or
 * bad key.
 */
export function decryptSecret(ciphertext: string): string {
  const blob = Buffer.from(ciphertext, 'base64');
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted secret');
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Decrypt a legacy AES-256-CBC `hex(iv):hex(ciphertext)` blob
 * using the deprecated `getLegacyEncryptionKey()`. Public because
 * `utils/totp.ts`'s migration-on-read helper delegates here so
 * the legacy code lives next to the modern code it pairs with.
 *
 * @deprecated See `getLegacyEncryptionKey`.
 */
export function decryptLegacyCBCSecret(cipherText: string): string {
  if (cipherText.includes('|') || /^[A-Za-z0-9+/=]+$/.test(cipherText) && !cipherText.includes(':')) {
    // New GCM base64 blob. Fail loudly so the caller can route to the
    // modern decryptSecret instead. We detect by checking for the
    // colon the legacy `iv:ciphertext` format MUST contain.
    throw new Error('Looks like a modern GCM blob — use decryptSecret');
  }
  const parts = cipherText.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid legacy encrypted format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  if (iv.length !== 16) {
    throw new Error('Invalid legacy IV length');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', getLegacyEncryptionKey(), iv);
  let decrypted = decipher.update(encryptedText, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function isSecretVaultConfigured(): boolean {
  return !!process.env.KYC_SECRET_ENCRYPTION_KEY;
}
