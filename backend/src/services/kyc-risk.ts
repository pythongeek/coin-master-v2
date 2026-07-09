import { MiniMaxKycDecision } from './minimax-client';
import { ImageQualityResult } from './kyc-quality';
import { SanctionsScreeningResult, sanctionsRiskFromMatches } from './kyc-sanctions';
import { OcrResult } from './kyc-ocr';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC RISK ENGINE — Combine open-source + MiniMax signals
 * ═══════════════════════════════════════════════════════════════
 */

export type KycDecision = 'approved' | 'review' | 'rejected';

export interface KycRiskResult {
  score: number; // 0-100
  tier: 'LOW' | 'MEDIUM' | 'HIGH';
  decision: KycDecision;
  factors: string[];
  breakdown: {
    document_valid: number;
    face_match: number;
    liveness: number;
    sanctions: number;
    image_quality: number;
    ocr_confidence: number;
  };
}

export interface RiskInputs {
  minimax: MiniMaxKycDecision;
  quality: {
    document: ImageQualityResult;
    selfie: ImageQualityResult;
  };
  sanctions: SanctionsScreeningResult;
  ocr: OcrResult;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function calculateKycRisk(inputs: RiskInputs): KycRiskResult {
  const { minimax, quality, sanctions, ocr } = inputs;
  const breakdown = {
    document_valid: 0,
    face_match: 0,
    liveness: 0,
    sanctions: 0,
    image_quality: 0,
    ocr_confidence: 0,
  };

  const factors: string[] = [];

  // Document validity (0-30)
  if (minimax.document_valid) {
    breakdown.document_valid = 0;
    factors.push('document_valid');
  } else {
    breakdown.document_valid = 30;
    factors.push('document_invalid');
  }

  // Face match (0-25)
  if (minimax.face_match && minimax.face_similarity_score >= 0.75) {
    breakdown.face_match = 0;
    factors.push('face_match');
  } else if (minimax.face_similarity_score >= 0.55) {
    breakdown.face_match = 15;
    factors.push('face_match_weak');
  } else {
    breakdown.face_match = 25;
    factors.push('face_mismatch');
  }

  // Liveness (0-20)
  if (minimax.liveness_passed) {
    breakdown.liveness = 0;
    factors.push('liveness_passed');
  } else {
    breakdown.liveness = 20;
    factors.push('liveness_failed');
  }

  // Sanctions (0-15)
  const sanctionsRisk = sanctions.success
    ? sanctionsRiskFromMatches(sanctions.matches)
    : minimax.sanctions_risk;
  if (sanctionsRisk === 'high') {
    breakdown.sanctions = 15;
    factors.push('sanctions_high');
  } else if (sanctionsRisk === 'medium') {
    breakdown.sanctions = 8;
    factors.push('sanctions_medium');
  } else {
    breakdown.sanctions = 0;
    factors.push('sanctions_low');
  }

  // Image quality (0-5)
  if (quality.document.acceptable && quality.selfie.acceptable) {
    breakdown.image_quality = 0;
  } else {
    breakdown.image_quality = 5;
    factors.push('image_quality_poor');
  }

  // OCR confidence (0-5)
  breakdown.ocr_confidence = clamp(5 - Math.round(ocr.confidence / 20), 0, 5);
  if (ocr.confidence < 50) factors.push('ocr_low_confidence');

  const score = clamp(
    Object.values(breakdown).reduce((a, b) => a + b, 0),
    0,
    100,
  );

  let decision: KycDecision;
  if (minimax.recommended_decision === 'REJECTED' || score >= 70) {
    decision = 'rejected';
  } else if (minimax.recommended_decision === 'APPROVED' && score < 30) {
    decision = 'approved';
  } else {
    decision = 'review';
  }

  let tier: 'LOW' | 'MEDIUM' | 'HIGH';
  if (score < 30) tier = 'LOW';
  else if (score < 70) tier = 'MEDIUM';
  else tier = 'HIGH';

  return {
    score,
    tier,
    decision,
    factors,
    breakdown,
  };
}
