import { TronWeb } from 'tronweb';
import { decryptSecret } from '../src/services/secret-vault';
import crypto from 'crypto';

const seedEnc = process.argv[2];
const userId = process.argv[3];
const lockId = process.argv[4];
if (!seedEnc || !userId || !lockId) {
  console.error('Usage: ts-node derive-lock.ts <encrypted-seed> <userId> <lockId>');
  process.exit(1);
}
const seed = decryptSecret(seedEnc.replace('seed:', ''));
const fullSeed = `${seed}:${userId}:${lockId}`;
const hash = crypto.createHash('sha256').update(fullSeed).digest('hex');
const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
console.log(tw.address.fromPrivateKey(hash));
