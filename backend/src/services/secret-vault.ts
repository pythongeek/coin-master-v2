import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════
 *  SECRET VAULT — Encrypt sensitive admin values before storing
 *  them in the database (e.g., MiniMax API key).
 * ═══════════════════════════════════════════════════════════════
 *
 *  Algorithm: AES-256-GCM with a 32-byte key derived from
 *  KYC_SECRET_ENCRYPTION_KEY (or JWT_SECRET as fallback for dev).
 *
 *  In production, KYC_SECRET_ENCRYPTION_KEY must be set and must
 *  be at least 32 bytes. The key is never stored in the DB.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'cryptoflip-kyc-v1';

function getKey(): Buffer {
  const raw = process.env.KYC_SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FATAL: KYC_SECRET_ENCRYPTION_KEY must be set in production to encrypt KYC provider API keys.',
      );
    }
    // Dev fallback: deterministic key. DO NOT use in production.
    return crypto.scryptSync('__dev_kyc_fallback_key__', SALT, 32);
  }
  return crypto.scryptSync(raw, SALT, 32);
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded blob containing
 * IV + ciphertext + auth tag.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
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
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function isSecretVaultConfigured(): boolean {
  return !!process.env.KYC_SECRET_ENCRYPTION_KEY;
}
