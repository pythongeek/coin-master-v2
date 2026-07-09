import crypto from 'crypto';
import { env } from '../config/env';

// Fallback secrets used only when the corresponding env var is not set.
// In production these should always be set.
function getSecret(name: keyof typeof env, fallback: string): string {
  const value = env[name] as string | undefined;
  if (value && value.length >= 16) return value;
  return fallback;
}

const DEFAULT_ENCRYPTION_KEY = 'default-encryption-key-not-for-production-32';
const DEFAULT_LEDGER_SECRET = 'default-ledger-secret-not-for-production';
const DEFAULT_API_SIGNING_SECRET = 'default-api-signing-secret-not-for-production';

export function hmacSha256(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateClientSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function computeGameOutcome(
  serverSeed: string,
  clientSeed: string,
  nonce: bigint
): { outcome: 'heads' | 'tails'; hash: string; number: number } {
  const message = `${clientSeed}:${nonce.toString()}`;
  const hmac = hmacSha256(serverSeed, message);
  const first4Bytes = hmac.slice(0, 8);
  const number = parseInt(first4Bytes, 16);
  const outcome = number % 2 === 0 ? 'heads' : 'tails';

  return { outcome, hash: hmac, number };
}

export function computeServerSeedHash(serverSeed: string): string {
  return sha256(serverSeed);
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export function encrypt(text: string, key: string = getSecret('ENCRYPTION_KEY', DEFAULT_ENCRYPTION_KEY)): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key.slice(0, 32)), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedData: string, key: string = getSecret('ENCRYPTION_KEY', DEFAULT_ENCRYPTION_KEY)): string {
  const [ivHex, tagHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key.slice(0, 32)), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function computeLedgerHash(entryData: object, previousHash: string): string {
  const dataString = JSON.stringify(entryData) + previousHash;
  return sha256(dataString);
}

export function signLedgerEntry(entryHash: string, secret: string = getSecret('LEDGER_HMAC_SECRET', DEFAULT_LEDGER_SECRET)): string {
  return hmacSha256(secret, entryHash);
}

export function verifyLedgerEntry(entryHash: string, signature: string, secret: string = getSecret('LEDGER_HMAC_SECRET', DEFAULT_LEDGER_SECRET)): boolean {
  const expected = hmacSha256(secret, entryHash);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

export function computeRequestSignature(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  requestId: string,
  secret: string = getSecret('API_SIGNING_SECRET', DEFAULT_API_SIGNING_SECRET)
): string {
  const payload = `${method.toUpperCase()}|${path}|${sha256(body)}|${timestamp}|${requestId}`;
  return hmacSha256(secret, payload);
}

export function verifyRequestSignature(
  signature: string,
  method: string,
  path: string,
  body: string,
  timestamp: string,
  requestId: string
): boolean {
  const expected = computeRequestSignature(method, path, body, timestamp, requestId);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}
