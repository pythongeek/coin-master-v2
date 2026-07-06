import { verifyMessage as ethersVerifyMessage } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import TronWebModule from 'tronweb';
import * as nacl from 'tweetnacl';

export type WalletType = 'evm' | 'solana' | 'tron';

/**
 * Reconstruct the exact message the frontend signs. This MUST stay byte-for-byte
 * in sync with frontend/lib/wallet.ts connectMetaMask/connectPhantom.
 */
export function buildSignMessage(walletAddress: string, timestamp?: string): string {
  const time = timestamp || new Date().toISOString();
  return `CryptoFlip-এ লগইন করছেন।\n\nওয়ালেট: ${walletAddress}\nসময়: ${time}`;
}

/**
 * Detect wallet type from address format.
 */
export function detectWalletType(address: string): WalletType {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'evm';
  if (/^[a-zA-Z0-9]{32,44}$/.test(address) && !address.startsWith('T')) return 'solana';
  if (/^T[a-zA-Z0-9]{33}$/.test(address)) return 'tron';
  throw new Error('Unsupported wallet address format');
}

/**
 * Verify a wallet signature for a given address.
 */
export function verifyWalletSignature(
  walletAddress: string,
  signature: string | undefined,
  expectedMessage: string
): boolean {
  if (!signature || signature.trim() === '') {
    return false;
  }
  const type = detectWalletType(walletAddress);
  try {
    if (type === 'evm') {
      const recovered = ethersVerifyMessage(expectedMessage, signature);
      return recovered.toLowerCase() === walletAddress.toLowerCase();
    }
    if (type === 'solana') {
      const pubkey = new PublicKey(walletAddress);
      const messageBytes = new TextEncoder().encode(expectedMessage);
      const signatureBytes = Buffer.from(signature, 'hex');
      if (signatureBytes.length !== 64) return false;
      return naclVerifySolana(signatureBytes, messageBytes, pubkey.toBytes());
    }
    if (type === 'tron') {
      const TronWeb = (TronWebModule as any).TronWeb || (TronWebModule as any).default || TronWebModule;
      const tw = new TronWeb({ fullHost: process.env.TRON_RPC_URL || 'https://api.trongrid.io' });
      return tw.trx.verifyMessage(expectedMessage, signature, walletAddress);
    }
    return false;
  } catch (err) {
    console.error('Wallet signature verification error:', err);
    return false;
  }
}

// Solana signature verification using @solana/web3.js internals (ed25519).
function naclVerifySolana(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const { sign } = require('tweetnacl');
    return sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}
