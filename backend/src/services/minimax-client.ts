import { getConfig } from './admin-config';

/**
 * ═══════════════════════════════════════════════════════════════
 *  MINIMAX CLIENT — M3 Vision-powered KYC verification
 * ═══════════════════════════════════════════════════════════════
 *
 *  Calls MiniMax's OpenAI-compatible chat completions endpoint
 *  with image inputs (document + selfie) and a structured
 *  agentic prompt. Returns a JSON decision.
 *
 *  The API key is read from admin_settings at runtime (encrypted).
 */

export interface MiniMaxKycDecision {
  document_valid: boolean;
  document_type?: string;
  extracted_fields: {
    full_name?: string;
    date_of_birth?: string;
    nationality?: string;
    document_number?: string;
    expiry_date?: string;
  };
  face_match: boolean;
  face_similarity_score: number; // 0-1
  liveness_passed: boolean;
  fraud_signals: string[];
  sanctions_risk: 'low' | 'medium' | 'high';
  reasoning: string;
  recommended_decision: 'APPROVED' | 'REVIEW' | 'REJECTED';
}

const DEFAULT_MODEL = 'MiniMax-M3';

function cleanBase64(str: string): { data: string; mimeType: string } {
  const match = str.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: 'image/jpeg', data: str };
}

export function buildMiniMaxKycPrompt(ocrText: string): string {
  return `You are a production-grade KYC (Know Your Customer) verification agent. Your job is to analyze a government-issued ID document and a live selfie submitted by a user, and decide whether the user's identity should be APPROVED, REVIEWED, or REJECTED.

You are given:
1. An image of an ID document (passport, national ID, driver's license, etc.).
2. A live selfie image of the person.
3. OCR text already extracted from the document (for reference only; verify it visually).

Perform these checks carefully and return ONLY a JSON object matching the schema below. Do not include any markdown, explanation, or preamble.

CHECKS TO PERFORM:
1. Document authenticity: Is the document image a real physical document, not a screenshot, scan of a screen, printout, or obviously fake? Check for natural lighting, texture, shadows, edge consistency, and absence of digital artifacts.
2. Document extraction: Read the document and extract the fields: full_name, date_of_birth (YYYY-MM-DD), nationality, document_number, expiry_date (YYYY-MM-DD). For names, translate to English if written in another language.
3. Face comparison: Compare the face in the document photo to the face in the selfie. Are they the same person? Consider age differences, lighting, pose, expression. Return a similarity score 0.0–1.0.
4. Liveness: Is the selfie a live person? Check for open eyes, natural skin texture, proper lighting, no screen reflection, no printed photo. If the person is wearing sunglasses or a mask, fail liveness.
5. Fraud signals: List any suspicious signs (blurriness, cropping, Photoshop artifacts, mismatched backgrounds, multiple faces, no face, etc.). Use ["none"] if nothing suspicious.
6. Sanctions/PEP risk: Based on the extracted name, nationality, and any visible clues, estimate sanctions/PEP risk as low/medium/high. This is a coarse signal only.

SCHEMA:
{
  "document_valid": boolean,
  "document_type": "passport" | "national_id" | "drivers_license" | "other",
  "extracted_fields": {
    "full_name": string,
    "date_of_birth": "YYYY-MM-DD",
    "nationality": string,
    "document_number": string,
    "expiry_date": "YYYY-MM-DD"
  },
  "face_match": boolean,
  "face_similarity_score": number (0.0 to 1.0),
  "liveness_passed": boolean,
  "fraud_signals": string[],
  "sanctions_risk": "low" | "medium" | "high",
  "reasoning": string (max 400 chars),
  "recommended_decision": "APPROVED" | "REVIEW" | "REJECTED"
}

DECISION RULES:
- APPROVED: document is authentic, face_match is true, similarity_score >= 0.80, liveness_passed is true, fraud_signals are none, sanctions_risk is low.
- REJECTED: document is fake/screen/print, face_match false, liveness failed, multiple fraud signals, or sanctions_risk high.
- REVIEW: anything uncertain, borderline, or missing fields.

OCR reference (verify visually): ${ocrText.slice(0, 2000)}`;
}

export async function verifyIdentityWithMiniMax(
  documentBase64: string,
  selfieBase64: string,
  ocrText: string,
  apiKey: string,
  model: string = DEFAULT_MODEL,
): Promise<MiniMaxKycDecision> {
  if (!apiKey) {
    throw new Error('MiniMax API key is not configured');
  }

  const doc = cleanBase64(documentBase64);
  const selfie = cleanBase64(selfieBase64);

  const baseUrl = process.env.MINIMAX_API_BASE_URL || 'https://api.minimax.io/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildMiniMaxKycPrompt(ocrText) },
          {
            type: 'image_url',
            image_url: {
              url: `data:${doc.mimeType};base64,${doc.data}`,
              detail: 'high',
            },
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${selfie.mimeType};base64,${selfie.data}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2048,
    temperature: 0.2,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`MiniMax API error ${response.status}: ${errText}`);
  }

  const result = (await response.json()) as any;
  const content = result.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('MiniMax returned empty content');
  }

  let parsed: Partial<MiniMaxKycDecision>;
  try {
    parsed = JSON.parse(content) as Partial<MiniMaxKycDecision>;
  } catch (e) {
    throw new Error(`MiniMax returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    document_valid: parsed.document_valid ?? false,
    document_type: parsed.document_type || 'other',
    extracted_fields: parsed.extracted_fields || {},
    face_match: parsed.face_match ?? false,
    face_similarity_score: Math.min(1, Math.max(0, parsed.face_similarity_score ?? 0)),
    liveness_passed: parsed.liveness_passed ?? false,
    fraud_signals: Array.isArray(parsed.fraud_signals) ? parsed.fraud_signals : ['none'],
    sanctions_risk: ['low', 'medium', 'high'].includes(parsed.sanctions_risk as string)
      ? (parsed.sanctions_risk as 'low' | 'medium' | 'high')
      : 'medium',
    reasoning: (parsed.reasoning || 'No reasoning provided').slice(0, 2000),
    recommended_decision: ['APPROVED', 'REVIEW', 'REJECTED'].includes(parsed.recommended_decision as string)
      ? (parsed.recommended_decision as 'APPROVED' | 'REVIEW' | 'REJECTED')
      : 'REVIEW',
  };
}

export async function validateMiniMaxApiKey(apiKey: string): Promise<boolean> {
  try {
    const baseUrl = process.env.MINIMAX_API_BASE_URL || 'https://api.minimax.io/v1';
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
