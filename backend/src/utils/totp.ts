import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET environment variable is required and must be at least 32 characters. Refusing to start.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plain-text secret using AES-256-CBC
 */
export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt an AES-256-CBC encrypted secret
 */
export function decryptSecret(cipherText: string): string {
  const parts = cipherText.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  let decrypted = decipher.update(encryptedText, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

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
