/**
 * =============================================================
 *  LLM FEEDBACK LOOP - weekly retraining job
 * =============================================================
 *
 *  Every Sunday at 03:00 UTC this job:
 *    1. Pulls the last 100 admin decisions from payment_review_decisions
 *    2. Joins them to the original payment_orders for evidence context
 *    3. Picks the 5-10 most informative cases (mix of release + reject)
 *    4. Generates a few-shot prompt with those examples
 *    5. Persists the new prompt to llm_prompt_versions
 *    6. Marks old versions inactive
 *    7. The llm-scorer reads the latest active prompt at runtime
 *
 *  Why this matters: a static prompt goes stale as fraud patterns evolve.
 *  Human admin decisions are the most accurate signal we have; baking
 *  them back into the prompt keeps the LLM calibrated to what *this*
 *  platform actually sees, not generic fraud patterns.
 *
 *  ENV VARS:
 *    MINIMAX_API_KEY (required - generates the prompt itself)
 *    LLM_FEEDBACK_LOOKBACK_DAYS (default 30)
 *    LLM_FEEDBACK_FEW_SHOT_COUNT (default 8)
 *    LLM_FEEDBACK_DRY_RUN (default false)
 */

import { query } from '../config/database';

const MINIMAX_API_KEY = (process.env.MINIMAX_API_KEY || '').trim();
const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com').replace(/\/$/, '');
const MINIMAX_MODEL = (process.env.MINIMAX_MODEL || 'MiniMax-M3').trim();
const LOOKBACK_DAYS = parseInt(process.env.LLM_FEEDBACK_LOOKBACK_DAYS || '30', 10);
const FEW_SHOT_COUNT = parseInt(process.env.LLM_FEEDBACK_FEW_SHOT_COUNT || '8', 10);
const DRY_RUN = (process.env.LLM_FEEDBACK_DRY_RUN || 'false').toLowerCase() === 'true';
const PROMPT_TYPE = 'deposit_scorer';

const SYSTEM_PROMPT_TEMPLATE = `You are a payment-fraud analyst for a crypto deposit platform (CryptoFlip).
Given a payment order and the observed on-chain transaction, decide one of:
- AUTO_CREDIT: high confidence, credit the user's wallet immediately
- MANUAL_HOLD: needs human review (anomaly, edge case, novel pattern)
- REJECT: fraud (sanctions hit, double-spend, fake memo)

Return JSON only: {"verdict": "AUTO_CREDIT|MANUAL_HOLD|REJECT", "confidence": 0..1, "reason": "<short>"}

DECISION RULES:
- Amount within 0.5%% of expected = strong AUTO_CREDIT signal
- Amount 0.5-5%% off = MANUAL_HOLD (admin decides)
- Amount >5%% off = likely user error or scam = MANUAL_HOLD with note
- Memo missing = MANUAL_HOLD (cannot match order)
- Memo mismatch = REJECT (deliberate fraud or wrong user)
- Sender on OFAC sanctions list = REJECT
- Sender new account (<7 days) + amount >$500 = MANUAL_HOLD
- Sender KYC tier >=2 + account age >90 days + deposit history >5 = strong AUTO_CREDIT
- Confirmation count: >=12 EVM / >=3 Tron / >=1 BSC = strong AUTO_CREDIT
- Amount >$500: need confidence >=0.92 for AUTO_CREDIT
- Amount >$2000: NEVER AUTO_CREDIT, always MANUAL_HOLD + admin review + email
- LLM and rule-based disagree: force MANUAL_HOLD regardless of confidence
- Duplicate tx_hash on another order = REJECT (double-spend attempt)

FEW-SHOT EXAMPLES FROM RECENT ADMIN DECISIONS:
{{FEW_SHOT_EXAMPLES}}

DATA MINIMIZATION: You receive only hashed IDs and truncated addresses. Do not infer PII from hashes.
`;

interface AdminDecision {
  decision: 'release' | 'reject';
  decision_note: string | null;
  original_verdict: string | null;
  original_confidence: number | null;
  original_reason: string | null;
  amount_usdt: number;
  llm_verdict: string | null;
  llm_confidence: number | null;
  llm_reason: string | null;
  rule_verdict: string | null;
  rule_disagreement: boolean | null;
  qr_memo: string | null;
  memo_present: boolean;
  detected_tx_hash: string | null;
  detected_at: string | null;
  user_history_n: number;
  user_history_avg: number;
  kyc_tier: string | null;
}

async function fetchRecentDecisions(): Promise<AdminDecision[]> {
  const r = await query(
    `SELECT prd.decision, prd.decision_note,
            prd.original_verdict, prd.original_confidence::float8 AS original_confidence,
            prd.original_reason,
            po.amount_crypto::float8 AS amount_usdt,
            po.llm_verdict, po.llm_confidence::float8 AS llm_confidence,
            po.llm_reason, po.rule_verdict, po.rule_disagreement,
            po.qr_memo,
            po.qr_memo IS NOT NULL AS memo_present,
            po.detected_tx_hash, po.detected_at,
            (SELECT COUNT(*) FROM payment_orders WHERE user_id = po.user_id AND status = 'paid')::int AS user_history_n,
            (SELECT COALESCE(AVG(amount_crypto), 0)::float8 FROM payment_orders WHERE user_id = po.user_id AND status = 'paid') AS user_history_avg,
            u.kyc_tier
     FROM payment_review_decisions prd
     JOIN payment_orders po ON prd.order_id = po.id
     LEFT JOIN users u ON po.user_id = u.id
     WHERE prd.created_at > NOW() - ($1 || ' days')::interval
       AND po.gateway = 'binance_pay_qr'
     ORDER BY prd.created_at DESC
     LIMIT 200`,
    [String(LOOKBACK_DAYS)]
  );
  return r.rows as AdminDecision[];
}

function selectFewShotExamples(decisions: AdminDecision[], count: number): AdminDecision[] {
  const scored = decisions.map((d) => {
    let score = 0;
    if (d.rule_disagreement) score += 10;
    if (d.original_verdict && d.original_verdict !== d.decision) score += 8;
    if (d.decision_note && d.decision_note.length > 10) score += 5;
    if (d.llm_reason && d.llm_reason.length > 10) score += 3;
    if (d.original_reason && d.original_reason.length > 10) score += 3;
    score += d.decision === 'reject' ? 2 : 1;
    return { d, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked: AdminDecision[] = [];
  const rejects = scored.filter((s) => s.d.decision === 'reject');
  const releases = scored.filter((s) => s.d.decision === 'release');

  if (rejects.length > 0) picked.push(rejects[0].d);
  if (releases.length > 0) picked.push(releases[0].d);

  for (const s of scored) {
    if (picked.length >= count) break;
    if (!picked.includes(s.d)) picked.push(s.d);
  }

  return picked.slice(0, count);
}

function formatFewShot(examples: AdminDecision[]): string {
  const lines: string[] = [];
  for (let i = 0; i < examples.length; i++) {
    const e = examples[i];
    const amountDelta = e.amount_usdt;
    const example = {
      case_number: i + 1,
      admin_decision: e.decision,
      evidence: {
        amount_usdt: amountDelta,
        amount_band: amountDelta < 500 ? 'small' : amountDelta < 2000 ? 'medium' : 'large',
        memo_present: e.memo_present,
        llm_said: e.llm_verdict,
        llm_confidence: e.llm_confidence,
        rule_said: e.rule_verdict,
        disagreement: e.rule_disagreement,
        sender_history_count: e.user_history_n,
        sender_avg_amount: e.user_history_avg,
        sender_kyc_tier: e.kyc_tier,
        on_chain_detected: !!e.detected_tx_hash,
      },
      llm_reason: e.llm_reason,
      admin_reason: e.decision_note,
    };
    lines.push(`Example ${i + 1}: ${JSON.stringify(example)}`);
  }
  return lines.join('\n\n');
}

async function summarizePatterns(examples: AdminDecision[]): Promise<string> {
  if (!MINIMAX_API_KEY) {
    return '(LLM summarization skipped - no MINIMAX_API_KEY)';
  }
  const prompt = `You are tuning a fraud-detection prompt. Analyze these recent admin decisions and extract the 3-5 most important PATTERNS (not cases) that the LLM should pay attention to in the future. Be concise.

Examples (admin decisions on actual deposits):
${JSON.stringify(examples.slice(0, 20), null, 2)}

Output: a numbered list of patterns, one per line, max 200 words total. Focus on actionable signals, not abstract advice.`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`${MINIMAX_API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: 'You extract patterns from examples. Output is plain text only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      return `(LLM summarization failed: HTTP ${res.status})`;
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.slice(0, 3000) || '(no LLM output)';
  } catch (err) {
    return `(LLM summarization error: ${(err as Error).message})`;
  }
}

export interface FeedbackLoopResult {
  decisionsScanned: number;
  fewShotCount: number;
  newVersion: number;
  saved: boolean;
  llmSummaryIncluded: boolean;
  promptPreview: string;
  errors: string[];
}

export async function runFeedbackLoopOnce(): Promise<FeedbackLoopResult> {
  const result: FeedbackLoopResult = {
    decisionsScanned: 0,
    fewShotCount: 0,
    newVersion: 1,
    saved: false,
    llmSummaryIncluded: false,
    promptPreview: '',
    errors: [],
  };

  let decisions: AdminDecision[];
  try {
    decisions = await fetchRecentDecisions();
    result.decisionsScanned = decisions.length;
  } catch (err) {
    result.errors.push(`fetchDecisions: ${(err as Error).message}`);
    return result;
  }

  if (decisions.length === 0) {
    result.errors.push('no admin decisions in last ' + LOOKBACK_DAYS + ' days; skipping rebuild');
    return result;
  }

  const fewShot = selectFewShotExamples(decisions, FEW_SHOT_COUNT);
  result.fewShotCount = fewShot.length;

  const formatted = formatFewShot(fewShot);
  const summary = await summarizePatterns(fewShot);
  result.llmSummaryIncluded = !summary.startsWith('(LLM') || summary.length > 50;

  const fullPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
    '{{FEW_SHOT_EXAMPLES}}',
    formatted + '\n\nPATTERNS FROM RECENT DECISIONS:\n' + summary
  );

  const vR = await query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM llm_prompt_versions WHERE prompt_type = $1`,
    [PROMPT_TYPE]
  );
  const nextVersion: number = vR.rows[0]?.next || 1;
  result.newVersion = nextVersion;
  result.promptPreview = fullPrompt.slice(0, 500) + '...';

  if (DRY_RUN) {
    result.errors.push('DRY_RUN: prompt NOT saved');
    return result;
  }

  try {
    await query('BEGIN');
    await query(
      `UPDATE llm_prompt_versions SET is_active = false WHERE prompt_type = $1 AND is_active = true`,
      [PROMPT_TYPE]
    );
    await query(
      `INSERT INTO llm_prompt_versions
        (prompt_type, version, prompt_text, few_shot_count, source_decisions, is_active, notes)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        PROMPT_TYPE,
        nextVersion,
        fullPrompt,
        fewShot.length,
        decisions.length,
        `Auto-generated from ${decisions.length} admin decisions (${fewShot.length} few-shot) on ${new Date().toISOString()}`,
      ]
    );
    await query('COMMIT');
    result.saved = true;
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    result.errors.push(`savePrompt: ${(err as Error).message}`);
  }

  return result;
}

let cachedPrompt: { text: string; version: number; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadActivePrompt(): Promise<string> {
  if (cachedPrompt && Date.now() - cachedPrompt.loadedAt < CACHE_TTL_MS) {
    return cachedPrompt.text;
  }
  try {
    const r = await query(
      `SELECT prompt_text, version FROM llm_prompt_versions
       WHERE prompt_type = $1 AND is_active = true
       ORDER BY version DESC LIMIT 1`,
      [PROMPT_TYPE]
    );
    if (r.rows.length > 0) {
      cachedPrompt = {
        text: r.rows[0].prompt_text,
        version: r.rows[0].version,
        loadedAt: Date.now(),
      };
      return r.rows[0].prompt_text;
    }
  } catch {
    // fall through
  }
  return SYSTEM_PROMPT_TEMPLATE.replace('{{FEW_SHOT_EXAMPLES}}', '(no examples yet - awaiting first feedback loop run)');
}

let weeklyHandle: NodeJS.Timeout | null = null;

export function startWeeklyFeedbackLoop(): void {
  if (weeklyHandle) return;
  console.log(`[llm-feedback-loop] scheduler armed; lookback=${LOOKBACK_DAYS}d, few_shot=${FEW_SHOT_COUNT}, dry_run=${DRY_RUN}`);

  const tick = async () => {
    try {
      const now = new Date();
      if (now.getUTCDay() !== 0 || now.getUTCHours() !== 3) return;
      const r = await runFeedbackLoopOnce();
      console.log(
        `[llm-feedback-loop] weekly run: scanned=${r.decisionsScanned} few_shot=${r.fewShotCount} ` +
        `version=${r.newVersion} saved=${r.saved} errors=${r.errors.length}`
      );
      if (r.errors.length > 0) {
        console.warn('[llm-feedback-loop] errors:', r.errors);
      }
      cachedPrompt = null;
    } catch (err) {
      console.error('[llm-feedback-loop] tick error:', err);
    }
  };

  weeklyHandle = setInterval(tick, 60 * 60 * 1000);
  setTimeout(async () => {
    try {
      const cR = await query(
        `SELECT COUNT(*)::int AS n FROM llm_prompt_versions WHERE prompt_type = $1 AND is_active = true`,
        [PROMPT_TYPE]
      );
      if ((cR.rows[0]?.n || 0) === 0) {
        console.log('[llm-feedback-loop] no active prompt - running initial build');
        await tick();
      }
    } catch (err) {
      console.warn('[llm-feedback-loop] initial-build check failed:', err);
    }
  }, 10000);
}

export function stopWeeklyFeedbackLoop(): void {
  if (weeklyHandle) {
    clearInterval(weeklyHandle);
    weeklyHandle = null;
    console.log('[llm-feedback-loop] scheduler stopped');
  }
}

export async function listPromptVersions(limit = 20): Promise<Array<{
  version: number;
  few_shot_count: number;
  source_decisions: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}>> {
  const r = await query(
    `SELECT version, few_shot_count, source_decisions, is_active,
            notes, created_at, created_by
     FROM llm_prompt_versions
     WHERE prompt_type = $1
     ORDER BY version DESC
     LIMIT $2`,
    [PROMPT_TYPE, limit]
  );
  return r.rows as any;
}

export async function triggerManualRebuild(): Promise<FeedbackLoopResult> {
  const r = await runFeedbackLoopOnce();
  cachedPrompt = null;
  return r;
}
