import { shortenAddress } from '@/lib/wallet';

describe('shortenAddress', () => {
  it('shortens a long Ethereum address', () => {
    const addr = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb';
    expect(shortenAddress(addr)).toBe('0x742d...0bEb');
  });

  it('returns the original string if shorter than 10 chars', () => {
    expect(shortenAddress('abc')).toBe('abc');
    expect(shortenAddress('123456789')).toBe('123456789');
  });

  it('handles empty string', () => {
    expect(shortenAddress('')).toBe('');
  });

  it('handles exactly 10 characters', () => {
    const addr = '1234567890';
    expect(shortenAddress(addr)).toBe('123456...7890');
  });

  it('handles Solana addresses', () => {
    const addr = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
    expect(shortenAddress(addr)).toBe('HN7cAB...YWrH');
  });
});
