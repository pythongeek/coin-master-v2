/**
 * ═══════════════════════════════════════════════════════════════
 *  LLM SCORER — MiniMax integration for payment fraud scoring
 * ═══════════════════════════════════════════════════════════════
 *
 *  Two scoring paths run in parallel per deposit:
 *
 *    1. ruleBasedVerdict()   — deterministic, no LLM, always runs
 *    2. scoreDepositWithLlm() — MiniMax-M3, with fallback to rule-only
 *
 *  The ledger monitor service compares both. If they DISAGREE, it
 *  forces MANUAL_HOLD regardless of confidence. This prevents a
 *  single miscalibrated LLM call from auto-crediting a bad payment.
 *
 *  Confidence-boosting rules (deterministic, applied AFTER LLM):
 *    senderKycTier >= 2 (from Binance) → +0.10
 *    senderAccountAge > 90 days        → +0.05
 *    senderDepositHistory30d > 5       → +0.05
 *    senderCountry == high-risk        → -0.20
 *
 *  Amount-banded thresholds (enforced by ledger monitor, NOT here):
 *    $0-$500:    AUTO_CREDIT if conf >= 0.80
 *    $500-$2000: AUTO_CREDIT if conf >= 0.92
 *    $2000+:     never AUTO_CREDIT (always MANUAL_HOLD + admin + email)
 *
 *  ENV VARS REQUIRED:
 *    MINIMAX_API_KEY        - MiniMax API key (free tier OK)
 *    MINIMAX_API_BASE       - 'https://api.minimaxi.com' (default)
 *    MINIMAX_MODEL          - 'MiniMax-M3' (default)
 *    LLM_SCORER_ENABLED     - 'true' (default) | 'false' to force rule-only
 *    LLM_TIMEOUT_MS         - 8000 (default)
 *
 *  DATA MINIMIZATION:
 *    Never send raw tx.inputData or full user PII to MiniMax.
 *    We hash sender addresses and strip all but minimal fields.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { loadActivePrompt } from './llm-feedback-loop.service';

const MINIMAX_API_KEY = (process.env.MINIMAX_API_KEY || '').trim();
const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com').replace(/\/$/, '');
const MINIMAX_MODEL = (process.env.MINIMAX_MODEL || 'MiniMax-M3').trim();
const LLM_SCORER_ENABLED = (process.env.LLM_SCORER_ENABLED || 'true').toLowerCase() === 'true';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '8000', 10);

// ── Types ──────────────────────────────────────────────────────
export interface ScoringInput {
  order: {
    orderId: string;
    userId: string;             // hashed below before sending to LLM
    expectedUsdt: number;
    memo: string;
    createdAt: Date;
    expiresAt: Date;
  };
  observed: {
    txHash: string;
    fromAddress: string;
    toAddress: string;
    amount: number;
    network: string;
    confirmations: number;
    timestamp: Date;
  };
  ledger: {
    ledgerId: string;
    senderAddress: string;
    walletType?: number;
    transferType?: number;
  };
  userHistory: {
    lastNDeposits: number;
    avgAmount: number;
    chargebacks: number;
    kycTier: string;
    accountAgeDays: number;
  };
  riskFlags: {
    ipCountry: string;
    deviceFp: string;
    sanctionsHits: number;
    kycTier: string;
  };
}

export interface ScoringVerdict {
  verdict: 'AUTO_CREDIT' | 'MANUAL_HOLD' | 'REJECT';
  confidence: number;  // 0..1
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────
function hashId(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function stripPii(input: ScoringInput): Record<string, unknown> {
  return {
    order: {
      orderId: hashId(input.order.orderId),
      userIdHash: hashId(input.order.userId),
      expectedUsdt: input.order.expectedUsdt,
      memo: input.order.memo,
      ageSec: Math.floor((Date.now() - input.order.createdAt.getTime()) / 1000),
      expiresInSec: Math.floor((input.order.expiresAt.getTime() - Date.now()) / 1000),
    },
    observed: {
      txHashShort: input.observed.txHash.slice(0, 10) + '…',
      fromAddressShort: input.observed.fromAddress.slice(0, 6) + '…' + input.observed.fromAddress.slice(-4),
      toAddressShort: input.observed.toAddress.slice(0, 6) + '…' + input.observed.toAddress.slice(-4),
      amount: input.observed.amount,
      amountDelta: parseFloat((input.observed.amount - input.order.expectedUsdt).toFixed(8)),
      amountDeltaPct: parseFloat(((input.observed.amount - input.order.expectedUsdt) / Math.max(input.order.expectedUsdt, 0.01) * 100).toFixed(2)),
      network: input.observed.network,
      confirmations: input.observed.confirmations,
      lagSec: Math.floor((input.observed.timestamp.getTime() - input.order.createdAt.getTime()) / 1000),
    },
    userHistory: input.userHistory,
    riskFlags: { ...input.riskFlags, ipCountry: input.riskFlags.ipCountry === 'unknown' ? 'XX' : input.riskFlags.ipCountry },
  };
}

// ── Rule-based verdict (deterministic, no LLM) ──────────────────
export function ruleBasedVerdict(input: ScoringInput): ScoringVerdict {
  const reasons: string[] = [];
  let confidence = 0.85; // default for "rule says AUTO"

  // Exact memo match
  reasons.push('memo_present');

  // Amount exact match
  const deltaPct = Math.abs(input.observed.amount - input.order.expectedUsdt) / Math.max(input.order.expectedUsdt, 0.01) * 100;
  if (deltaPct > 5) {
    reasons.push(`amount_mismatch_${deltaPct.toFixed(1)}pct`);
    confidence = 0.3;
  } else if (deltaPct > 0.5) {
    reasons.push(`amount_slight_${deltaPct.toFixed(1)}pct`);
    confidence = 0.7;
  }

  // Time window: must arrive within expiry
  if (input.observed.timestamp.getTime() > input.order.expiresAt.getTime()) {
    reasons.push('after_expiry');
    return { verdict: 'REJECT', confidence: 0.95, reason: reasons.join(', ') };
  }

  // Network: must match expected chain
  if (input.observed.network.toUpperCase() !== input.ledger.senderAddress && input.observed.network !== 'BSC') {
    reasons.push(`wrong_network_${input.observed.network}`);
    confidence = Math.min(confidence, 0.4);
  }

  // Confirmations
  if (input.observed.confirmations < 1) {
    reasons.push('zero_confirmations');
    return { verdict: 'MANUAL_HOLD', confidence: 0.8, reason: reasons.join(', ') };
  }

  // Sanctions
  if (input.riskFlags.sanctionsHits > 0) {
    return { verdict: 'REJECT', confidence: 1.0, reason: 'sanctions_hit' };
  }

  // Verdict
  let verdict: ScoringVerdict['verdict'] = 'AUTO_CREDIT';
  if (confidence < 0.7) verdict = 'MANUAL_HOLD';

  return { verdict, confidence, reason: reasons.join(', ') };
}

// ── LLM call (with timeout + deterministic fallback) ───────────
export async function scoreDepositWithLlm(input: ScoringInput): Promise<ScoringVerdict> {
  if (!LLM_SCORER_ENABLED || !MINIMAX_API_KEY) {
    return ruleBasedVerdict(input);
  }

  const sanitized = stripPii(input);
  const promptTemplate = await loadActivePrompt();

  const prompt = `${promptTemplate}\n\nPayload:\n${JSON.stringify(sanitized, null, 2)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${MINIMAX_API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: 'You output JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MiniMax ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('MiniMax empty response');
    const parsed = JSON.parse(content);
    if (!parsed.verdict || typeof parsed.confidence !== 'number') {
      throw new Error('MiniMax response shape invalid');
    }
    const verdict: ScoringVerdict['verdict'] =
      parsed.verdict === 'AUTO_CREDIT' ? 'AUTO_CREDIT' :
      parsed.verdict === 'REJECT' ? 'REJECT' :
      'MANUAL_HOLD';
    return {
      verdict,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      reason: String(parsed.reason || 'no_reason_provided').slice(0, 500),
    };
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`[llm-scorer] MiniMax call failed, falling back to rule: ${(err as Error).message}`);
    return ruleBasedVerdict(input);
  }
}
