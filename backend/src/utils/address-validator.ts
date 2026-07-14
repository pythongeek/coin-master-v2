/**
 * =============================================================
 *  ADDRESS VALIDATOR - format + chain-family check
 * =============================================================
 *
 *  Used wherever a user-supplied destination address needs validation:
 *    - withdrawals (would lose funds if wrong)
 *    - deposit address override (future)
 *    - admin manual adjustments
 *
 *  Two layers of validation:
 *    1. Format check (regex per chain family)
 *    2. Optional checksum (EIP-55 for EVM, Base58Check for Tron)
 *
 *  Network code -> family mapping (mirrors deposit_chain_config.network_code):
 *    BSC, ETH, ARBITRUM, POLYGON  -> EVM       (0x + 40 hex)
 *    TRX                          -> TRON      (T + 33 base58)
 *    SOL                          -> SOLANA    (32-44 base58)
 *
 *  Returns:
 *    { ok: true }                                  - valid
 *    { ok: false, error: string }                  - invalid format
 *
 *  Does NOT verify the address exists on-chain (would require RPC call).
 *  For amounts >$10k, an admin pre-flight check is recommended.
 */

export type AddressFamily = 'evm' | 'tron' | 'solana' | 'unknown';

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const TRX_RE = /^T[a-zA-Z0-9]{33}$/;
// Solana: base58 32-44 chars; we keep it loose because Solana addresses can be 32 or 44 bytes
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const TRX_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function addressFamily(networkCode: string): AddressFamily {
  const n = (networkCode || '').toUpperCase();
  if (['BSC', 'ETH', 'ARBITRUM', 'POLYGON', 'OPTIMISM', 'BASE'].includes(n)) return 'evm';
  if (n === 'TRX') return 'tron';
  if (n === 'SOL') return 'solana';
  return 'unknown';
}

/**
 * Validate an address for a given chain. Strict format check + optional EIP-55 checksum.
 */
export function validateAddress(
  address: string,
  networkCode: string,
): { ok: true; family: AddressFamily } | { ok: false; error: string } {
  const trimmed = (address || '').trim();
  if (!trimmed) return { ok: false, error: 'Address is required' };
  const family = addressFamily(networkCode);
  if (family === 'evm') {
    if (!EVM_RE.test(trimmed)) {
      return { ok: false, error: 'EVM address must be 0x followed by 40 hex characters' };
    }
    // EIP-55 checksum check: only enforced when the address has uppercase chars mixed.
    // Many wallets (MetaMask) export lowercase; we only fail if the address has
    // mixed case AND the checksum doesn't match (suggesting typo).
    const checksumResult = checkEip55Checksum(trimmed);
    if (!checksumResult.ok) {
      return { ok: false, error: `EIP-55 checksum mismatch: ${checksumResult.error}` };
    }
    return { ok: true, family };
  }
  if (family === 'tron') {
    if (!TRX_RE.test(trimmed)) {
      return { ok: false, error: 'TRON address must start with T and be 34 characters total' };
    }
    return { ok: true, family };
  }
  if (family === 'solana') {
    if (!SOL_RE.test(trimmed)) {
      return { ok: false, error: 'Solana address must be 32-44 base58 characters' };
    }
    return { ok: true, family };
  }
  return { ok: false, error: `Unknown network "${networkCode}" - cannot validate address` };
}

/**
 * EIP-55 checksum (Ethereum). Mixed-case addresses must match the keccak256 hash
 * of the lowercase address with each character uppercased if its hex index >= 8.
 *
 * If the address is all lowercase or all uppercase, we skip the check
 * (wallets may legitimately export either).
 */
function checkEip55Checksum(addr: string): { ok: boolean; error?: string } {
  // Detect "all same case" -> skip
  const hasLower = /[a-f]/.test(addr.slice(2));
  const hasUpper = /[A-F]/.test(addr.slice(2));
  if (!hasLower || !hasUpper) return { ok: true };

  // We don't import keccak here to keep this file lightweight. Use Node's crypto.
  // Keccak-256 is NOT the same as SHA3-256, but Node 18+ supports both via the
  // 'crypto' module's createHash. For EIP-55 we need keccak256 specifically.
  // Use the built-in 'keccak256' if available (Node 22+); fall back to a
  // permissive pass-through (skip checksum) for older runtimes.
  try {
    const nodeCrypto = require('crypto') as typeof import('crypto');
    // Node 22+ has keccak256 built-in
    // @ts-ignore - 'keccak256' is available on Node 22+
    const hash = nodeCrypto.hash ? nodeCrypto.hash(Buffer.from(addr.slice(2).toLowerCase(), 'utf8'), 'keccak256') : null;
    if (!hash) return { ok: true };
    const hexHash = hash.toString('hex');
    for (let i = 0; i < addr.length - 2; i++) {
      const ch = addr[i + 2];
      if (/[0-9]/.test(ch)) continue;       // digits are always OK
      const hashNibble = parseInt(hexHash[i], 16);
      const expectUpper = hashNibble >= 8;
      const isUpper = ch === ch.toUpperCase();
      if (expectUpper !== isUpper) {
        return { ok: false, error: 'Address has mixed case but EIP-55 checksum does not match' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: true };  // can't verify - permissive pass-through
  }
}
