import './helpers/enable-real-provably-fair';
import { resolveFlip, verifyFlip, hashServerSeed, generateServerSeed } from '../services/provably-fair';

async function runTests() {
  console.log('🧪 Starting Progressive Multipliers & Provably Fair Tests...');

  try {
    // 1. Verify winChance and payout calculations for different target multipliers
    console.log('\nScenario 1: Verifying winChance and multiplier calculations...');
    const houseEdge = 2.0; // 2%
    
    const targets = [
      { target: 2.0, expectedChance: 49.0 },
      { target: 10.0, expectedChance: 9.8 },
      { target: 1.01, expectedChance: 97.02970297 },
      { target: 1027604.48, expectedChance: 0.000095367 }
    ];

    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = 'test-client-seed';
    const seeds = { serverSeed, serverSeedHash, clientSeed, nonce: 1 };

    for (const t of targets) {
      const outcome = resolveFlip(seeds, 'heads', 100.00, houseEdge, t.target);
      const calculatedChance = (100 - houseEdge) / t.target;
      
      console.log(`Target: ${t.target}x -> Calculated Win Chance: ${outcome.winChance.toFixed(6)}% | Payout if won: $${(100.00 * t.target).toFixed(2)}`);
      
      // Allow minor float differences
      if (Math.abs(outcome.winChance - calculatedChance) > 1e-6) {
        throw new Error(`Win chance calculation discrepancy for target ${t.target}`);
      }
      if (outcome.targetMultiplier !== t.target || outcome.actualMultiplier !== t.target) {
        throw new Error(`Multiplier mapping mismatch: target=${outcome.targetMultiplier}, actual=${outcome.actualMultiplier}`);
      }
    }
    console.log('✅ Multiplier calculations verified successfully.');

    // 2. Verify roll resolution (WIN vs LOSS boundaries)
    console.log('\nScenario 2: Verifying WIN / LOSS resolution logic based on HMAC rolls...');
    // We will search for a nonce that produces a winning roll, and another that produces a losing roll
    // for a target multiplier of 10.0 (win chance = 9.8%)
    const target = 10.0;
    const targetWinChance = (100 - houseEdge) / target; // 9.8%

    let winNonce = 1;
    let loseNonce = 1;
    
    // Find win and lose nonces
    for (let nonce = 1; nonce < 1000; nonce++) {
      const outcome = resolveFlip({ serverSeed, serverSeedHash, clientSeed, nonce }, 'heads', 10.00, houseEdge, target);
      if (outcome.won && winNonce === 1) {
        winNonce = nonce;
      }
      if (!outcome.won && loseNonce === 1) {
        loseNonce = nonce;
      }
      if (winNonce !== 1 && loseNonce !== 1) {
        break;
      }
    }

    console.log(`Found Win Nonce: ${winNonce}, Lose Nonce: ${loseNonce}`);

    // Verify win outcome details
    const winOutcome = resolveFlip({ serverSeed, serverSeedHash, clientSeed, nonce: winNonce }, 'heads', 10.00, houseEdge, target);
    if (winOutcome.won && winOutcome.roll < targetWinChance && winOutcome.result === 'heads' && winOutcome.payout === 100.00) {
      console.log(`✅ Win outcome verified: roll = ${winOutcome.roll.toFixed(4)}% (< ${targetWinChance}%), result = "heads", payout = $${winOutcome.payout.toFixed(2)}`);
    } else {
      throw new Error(`Invalid win outcome resolution: ${JSON.stringify(winOutcome)}`);
    }

    // Verify lose outcome details
    const loseOutcome = resolveFlip({ serverSeed, serverSeedHash, clientSeed, nonce: loseNonce }, 'heads', 10.00, houseEdge, target);
    if (!loseOutcome.won && loseOutcome.roll >= targetWinChance && loseOutcome.result === 'tails' && loseOutcome.payout === 0) {
      console.log(`✅ Loss outcome verified: roll = ${loseOutcome.roll.toFixed(4)}% (>= ${targetWinChance}%), result = "tails", payout = $${loseOutcome.payout.toFixed(2)}`);
    } else {
      throw new Error(`Invalid loss outcome resolution: ${JSON.stringify(loseOutcome)}`);
    }

    // 3. Verify user verification endpoint behavior
    console.log('\nScenario 3: Verifying verifyFlip helper for player verification...');
    const verifyResultWin = verifyFlip({
      serverSeed,
      clientSeed,
      nonce: winNonce,
      serverSeedHash,
      choice: 'heads',
      targetMultiplier: target,
      houseEdge
    });

    if (verifyResultWin.isValid && verifyResultWin.result === 'heads' && verifyResultWin.explanation.includes('Win')) {
      console.log('✅ Win verification validated: correctly verified result and printed "Win".');
    } else {
      throw new Error(`Win verification failed: ${JSON.stringify(verifyResultWin)}`);
    }

    const verifyResultLose = verifyFlip({
      serverSeed,
      clientSeed,
      nonce: loseNonce,
      serverSeedHash,
      choice: 'heads',
      targetMultiplier: target,
      houseEdge
    });

    if (verifyResultLose.isValid && verifyResultLose.result === 'tails' && verifyResultLose.explanation.includes('Loss')) {
      console.log('✅ Loss verification validated: correctly verified result and printed "Loss".');
    } else {
      throw new Error(`Loss verification failed: ${JSON.stringify(verifyResultLose)}`);
    }

    console.log('\n🎉 All progressive multiplier & provably fair tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
