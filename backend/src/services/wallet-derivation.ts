import { ethers } from 'ethers';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { TronWeb } from 'tronweb';
import { query } from '../config/database';
import { redis } from '../config/redis';

// Standard BIP44 derivation paths
// EVM: m/44'/60'/0'/0/index
// Solana: m/44'/501'/index'/0'
// Tron: m/44'/195'/0'/0/index

const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk';

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
 * Get or derive a deposit wallet address for a user on a specific chain
 */
export async function getOrCreateUserWallet(userId: string, chain: 'ethereum' | 'solana' | 'tron'): Promise<DerivedWallet> {
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

  // 2. Derive new address
  // Use Redis to safely increment the address index for this chain to prevent collision
  const redisKey = `address_index:${chain}`;
  const index = await redis.incr(redisKey);

  let derived: DerivedWallet;
  if (chain === 'ethereum') {
    derived = deriveEVMWallet(MNEMONIC, index);
  } else if (chain === 'solana') {
    derived = await deriveSolanaWallet(MNEMONIC, index);
  } else if (chain === 'tron') {
    derived = deriveTronWallet(MNEMONIC, index);
  } else {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  // 3. Save native and stablecoin wallets to database
  if (chain === 'ethereum') {
    // Native ETH
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'ETH', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index]
    );
    // ERC20 USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index, USDT_CONTRACT_EVM]
    );
    // ERC20 USDC
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDC', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index, USDC_CONTRACT_EVM]
    );
  } else if (chain === 'solana') {
    // Native SOL
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'SOL', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index]
    );
    // SPL USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index, USDT_MINT_SOLANA]
    );
    // SPL USDC
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDC', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index, USDC_MINT_SOLANA]
    );
  } else if (chain === 'tron') {
    // Native TRX
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'TRX', $3, $4, NULL)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index]
    );
    // TRC20 USDT
    await query(
      `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index, token_address)
       VALUES ($1, $2, 'USDT', $3, $4, $5)
       ON CONFLICT (user_id, chain, token_address) DO UPDATE SET deposit_address = $3`,
      [userId, chain, derived.address, derived.index, USDT_CONTRACT_TRON]
    );
  }

  return derived;
}
