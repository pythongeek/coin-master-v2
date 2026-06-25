import { deriveEVMWallet, deriveSolanaWallet } from '../services/wallet-derivation';
import { verifyBinanceWebhook, signBinanceRequest } from '../services/merchant-payment';

import * as bip39 from 'bip39';

async function runTests() {
  console.log('🧪 Starting Wallet & Payment Integration Tests...');

  const mnemonic = bip39.generateMnemonic();

  try {
    // 1. Test EVM Derivation
    console.log('\nTesting EVM Derivation...');
    const evmWallet = deriveEVMWallet(mnemonic, 1);
    console.log(`Derived EVM address (index 1): ${evmWallet.address}`);
    if (evmWallet.address.startsWith('0x') && evmWallet.address.length === 42) {
      console.log('✅ EVM Address Derivation valid.');
    } else {
      throw new Error(`Invalid EVM address format: ${evmWallet.address}`);
    }

    // Consistency check
    const evmWallet2 = deriveEVMWallet(mnemonic, 1);
    if (evmWallet.address !== evmWallet2.address) {
      throw new Error('EVM addresses are inconsistent for the same index');
    }
    console.log('✅ EVM consistency verified.');

    // 2. Test Solana Derivation
    console.log('\nTesting Solana Derivation...');
    const solWallet = await deriveSolanaWallet(mnemonic, 1);
    console.log(`Derived Solana address (index 1): ${solWallet.address}`);
    if (solWallet.address.length >= 32 && solWallet.address.length <= 44) {
      console.log('✅ Solana Address Derivation valid.');
    } else {
      throw new Error(`Invalid Solana address format: ${solWallet.address}`);
    }

    // Consistency check
    const solWallet2 = await deriveSolanaWallet(mnemonic, 1);
    if (solWallet.address !== solWallet2.address) {
      throw new Error('Solana addresses are inconsistent for the same index');
    }
    console.log('✅ Solana consistency verified.');

    // 3. Test Binance Signature calculations
    console.log('\nTesting Binance Webhook Signature Verification...');
    const mockPayload = JSON.stringify({ bizType: 'PAY', data: { status: 'PAY_SUCCESS', merchantTradeNo: '12345' } });
    const mockNonce = 'randomnonce123';
    const mockTimestamp = Date.now();
    const mockSecret = 'mock_binance_secret';

    const sig = signBinanceRequest(mockPayload, mockNonce, mockTimestamp, mockSecret);
    const verified = verifyBinanceWebhook(mockPayload, sig, mockNonce, String(mockTimestamp));
    if (verified) {
      console.log('✅ Binance signature verification verified.');
    } else {
      throw new Error('Binance signature verification failed');
    }

    console.log('\n🎉 All local wallet unit tests passed successfully!');
    process.exit(0);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed: ${errorMsg}`);
    process.exit(1);
  }
}

runTests();
