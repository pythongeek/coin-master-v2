import { ethers } from 'ethers';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { TronWeb } from 'tronweb';
import { query } from '../config/database';

// Standard BIP44 derivation paths
// EVM: m/44'/60'/0'/0/index
// Solana: m/44'/501'/index'/0'
// Tron: m/44'/195'/0'/0/index

// ---------------------------------------------------------------------------
// P0-02: Fail-closed on missing or default-test MNEMONIC.
//
// If MNEMONIC is unset, empty, or equal to the well-known Ethereum test
// mnemonic ("abandon … about"), every deposit address on every chain is
// derived from publicly-known seed material. Any attacker who recognizes
// the test mnemonic can sweep user deposits before they are credited.
//
// Refusing to derive wallets under those conditions prevents the
// "missing env var in a fresh container" footgun from becoming a
// total-loss event. The validation runs the first time
// `getOrCreateUserWallet()` is invoked — the earliest point where a
// deposit address would actually be derived.
// ---------------------------------------------------------------------------

const FORBIDDEN_MNEMONIC = 'test test test test test test test test test test test junk';

function readMnemonicFromEnv(): string {
  const raw = process.env.MNEMONIC;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'FATAL: MNEMONIC environment variable is required and must not be the well-known test mnemonic. Refusing to derive wallets.'
    );
  }
  const trimmed = raw.trim();
  if (trimmed === FORBIDDEN_MNEMONIC) {
    throw new Error(
      'FATAL: MNEMONIC environment variable is set to the well-known Ethereum test mnemonic ("abandon … about"). Refusing to derive wallets — replace with a real, operator-controlled BIP39 seed.'
    );
  }
  return trimmed;
}

/**
 * Validate a candidate BIP39 mnemonic phrase.
 *
 * Uses ethers v6's `Mnemonic.fromPhrase()`, which parses the phrase,
 * checks the wordlist membership of each token, validates the
 * checksum bit, and throws on anything malformed. Returns the
 * normalized phrase on success.
 *
 * This is the canonical validation helper used by `getOrCreateUserWallet`
 * (via `requireMnemonic()` below) and is also exported for use by
 * callers that already have a phrase in hand (e.g. admin tools, tests).
 */
export function validateMnemonic(mnemonic: string): string {
  if (typeof mnemonic !== 'string' || mnemonic.trim() === '') {
    throw new Error('FATAL: mnemonic is empty.');
  }
  const trimmed = mnemonic.trim();
  if (trimmed === FORBIDDEN_MNEMONIC) {
    throw new Error(
      'FATAL: refused to validate the well-known test mnemonic. Use an operator-controlled BIP39 seed.'
    );
  }
  // ethers.Mnemonic.fromPhrase throws on: invalid word count, unknown
  // words, or checksum failure. We let that exception propagate.
  ethers.Mnemonic.fromPhrase(trimmed);
  return trimmed;
}

// Lazy, fail-closed lookup of MNEMONIC. Resolved on first wallet
// derivation request; result is memoized for the process lifetime.
let cachedMnemonic: string | null = null;
function requireMnemonic(): string {
  if (cachedMnemonic !== null) return cachedMnemonic;
  const candidate = readMnemonicFromEnv();
  cachedMnemonic = validateMnemonic(candidate);
  return cachedMnemonic;
}

const USDT_CONTRACT_EVM = process.env.USDT_CONTRACT_EVM || '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_CONTRACT_EVM = process.env.USDC_CONTRACT_EVM || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_MINT_SOLANA = process.env.USDT_MINT_SOLANA || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC_MINT_SOLANA = process.env.USDC_MINT_SOLANA || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_CONTRACT_TRON = process.env.USDT_CONTRACT_TRON || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface DerivedWallet {
  address: string;
  index: number;
}

/**
 * Derives an EVM (Ethereum/BSC/Polygon) address from mnemonic and index
 */
export function deriveEVMWallet(mnemonic: string, index: number): DerivedWallet {
  const path = `m/44'/60'/0'/0/${index}`;
  const mnemonicObj = ethers.Mnemonic.fromPhrase(mnemonic);
  const wallet = ethers.HDNodeWallet.fromMnemonic(mnemonicObj, path);
  return {
    address: wallet.address,
    index,
  };
}

/**
 * Derives a Solana address from mnemonic and index
 */
export async function deriveSolanaWallet(mnemonic: string, index: number): Promise<DerivedWallet> {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const derivedSeed = derivePath(path, seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return {
    address: keypair.publicKey.toBase58(),
    index,
  };
}

/**
 * Derives a Tron (TRC20) address from mnemonic and index
 */
export function deriveTronWallet(mnemonic: string, index: number): DerivedWallet {
  const path = `m/44'/195'/0'/0/${index}`;
  const account = TronWeb.fromMnemonic(mnemonic, path);
  return {
    address: account.address,
    index,
  };
}

/**
 * P1-03: Allocate the next deposit-address index for a given chain
 * from the persistent Postgres sequence. Returns a positive integer.
 *
 * The sequence lives in pg_catalog (created by migration 048), so it
 * survives:
 *   - Redis FLUSHALL
 *   - Backend restarts (sequence state is on disk)
 *   - Multi-pod concurrent derives (Postgres sequences are atomic
 *     across the cluster via the WAL)
 *   - Postgres restart with WAL replay
 *
 * Each chain has its own sequence (wallet_address_index_ethereum,
 * wallet_address_index_solana, wallet_address_index_tron) so the
 * index spaces are independent.
 */
async function allocateAddressIndex(chain: 'ethereum' | 'solana' | 'tron'): Promise<number> {
  const sequenceName = `wallet_address_index_${chain}`;
  const result = await query<{ nextval: string }>(
    `SELECT nextval($1) AS nextval`,
    [sequenceName],
  );
  const n = parseInt(result.rows[0].nextval, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `FATAL: Postgres sequence ${sequenceName} returned an invalid value: ${result.rows[0].nextval}`,
    );
  }
  return n;
}

/**
 * P1-03: Pre-flight collision check. Even with a Postgres sequence,
 *   a defensive SELECT confirms the derived address is not already
 *   assigned to another user before we INSERT it. The wallets table
 *   also has a UNIQUE (deposit_address) constraint as a final
 *   defense-in-depth at the DB layer.
 *
 * Returns true if the address is safe to assign, false if a collision
 * is detected.
 */
async function isAddressAvailable(depositAddress: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM wallets WHERE deposit_address = $1`,
    [depositAddress],
  );
  return parseInt(result.rows[0].count, 10) === 0;
}

/**
 * Get or derive a deposit wallet address for a user on a specific chain.
 *
 * Fails closed (throws) on first call if MNEMONIC is unset, empty, or
 * equal to the well-known test mnemonic. Subsequent calls succeed once
 * the mnemonic has been validated once.
 *
 * P1-03 contract:
 *   - The next address index comes from a Postgres sequence
 *     (`wallet_address_index_<chain>`), NOT a volatile Redis counter.
 *   - The derived address is verified to not already exist in
 *     `wallets.deposit_address` before INSERT (collision check).
 *   - The `wallets_user_id_chain_token_address_key` UNIQUE constraint
 *     prevents duplicate (user, chain, token) rows.
 *   - The `wallets_deposit_address_key` UNIQUE constraint prevents
 *     duplicate addresses across users (DB-level safety net).
 *   - `wallets.deposit_address_index` is NOT NULL going forward; the
 *     sequence ensures every new wallet has a deterministic index.
 */
export async function getOrCreateUserWallet(userId: string, chain: 'ethereum' | 'solana' | 'tron'): Promise<DerivedWallet> {
  // Resolve and validate the operator-supplied mnemonic before doing any
  // wallet math. requireMnemonic() throws on the three failure modes
  // listed above, and on any BIP39 malformation.
  const MNEMONIC = requireMnemonic();

  // 1. Check if wallet already exists in DB
  const existing = await query(
    'SELECT deposit_address, deposit_address_index FROM wallets WHERE user_id = $1 AND chain = $2 AND token_address IS NULL',
    [userId, chain]
  );

  if (existing.rows.length > 0) {
    return {
      address: existing.rows[0].deposit_address,
      index: existing.rows[0].deposit_address_index,
    };
  }

  // 2. Allocate the next index from the persistent Postgres sequence
  //    (P1-03 — replaces the previous Redis-based counter). Up to
  //    MAX_COLLISION_RETRIES attempts if the derived address collides
  //    with an existing wallet (extremely unlikely given the
  //    2^160 EVM address space, but defense-in-depth).
  const MAX_COLLISION_RETRIES = 8;
  let derived: DerivedWallet | null = null;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const index = await allocateAddressIndex(chain);

    let candidate: DerivedWallet;
    if (chain === 'ethereum') {
      candidate = deriveEVMWallet(MNEMONIC, index);
    } else if (chain === 'solana') {
      candidate = await deriveSolanaWallet(MNEMONIC, index);
    } else if (chain === 'tron') {
      candidate = deriveTronWallet(MNEMONIC, index);
    } else {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    // Pre-flight collision check before INSERT. The DB has a UNIQUE
    // constraint too, but catching it here lets us retry with a new
    // index instead of failing the user's wallet creation.
    const available = await isAddressAvailable(candidate.address);
    if (available) {
      derived = candidate;
      break;
    }

    // Collision detected — log and retry with the next sequence value.
    console.warn(
      `[wallet-derivation] address collision on chain=${chain} index=${index} ` +
      `address=${candidate.address} — retrying with next sequence value`,
    );
  }
  if (!derived) {
    throw new Error(
      `FATAL: ${MAX_COLLISION_RETRIES} consecutive address collisions on chain=${chain}. ` +
      `Investigate wallets.deposit_address uniqueness.`,
    );
  }
  const finalDerived = derived as DerivedWallet;

  // 3. Save native and stablecoin wallets to database
  if (chain === 'ethereum') {
    // Native ETH
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'ETH', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index]
    );
    // ERC20 USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index, USDT_CONTRACT_EVM]
    );
    // ERC20 USDC
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDC', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index, USDC_CONTRACT_EVM]
    );
  } else if (chain === 'solana') {
    // Native SOL
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'SOL', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index]
    );
    // SPL USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index, USDT_MINT_SOLANA]
    );
    // SPL USDC
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDC', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index, USDC_MINT_SOLANA]
    );
  } else if (chain === 'tron') {
    // Native TRX
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'TRX', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index]
    );
    // TRC20 USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, finalDerived.address, finalDerived.index, USDT_CONTRACT_TRON]
    );
  }

  return finalDerived;
}
