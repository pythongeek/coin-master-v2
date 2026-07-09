import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { getKycSettings } from './kyc-settings';
import { verifyIdentityWithMiniMax } from './minimax-client';
import { runOcr } from './kyc-ocr';
import { checkImageQuality, normalizeImage } from './kyc-quality';
import { screenAgainstSanctions } from './kyc-sanctions';
import { calculateKycRisk, KycRiskResult } from './kyc-risk';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC SESSION SERVICE — Orchestrate the full KYC verification flow
 * ═══════════════════════════════════════════════════════════════
 */

export type KycStatus = 'pending' | 'approved' | 'review' | 'rejected';

export interface KycSubmissionResult {
  sessionId: string;
  status: KycStatus;
  riskScore: number;
  riskTier: string;
  decision: string;
  documentValid: boolean;
  faceMatch: boolean;
  faceSimilarity: number;
  livenessPassed: boolean;
  sanctionsClear: boolean;
  extractedFields: Record<string, string | undefined>;
  fraudSignals: string[];
  complianceReasoning: string;
}

export interface KycSessionRecord {
  id: string;
  user_id: string;
  status: KycStatus;
  external_session_id: string | null;
  risk_score: number | null;
  risk_tier: string | null;
  final_decision: string | null;
  document_valid: boolean | null;
  face_match: boolean | null;
  face_similarity: number | null;
  liveness_passed: boolean | null;
  sanctions_clear: boolean | null;
  extracted_fields: Record<string, string | undefined> | null;
  fraud_signals: string[] | null;
  compliance_reasoning: string | null;
  raw_result: unknown | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function submitKycVerification(
  userId: string,
  documentBase64: string,
  selfieBase64: string,
): Promise<KycSubmissionResult> {
  const settings = await getKycSettings();
  const sessionId = uuidv4();

  if (settings.provider === 'manual') {
    throw new Error('KYC provider is set to manual. Please configure MiniMax API key in admin settings.');
  }
  if (!settings.minimaxApiKey) {
    throw new Error('MiniMax API key is not configured. Please set it in admin settings.');
  }

  // Validate file types
  const docExt = getExtensionFromBase64(documentBase64) || 'jpg';
  const selfieExt = getExtensionFromBase64(selfieBase64) || 'jpg';
  if (!settings.allowedExtensions.includes(docExt) || !settings.allowedExtensions.includes(selfieExt)) {
    throw new Error(`Invalid file type. Allowed: ${settings.allowedExtensions.join(', ')}`);
  }

  // Normalize images
  const normalizedDoc = await normalizeImage(documentBase64);
  const normalizedSelfie = await normalizeImage(selfieBase64);

  // Check image quality
  const docQuality = await checkImageQuality(normalizedDoc, 'document');
  const selfieQuality = await checkImageQuality(normalizedSelfie, 'selfie');
  if (!docQuality.acceptable) {
    throw new Error(`Document image quality issue: ${docQuality.reasons.join(', ')}`);
  }
  if (!selfieQuality.acceptable) {
    throw new Error(`Selfie image quality issue: ${selfieQuality.reasons.join(', ')}`);
  }

  // Run OCR
  const ocrResult = await runOcr(normalizedDoc);

  // Run MiniMax vision
  const minimaxResult = await verifyIdentityWithMiniMax(
    normalizedDoc,
    normalizedSelfie,
    ocrResult.text,
    settings.minimaxApiKey,
    settings.minimaxModel,
  );

  // Run sanctions screening
  const fullName = minimaxResult.extracted_fields?.full_name;
  const birthDate = minimaxResult.extracted_fields?.date_of_birth;
  const sanctionsResult = await screenAgainstSanctions(fullName || '', birthDate);

  // Run risk engine
  const risk = calculateKycRisk({
    minimax: minimaxResult,
    quality: { document: docQuality, selfie: selfieQuality },
    sanctions: sanctionsResult,
    ocr: ocrResult,
  });

  // Determine final status from risk engine and admin thresholds
  let status: KycStatus;
  if (risk.decision === 'approved') {
    status = 'approved';
  } else if (risk.decision === 'rejected') {
    status = 'rejected';
  } else {
    status = 'review';
  }

  // Persist session
  await query(
    `INSERT INTO kyc_sessions (
      id, user_id, status, external_session_id, risk_score, risk_tier, final_decision,
      document_valid, face_match, face_similarity, liveness_passed, sanctions_clear,
      extracted_fields, fraud_signals, compliance_reasoning, raw_result, created_at, completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
    )`,
    [
      sessionId,
      userId,
      status,
      null,
      risk.score,
      risk.tier,
      risk.decision.toUpperCase(),
      minimaxResult.document_valid,
      minimaxResult.face_match,
      minimaxResult.face_similarity_score,
      minimaxResult.liveness_passed,
      sanctionsResult.success ? minimaxResult.sanctions_risk !== 'high' : null,
      JSON.stringify(minimaxResult.extracted_fields),
      JSON.stringify(minimaxResult.fraud_signals),
      minimaxResult.reasoning,
      JSON.stringify({
        minimax: minimaxResult,
        ocr: ocrResult,
        sanctions: sanctionsResult,
        risk,
      }),
    ],
  );

  // Update user status
  await query(
    `UPDATE users
     SET kyc_status = $1,
         kyc_verified_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE id = $2`,
    [status, userId]
  );

  return {
    sessionId,
    status,
    riskScore: risk.score,
    riskTier: risk.tier,
    decision: risk.decision,
    documentValid: minimaxResult.document_valid,
    faceMatch: minimaxResult.face_match,
    faceSimilarity: minimaxResult.face_similarity_score,
    livenessPassed: minimaxResult.liveness_passed,
    sanctionsClear: !sanctionsResult.matches.some(m => m.score > 0.85),
    extractedFields: minimaxResult.extracted_fields,
    fraudSignals: minimaxResult.fraud_signals,
    complianceReasoning: minimaxResult.reasoning,
  };
}

export async function getLatestKycSession(userId: string): Promise<KycSessionRecord | null> {
  const result = await query<KycSessionRecord>(
    `SELECT * FROM kyc_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function listKycSessions(
  status?: KycStatus,
  limit: number = 50,
  offset: number = 0
): Promise<KycSessionRecord[]> {
  let sql = `SELECT * FROM kyc_sessions`;
  const params: any[] = [];
  if (status) {
    sql += ` WHERE status = $1`;
    params.push(status);
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  const result = await query<KycSessionRecord>(sql, params);
  return result.rows;
}

export async function reviewKycSession(
  sessionId: string,
  reviewerUserId: string,
  decision: 'approved' | 'rejected',
  note?: string
): Promise<void> {
  await query(
    `UPDATE kyc_sessions
     SET status = $1,
         final_decision = $1,
         reviewed_by = $2,
         reviewed_at = NOW(),
         compliance_reasoning = COALESCE(compliance_reasoning, '') || '\n\nAdmin review: ' || $3
     WHERE id = $4`,
    [decision, reviewerUserId, note || 'manual review', sessionId]
  );

  const session = await query('SELECT user_id FROM kyc_sessions WHERE id = $1', [sessionId]);
  if (session.rows[0]) {
    await query(
      `UPDATE users
       SET kyc_status = $1,
           kyc_verified_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $2`,
      [decision, session.rows[0].user_id]
    );
  }
}

function getExtensionFromBase64(base64: string): string | null {
  const match = base64.match(/^data:image\/(\w+);base64,/);
  return match ? match[1].toLowerCase() : null;
}
