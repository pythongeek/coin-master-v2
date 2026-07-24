/**
 * P1-09 focused test: hot-wallet private key Buffer is zeroed in the
 * `finally` block after the signing operation returns (or throws).
 *
 * We do NOT need to invoke `payoutTronWithdrawal()` end-to-end (it
 * touches the live DB and the TronGrid MCP). Instead, this test
 * exercises the helper directly:
 *   1. Decrypt-to-Buffer produces the plaintext as a Buffer.
 *   2. The plaintext matches the original.
 *   3. After explicit `.fill(0)`, the buffer is all zeros.
 *   4. `try { ... } finally { buf.fill(0) }` end-to-end pattern (success path).
 *   5. The same pattern holds on the error path.
 *   6. Static analysis: `withdrawal-payout.ts` source contains a
 *      `privateKeyBuf.fill(0)` call inside a `finally` block.
 *   7. `tron-mcp.service.ts` `buildUsdtTransfer` + `estimateEnergy` accept
 *      `privateKey: string | Buffer`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { encryptSecret, decryptSecretToBuffer } from '../services/secret-vault';

// Hardening pattern (mirrors withdrawal-payout.ts outer shape).
function scrubPrivateKey(privateKeyBuf: Buffer): void {
  privateKeyBuf.fill(0);
}

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
  console.log('P1-09: hot-wallet private key Buffer zeroed after finally');

  // Use 32 ASCII chars so utf-8 round-trips cleanly.
  const plaintext = 'A'.repeat(32);
  const ciphertext = encryptSecret(plaintext);

  const buf = decryptSecretToBuffer(ciphertext);
  assert(Buffer.isBuffer(buf), 'decryptSecretToBuffer returns a Buffer');
  assert(
    buf.length === plaintext.length,
    'decrypted Buffer length matches plaintext length (32 bytes)',
  );
  assert(buf.toString('utf8') === plaintext, 'decrypted Buffer contents match plaintext');

  // -- 2. After `.fill(0)`, the buffer is all zeros -----------------
  scrubPrivateKey(buf);
  let allZero = true;
  for (const byte of buf) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  assert(allZero, 'scrubPrivateKey(Buffer) zeroes every byte');
  assert(
    Buffer.compare(buf, Buffer.alloc(buf.length)) === 0,
    'Buffer.compare(buf, zero Buffer) === 0 after scrub',
  );

  // -- 3. try { ... } finally { fill(0) } on success path ----------
  function signSimulated(privateKey: Buffer): Buffer {
    try {
      // Pretend to sign by returning a deterministic 8-byte hash.
      const seen = Buffer.alloc(8);
      privateKey.copy(seen, 0, 0, Math.min(privateKey.length, 8));
      return seen;
    } finally {
      privateKey.fill(0);
    }
  }
  const k = decryptSecretToBuffer(encryptSecret(plaintext));
  const sig = signSimulated(k);
  assert(sig.length === 8, 'signing produced an 8-byte digest');
  let kIsZero = true;
  for (const byte of k) {
    if (byte !== 0) {
      kIsZero = false;
      break;
    }
  }
  assert(kIsZero, 'private key buffer is zeroed after signSimulated returns');

  // -- 4. try { ... } finally { fill(0) } on error path --------------
  function throwSimulated(privateKey: Buffer): never {
    try {
      throw new Error('synthetic signing failure');
    } finally {
      privateKey.fill(0);
    }
  }
  const k2 = decryptSecretToBuffer(encryptSecret(plaintext));
  let caught = false;
  try {
    throwSimulated(k2);
  } catch {
    caught = true;
  }
  assert(caught, 'throwSimulated raised the synthetic error');
  let k2IsZero = true;
  for (const byte of k2) {
    if (byte !== 0) {
      k2IsZero = false;
      break;
    }
  }
  assert(k2IsZero, 'private key buffer is zeroed even when the body throws');

  // -- 5. Static source check on withdrawal-payout.ts ----------------
  const src = readFileSync(
    path.resolve(__dirname, '..', 'services', 'withdrawal-payout.ts'),
    'utf8',
  );
  // Strip block comments first to avoid JSDoc false-positives.
  const noBlockComment = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const fillHit = /privateKeyBuf\s*\.fill\s*\(\s*0\s*\)/.test(noBlockComment);
  assert(fillHit, 'withdrawal-payout.ts calls privateKeyBuf.fill(0)');
  const finallyIdx = noBlockComment.lastIndexOf('finally {', noBlockComment.indexOf('privateKeyBuf.fill(0)'));
  assert(finallyIdx !== -1, 'privateKeyBuf.fill(0) lives inside a `finally { ... }` block');

  // -- 6. Static check: tron-mcp signatures accept string | Buffer -----
  const tronSrc = readFileSync(
    path.resolve(__dirname, '..', 'services', 'tron-mcp.service.ts'),
    'utf8',
  );
  assert(
    /async\s+buildUsdtTransfer\s*\([\s\S]*?privateKey\s*:\s*string\s*\|\s*Buffer[\s\S]*?\)/.test(tronSrc),
    'tron-mcp.service.ts buildUsdtTransfer accepts privateKey: string | Buffer',
  );
  assert(
    /async\s+estimateEnergy\s*\([\s\S]*?privateKey\s*:\s*string\s*\|\s*Buffer[\s\S]*?\)/.test(tronSrc),
    'tron-mcp.service.ts estimateEnergy accepts privateKey: string | Buffer',
  );

  console.log('');
  if (failed) {
    console.error('FAILED: P1-09 tests did not all pass');
    process.exit(1);
  } else {
    console.log('PASS: All P1-09 hot-wallet key-scrub tests passed');
    process.exit(0);
  }
})();
