/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET CONNECT — Web3 ওয়ালেট কানেকশন লজিক
 * ═══════════════════════════════════════════════════════════════
 *
 *  MetaMask (Ethereum/BSC) ও Phantom (Solana) — দুটোই সাপোর্ট করে।
 *
 *  কীভাবে কাজ করে (সহজ বাংলায়):
 *  ──────────────────────────────────────────────────────────────
 *  ১. ব্রাউজারে এক্সটেনশন ইন্সটল আছে কিনা চেক করো
 *  ২. ইউজারকে কানেক্ট করতে অনুরোধ করো (পপআপ খুলবে)
 *  ৩. ওয়ালেট অ্যাড্রেস পাও
 *  ৪. একটি বার্তায় সাইন করতে বলো (প্রমাণ যে ওয়ালেটটি তারই)
 *  ৫. ব্যাকএন্ডে পাঠাও → লগইন সম্পন্ন
 * ═══════════════════════════════════════════════════════════════
 */

// ── TypeScript: window.ethereum এর জন্য টাইপ ────────────────────
interface EthereumProvider {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

interface SolanaProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  disconnect: () => Promise<void>;
  signMessage: (msg: Uint8Array) => Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
    solana?: SolanaProvider;
  }
}

export type WalletType = 'metamask' | 'phantom';

export interface WalletConnection {
  address:   string;
  type:      WalletType;
  signature: string;
  // P2-22: timestamp + nonce are server-issued and embedded in the
  // signed message. The backend's buildSignMessage(addr, timestamp, nonce)
  // reconstructs the exact message that was signed; without these the
  // signature can't verify (the previous wallet-login bug at HEAD).
  timestamp: string;
  nonce:     string;
}

/**
 * P2-22: fetch a server-issued challenge (nonce + canonical timestamp)
 * before asking the wallet to sign. The backend stores the nonce in
 * Redis with a 5-minute TTL and atomically consumes it on login.
 */
interface WalletChallenge {
  success:           boolean;
  nonce:             string;
  timestamp:         string;
  expiresInSeconds:  number;
  messageFormat:     string;
}

async function fetchWalletChallenge(): Promise<WalletChallenge> {
  const res = await fetch('/api/auth/wallet/challenge', {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error('চ্যালেঞ্জ নেওয়া যায়নি। আবার চেষ্টা করুন।');
  }
  const data = await res.json();
  if (!data.success || !data.nonce || !data.timestamp) {
    throw new Error('চ্যালেঞ্জ অবৈধ।');
  }
  return data as WalletChallenge;
}

// ── এক্সটেনশন ইন্সটল আছে কিনা চেক ────────────────────────────────
export function isMetaMaskInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum?.isMetaMask;
}

export function isPhantomInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.solana?.isPhantom;
}

// ── MetaMask কানেক্ট করো ─────────────────────────────────────────
export async function connectMetaMask(): Promise<WalletConnection> {
  if (!window.ethereum) {
    throw new Error('MetaMask ইন্সটল করা নেই। ব্রাউজার এক্সটেনশন ইন্সটল করুন।');
  }

  // ধাপ ১: অ্যাকাউন্ট অ্যাক্সেস চাও
  const accounts = await window.ethereum.request({
    method: 'eth_requestAccounts',
  }) as string[];

  if (!accounts || !accounts.length) {
    throw new Error('কোনো অ্যাকাউন্ট পাওয়া যায়নি।');
  }

  const address = accounts[0];

  // ধাপ ২: প্রমাণের জন্য একটি বার্তায় সাইন করতে বলো
  const challenge = await fetchWalletChallenge();

  const message = `CryptoFlip-এ লগইন করছেন।\n\nওয়ালেট: ${address}\nসময়: ${challenge.timestamp}\nননস: ${challenge.nonce}`;
  const signature = await window.ethereum.request({
    method: 'personal_sign',
    params: [message, address],
  }) as string;

  return { address, type: 'metamask', signature, timestamp: challenge.timestamp, nonce: challenge.nonce };
}

// ── Phantom কানেক্ট করো ──────────────────────────────────────────
export async function connectPhantom(): Promise<WalletConnection> {
  if (!window.solana) {
    throw new Error('Phantom ইন্সটল করা নেই। ব্রাউজার এক্সটেনশন ইন্সটল করুন।');
  }

  // ধাপ ১: কানেক্ট করো
  const resp = await window.solana.connect();
  const address = resp.publicKey.toString();

  // P2-22: get a server-issued nonce + timestamp before signing. See
  // connectMetaMask for the rationale — the bug at HEAD was that the
  // backend rebuilt the message with a fresh timestamp so the signature
  // never verified.
  const challenge = await fetchWalletChallenge();

  // ধাপ ২: প্রমাণের জন্য সাইন করো
  const message = `CryptoFlip-এ লগইন করছেন।\n\nওয়ালেট: ${address}\nসময়: ${challenge.timestamp}\nননস: ${challenge.nonce}`;
  const encoded = new TextEncoder().encode(message);
  const { signature } = await window.solana.signMessage(encoded);
  const signatureHex = Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

  return { address, type: 'phantom', signature: signatureHex, timestamp: challenge.timestamp, nonce: challenge.nonce };
}

// ── ওয়ালেট ডিসকানেক্ট ─────────────────────────────────────────
export async function disconnectWallet(type: WalletType): Promise<void> {
  if (type === 'phantom' && window.solana) {
    await window.solana.disconnect();
  }
  // MetaMask-এর কোনো disconnect API নেই — শুধু লোকাল স্টেট ক্লিয়ার করতে হয়
}

// ── অ্যাড্রেস সংক্ষেপে দেখাও ──────────────────────────────────
export function shortenAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
