import crypto from 'crypto';
import { computeFlipWithMultiplier, hashServerSeed } from '../src/services/provably-fair';

function findSeedForOutcome(
  clientSeed: string,
  choice: 'heads' | 'tails',
  desired: 'win' | 'loss',
  targetMultiplier = 2.0,
  houseEdge = 2.0
) {
  let attempts = 0;
  while (attempts < 100000) {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const { roll } = computeFlipWithMultiplier(serverSeed, clientSeed, 1, choice, targetMultiplier, houseEdge);
    const winChance = (100 - houseEdge) / targetMultiplier;
    const won = roll < winChance;
    if ((desired === 'win' && won) || (desired === 'loss' && !won)) {
      return { serverSeed, attempts: attempts + 1, hash: hashServerSeed(serverSeed) };
    }
    attempts++;
  }
  return null;
}

const clientSeed = 'user-chosen-seed-123';
const choice: 'heads' = 'heads';

const winSeed = findSeedForOutcome(clientSeed, choice, 'win');
const lossSeed = findSeedForOutcome(clientSeed, choice, 'loss');

console.log('=== Provably Fair Pre-Commitment Demo ===');
console.log('Client seed:', clientSeed);
console.log('User choice:', choice);
console.log('Desired win  → found server seed in', winSeed?.attempts, 'attempts');
console.log('Desired loss → found server seed in', lossSeed?.attempts, 'attempts');
console.log('\nThis proves the server can generate a seed AFTER seeing the user\'s choice and desired outcome.');
console.log('Without pre-committing the seed hash BEFORE the bet, the game is NOT provably fair.');
