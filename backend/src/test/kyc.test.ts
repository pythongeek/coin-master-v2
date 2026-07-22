import { query } from '../config/database';
import { getKycSettings, setKycApiKey, setKycSettings, clearKycApiKey } from '../services/kyc-settings';
import { encryptSecret, decryptSecret } from '../services/secret-vault';
import { calculateKycRisk } from '../services/kyc-risk';
import { submitKycVerification } from '../services/kyc-session';

/**
 * KYC Integration Test
 *
 * Exercises the custom MiniMax-powered KYC flow without calling the real
 * MiniMax API.
 */

process.env.KYC_SECRET_ENCRYPTION_KEY = 'kyc_test_encryption_key_that_is_32bytes!';

const testUserEmail = 'kycuser_test@example.com';
const adminEmail = 'kycadmin_test@example.com';

let userId: string;
let adminUserId: string;

async function setup() {
  const userRes = await query(
    `INSERT INTO users (username, email, password_hash, role, is_active, kyc_status)
     VALUES ($1, $2, $3, 'user', true, 'unverified')
     RETURNING id`,
    ['kycuser_test', testUserEmail, 'fakehash']
  );
  userId = userRes.rows[0].id;

  const adminRes = await query(
    `INSERT INTO users (username, email, password_hash, role, is_active, kyc_status)
     VALUES ($1, $2, $3, 'super_admin', true, 'approved')
     RETURNING id`,
    ['kycadmin_test', adminEmail, 'fakehash']
  );
  adminUserId = adminRes.rows[0].id;
}

async function cleanup() {
  await query('DELETE FROM kyc_sessions WHERE user_id = $1', [userId]);
  await query('DELETE FROM users WHERE id IN ($1, $2)', [userId, adminUserId]);
  await clearKycApiKey().catch(() => {});
}

// Minimal base64 image (1x1 transparent PNG)
const dummyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function runTests() {
  try {
    await setup();

    console.log('Scenario 1: Secret vault encrypt/decrypt');
    const secret = 'sk-cp-...6789';
    const encrypted = encryptSecret(secret);
    if (encrypted === secret) throw new Error('Encryption did not change the value');
    const decrypted = decryptSecret(encrypted);
    if (decrypted !== secret) throw new Error('Decryption returned wrong value');
    console.log('✅ Secret vault works');

    console.log('Scenario 2: KYC settings default');
    const settings = await getKycSettings();
    if (settings.provider !== 'manual') throw new Error('Expected default provider manual');
    if (settings.minimaxApiKeySet) throw new Error('Expected no API key by default');
    console.log('✅ Default settings correct');

    console.log('Scenario 3: Save and read MiniMax API key');
    await setKycApiKey('sk-cp-...6789');
    const settings2 = await getKycSettings();
    if (!settings2.minimaxApiKeySet) throw new Error('API key should be set');
    if (settings2.minimaxApiKey !== 'sk-cp-...6789') throw new Error('API key value mismatch');
    console.log('✅ API key saved and encrypted');

    console.log('Scenario 4: Update KYC settings');
    await setKycSettings({ provider: 'minimax', requiredForWithdrawal: true, requiredForBetAbove: 100 });
    const settings3 = await getKycSettings();
    if (settings3.provider !== 'minimax') throw new Error('Provider not updated');
    if (settings3.requiredForBetAbove !== 100) throw new Error('requiredForBetAbove not updated');
    console.log('✅ KYC settings updated');

    console.log('Scenario 5: Risk engine approves low-risk inputs');
    const risk = calculateKycRisk({
      minimax: {
        document_valid: true,
        extracted_fields: { full_name: 'John Doe', date_of_birth: '1990-01-01' },
        face_match: true,
        face_similarity_score: 0.95,
        liveness_passed: true,
        fraud_signals: ['none'],
        sanctions_risk: 'low',
        reasoning: 'All checks passed',
        recommended_decision: 'APPROVED',
      },
      quality: {
        document: { width: 1200, height: 800, format: 'jpeg', sizeBytes: 100000, brightness: 120, blurScore: 300, acceptable: true, reasons: [] },
        selfie: { width: 1200, height: 800, format: 'jpeg', sizeBytes: 100000, brightness: 120, blurScore: 300, acceptable: true, reasons: [] },
      },
      sanctions: { success: true, entity_name: 'John Doe', matches: [] },
      ocr: { text: 'John Doe', confidence: 95 },
    });
    if (risk.decision !== 'approved') throw new Error(`Expected approved, got ${risk.decision}`);
    if (risk.tier !== 'LOW') throw new Error(`Expected LOW tier, got ${risk.tier}`);
    console.log('✅ Risk engine approves clean inputs');

    console.log('Scenario 6: KYC submission without API key fails gracefully');
    await clearKycApiKey();
    await setKycSettings({ provider: 'manual' });
    try {
      await submitKycVerification(userId, dummyImage, dummyImage);
      throw new Error('Expected submission to fail without API key');
    } catch (err: any) {
      if (!err.message.includes('MiniMax API key is not configured')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    console.log('✅ Submission fails gracefully when provider is manual');

    console.log('\n🎉 All KYC tests passed!');
    await cleanup();
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n❌ KYC test failed:', msg);
    await cleanup().catch(() => {});
    process.exit(1);
  }
}

runTests();
