import { ethers } from 'ethers';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { query } from '../config/database';
import { redis } from '../config/redis';

// Standard BIP44 derivation paths
// EVM: m/44'/60'/0'/0/index
// Solana: m/44'/501'/index'/0'

const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk';

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
 * Get or derive a deposit wallet address for a user on a specific chain
 */
export async function getOrCreateUserWallet(userId: string, chain: 'ethereum' | 'solana'): Promise<DerivedWallet> {
  // 1. Check if wallet already exists in DB
  const existing = await query(
    'SELECT deposit_address, deposit_address_index FROM wallets WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );

  if (existing.rows.length > 0) {
    return {
      address: existing.rows[0].deposit_address,
      index: existing.rows[0].deposit_address_index,
    };
  }

  // 2. Derive new address
  // Use Redis to safely increment the address index for this chain to prevent collision
  const redisKey = `address_index:${chain}`;
  const index = await redis.incr(redisKey);

  let derived: DerivedWallet;
  if (chain === 'ethereum') {
    derived = deriveEVMWallet(MNEMONIC, index);
  } else if (chain === 'solana') {
    derived = await deriveSolanaWallet(MNEMONIC, index);
  } else {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const tokenSymbol = chain === 'ethereum' ? 'ETH' : 'SOL';

  // 3. Save to database
  await query(
    `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, chain, token_address) DO UPDATE
     SET deposit_address = $4, deposit_address_index = $5`,
    [userId, chain, tokenSymbol, derived.address, derived.index]
  );

  return derived;
}
