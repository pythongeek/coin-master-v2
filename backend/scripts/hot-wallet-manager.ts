#!/usr/bin/env ts-node
import crypto from 'crypto';
import fs from 'fs';
import { TronWeb } from 'tronweb';
import { encryptSecret, decryptSecret } from '../src/services/secret-vault';

const CMD = process.argv[2];

function generateSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

function encryptSeed(seed: string): string {
  return 'seed:' + encryptSecret(seed);
}

function setEnvVar(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${value}`);
  }
  return content + `\n${key}=${value}\n`;
}

function decryptSeed(encrypted: string): string {
  if (!encrypted.startsWith('seed:')) throw new Error('Invalid seed format');
  return decryptSecret(encrypted.slice(5));
}

async function main() {
  if (CMD === 'generate') {
    const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
    const account = await (tw as any).createAccount();
    const address = account.address.base58;
    const privateKey = account.privateKey;
    const encryptedPrivateKey = encryptSecret(privateKey);
    const encryptedDerivationSeed = encryptSeed(generateSeed());

    console.log('✅ New hot wallet generated');
    console.log('HOT_WALLET_ADDRESS=' + address);
    console.log('HOT_WALLET_PRIVATE_KEY_ENCRYPTED=' + encryptedPrivateKey);
    console.log('DEPOSIT_DERIVATION_SEED_ENCRYPTED=' + encryptedDerivationSeed);
    console.log('\n⚠️  Save the private key and seed in a password manager. The encrypted values are safe for .env.');

  } else if (CMD === 'encrypt') {
    const key = process.argv[3];
    if (!key) {
      console.error('Usage: npx ts-node scripts/hot-wallet-manager.ts encrypt <private-key-or-seed>');
      process.exit(1);
    }
    console.log('HOT_WALLET_PRIVATE_KEY_ENCRYPTED=' + encryptSecret(key));

  } else if (CMD === 'encrypt-seed') {
    const seed = process.argv[3];
    if (!seed) {
      console.error('Usage: npx ts-node scripts/hot-wallet-manager.ts encrypt-seed <hex-seed>');
      process.exit(1);
    }
    console.log('DEPOSIT_DERIVATION_SEED_ENCRYPTED=' + encryptSeed(seed));

  } else if (CMD === 'rotate') {
    const envFile = process.argv[3] || '.env';
    const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
    const account = await (tw as any).createAccount();
    const address = account.address.base58;
    const encryptedPrivateKey = encryptSecret(account.privateKey);
    const encryptedDerivationSeed = encryptSeed(generateSeed());

    if (!fs.existsSync(envFile)) {
      console.error('Env file not found:', envFile);
      process.exit(1);
    }

    let env = fs.readFileSync(envFile, 'utf8');
    env = setEnvVar(env, 'HOT_WALLET_ADDRESS', address);
    env = setEnvVar(env, 'HOT_WALLET_PRIVATE_KEY_ENCRYPTED', encryptedPrivateKey);
    env = setEnvVar(env, 'DEPOSIT_DERIVATION_SEED_ENCRYPTED', encryptedDerivationSeed);
    fs.writeFileSync(envFile, env);
    console.log('✅ Hot wallet rotated in', envFile);
    console.log('HOT_WALLET_ADDRESS=' + address);
    console.log('⚠️  Migrate funds from old wallet to this address and update pending deposit addresses.');

  } else if (CMD === 'verify') {
    const encryptedKey = process.argv[3];
    const address = process.argv[4];
    if (!encryptedKey || !address) {
      console.error('Usage: npx ts-node scripts/hot-wallet-manager.ts verify <encrypted-key> <address>');
      process.exit(1);
    }
    const privateKey = decryptSecret(encryptedKey);
    const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
    const derived = (tw as any).address.fromPrivateKey(privateKey);
    if (derived === address) {
      console.log('✅ Encrypted key matches address', derived);
    } else {
      console.error('❌ Mismatch: derived', derived, 'expected', address);
      process.exit(1);
    }

  } else if (CMD === 'derive') {
    const encryptedSeed = process.argv[3];
    const userId = process.argv[4];
    if (!encryptedSeed || !userId) {
      console.error('Usage: npx ts-node scripts/hot-wallet-manager.ts derive <encrypted-seed> <user-id>');
      process.exit(1);
    }
    const seed = decryptSeed(encryptedSeed);
    const fullSeed = `${seed}:${userId}`;
    const hash = crypto.createHash('sha256').update(fullSeed).digest('hex');
    const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
    const derived = (tw as any).address.fromPrivateKey(hash);
    console.log('Derived deposit address:', derived);

  } else {
    console.log(`\nUsage: npx ts-node scripts/hot-wallet-manager.ts <command>\n\nCommands:\n  generate          Generate a new hot wallet + encrypted seed\n  encrypt <key>    Encrypt a private key or seed\n  encrypt-seed <seed>\n  rotate [envFile]  Rotate hot wallet in .env\n  verify <encrypted> <address>\n  derive <encrypted-seed> <user-id>\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌ Error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
