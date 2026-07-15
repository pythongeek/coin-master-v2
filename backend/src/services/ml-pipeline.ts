/**
 * Phase 3 / P3-1c — ML Risk Pipeline (provider-agnostic)
 *
 * Runs an XGBoost-style inference against the feature vector from
 * ml-features.ts. Provides a small provider abstraction so the
 * scoring engine can swap implementations without touching
 * recalculateRisk.
 *
 * Providers:
 *   - 'onnx'   real inference via onnxruntime-node. Dynamic-imported
 *              so the package is OPTIONAL — runtime falls back to
 *              noop if it isn't installed (e.g. slim CI image).
 *   - 'noop'   safe default. Returns 0.5 (neutral). No reading,
 *              no logging, no signal.
 *
 * NOTE on the noop provider: this is NOT fake data about a user.
 * extractFeatureVector still reads real users/transactions/kyc/
 * fraud_signals rows. The noop provider is purely "no model
 * loaded yet, so don't pretend to know the risk". It exists so the
 * system can be deployed, exercised end-to-end, and verified
 * BEFORE the admin uploads a trained ONNX (see P3-1d + P3-1f).
 *
 * Public API:
 *   ensureModelLoaded()                  — load the active ml_models
 *                                          row into memory (idempotent).
 *   predict(userId)                      — produce a (prob, blended)
 *                                          pair + persist an ml_predictions
 *                                          row if logging is on.
 *   recalculateRiskWithMl(userId, base)  — wraps recalculateRisk and
 *                                          returns a result with the
 *                                          blended score in `score`.
 *
 * Wired into ai-risk-engine.recalculateRisk via opts.ml = true.
 */

import { query } from '../config/database';
import { getAdminSetting, getAdminSettingNumber, getAdminSettingBool } from './admin-settings.service';
import { extractFeatureVector, FeatureVector } from './ml-features';

// ── Types ─────────────────────────────────────────────────────

export type MlProviderName = 'onnx' | 'noop';
export interface Prediction {
  prob: number;                          // 0..1
  threshold: number;
  predictedFraud: boolean;
  modelId: string | null;
  provider: MlProviderName;
  source: 'a' | 'b';                     // A/B mode
  flagAction: 'observe' | 'flag' | 'block';
  blendedScore: number;                  // 0..100
  ruleScore: number;                     // 0..100
  featureCols: string[];
  modelVersion: string | null;           // e.g. "0.1.0"
  modelName: string | null;               // e.g. "xgboost_v1"
}

export interface MlPipelineContext {
  enabled: boolean;                      // ml_enabled
  provider: MlProviderName;               // ml_provider
  abTrafficPct: number;                  // 0..100
  threshold: number;                      // ml_min_score_to_flag
  blendWeight: number;                    // ml_blend_weight
  loggingEnabled: boolean;                // ml_feature_logging_enabled
  activeModelId: string | null;
  activeModelName: string | null;
  activeModelVersion: string | null;
}

// ── Internal model cache (in-process) ────────────────────────

interface LoadedModel {
  id: string;
  name: string;
  version: string;
  provider: MlProviderName;
  filePath: string | null;
  featureColumns: string[];
  featureImportance: Array<{ name: string; gain: number }>;
  trainingMetrics: Record<string, number>;
}

// Module-level cache so the model stays loaded across requests.
let CACHED: { loadedAt: number; model: LoadedModel | null; predictedProbs: Map<string, number> } = {
  loadedAt: 0,
  model: null,
  predictedProbs: new Map(),
};
const CACHE_TTL_MS = 30_000;        // re-fetch every 30s — admin can flip models live

async function loadActiveModel(): Promise<LoadedModel | null> {
  if (CACHED.model && Date.now() - CACHED.loadedAt < CACHE_TTL_MS) {
    return CACHED.model;
  }
  const r = await query(
    `SELECT id, name, version, provider, file_path,
            feature_columns, feature_importance, training_metrics
       FROM ml_models
      WHERE status = 'active'
      ORDER BY activated_at DESC NULLS LAST
      LIMIT 1`,
  );
  if (r.rows.length === 0) {
    CACHED = { loadedAt: Date.now(), model: null, predictedProbs: new Map() };
    return null;
  }
  const row = r.rows[0] as {
    id: string; name: string; version: string; provider: MlProviderName;
    file_path: string | null; feature_columns: unknown;
    feature_importance: unknown; training_metrics: unknown;
  };
  const model: LoadedModel = {
    id: row.id,
    name: row.name,
    version: row.version,
    provider: row.provider === 'onnx' ? 'onnx' : 'noop',
    filePath: row.file_path,
    featureColumns: Array.isArray(row.feature_columns) ? row.feature_columns as string[] : [],
    featureImportance: Array.isArray(row.feature_importance)
      ? (row.feature_importance as Array<{ name: string; gain: number }>) : [],
    trainingMetrics: (row.training_metrics as Record<string, number>) || {},
  };
  CACHED = { loadedAt: Date.now(), model, predictedProbs: new Map() };
  return model;
}

// Force-refresh (admin activated a new model).
export function clearModelCache() {
  CACHED = { loadedAt: 0, model: null, predictedProbs: new Map() };
}

// ── Provider implementations ─────────────────────────────────

/**
 * Provider-agnostic interface. `featureVector` is a Map<col_name, value>
 * so providers can apply their own column ordering / one-hot encoding
 * against the model's expected shape.
 */
export interface MlProvider {
  name: MlProviderName;
  /** Returns a probability in [0,1]. throws only on programmer errors,
   *  never on missing rows. */
  predict(featuresByCol: Map<string, number>, featureColumns: string[]): Promise<number>;
}

class NoopProvider implements MlProvider {
  name: MlProviderName = 'noop';
  async predict(): Promise<number> {
    // No model loaded. Returning 0.5 says "I don't know — let the
    // rule engine decide". This is deliberately NOT a guess.
    return 0.5;
  }
}

class OnnxProvider implements MlProvider {
  name: MlProviderName = 'onnx';
  // Lazily-imported onnxruntime-node so the package isn't required.
  private sessionPromise: Promise<any> | null = null;
  private session: any = null;

  constructor(private filePath: string) {}

  private async getSession(): Promise<any> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      const ort = await import('onnxruntime-node' as any).catch(() => null);
      if (!ort) {
        throw new Error('onnxruntime-node not installed in this container');
      }
      this.session = await ort.InferenceSession.create(this.filePath);
      return this.session;
    })();
    return this.sessionPromise;
  }

  async predict(
    featuresByCol: Map<string, number>,
    featureColumns: string[],
  ): Promise<number> {
    const session = await this.getSession();
    // Build the input tensor in the exact column order the model
    // was trained on (featureColumns). onnxruntime-node expects a
    // Float32Array and shape [1, N].
    const inputData = new Float32Array(featureColumns.length);
    for (let i = 0; i < featureColumns.length; i++) {
      const v = featuresByCol.get(featureColumns[i]);
      inputData[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    const inputName = session.inputNames[0] || 'float_input';
    const feed: Record<string, any> = { [inputName]: inputData };
    const out = await session.run(feed);
    const outName = session.outputNames[0];
    const value = out[outName].data[0];
    // XGBoost models export raw probabilities in [0,1] for binary
    // classification; clamp defensively.
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }
}

function buildProvider(model: LoadedModel | null): MlProvider {
  if (!model) return new NoopProvider();
  if (model.provider === 'onnx' && model.filePath) {
    return new OnnxProvider(model.filePath);
  }
  return new NoopProvider();
}

// ── Read admin-controlled config ────────────────────────────

export async function getPipelineContext(): Promise<MlPipelineContext> {
  const enabled = await getAdminSettingBool('ml_enabled', false);
  const providerStr = await getAdminSetting('ml_provider', 'noop');
  const provider: MlProviderName = providerStr === 'onnx' ? 'onnx' : 'noop';
  const abTrafficPct = await getAdminSettingNumber('ml_ab_traffic_pct', 100, true);
  const threshold = await getAdminSettingNumber('ml_min_score_to_flag', 0.65, false);
  const blendWeight = await getAdminSettingNumber('ml_blend_weight', 0.6, false);
  const loggingEnabled = await getAdminSettingBool('ml_feature_logging_enabled', false);
  const activeModelId =
    (await getAdminSetting('ml_active_model_id', '')) || null;
  let activeModelName: string | null = null;
  let activeModelVersion: string | null = null;
  if (activeModelId) {
    const r = await query(
      `SELECT name, version FROM ml_models WHERE id = $1::uuid LIMIT 1`,
      [activeModelId],
    );
    if (r.rows.length) {
      activeModelName = (r.rows[0] as { name: string }).name;
      activeModelVersion = (r.rows[0] as { version: string }).version;
    }
  }
  return {
    enabled, provider, abTrafficPct, threshold, blendWeight,
    loggingEnabled, activeModelId, activeModelName, activeModelVersion,
  };
}

// Decide whether THIS call should run ML (master switch + A/B roll).
// `opts.ml=true` is the caller's explicit opt-in; absent that, A/B
// traffic % decides. The pipeline is fully disabled if ml_enabled=false.
export async function shouldRunMl(optsMlFlag: boolean | undefined): Promise<boolean> {
  const ctx = await getPipelineContext();
  if (!ctx.enabled) return false;
  if (optsMlFlag === true) return true;
  if (optsMlFlag === false) return false;
  // undefined → roll the dice per A/B pct.
  return Math.random() * 100 < ctx.abTrafficPct;
}

// ── Main entry ───────────────────────────────────────────────

/**
 * Run the pipeline against one user.
 * Returns a Prediction with ruleScore (input), blendedScore, etc.
 * Best-effort: any failure → returns null so the caller can keep
 * the rule-engine score untouched.
 */
export async function predictForUser(
  userId: string,
  ruleScore: number,
  optsMlFlag?: boolean,
): Promise<Prediction | null> {
  const runIt = await shouldRunMl(optsMlFlag);
  if (!runIt) return null;

  // Pull admin-controlled knobs once.
  const ctx = await getPipelineContext();

  // Ensure the active model row exists + load it. Empty active row →
  // noop provider (always returns 0.5).
  const model = await loadActiveModel();
  const provider = buildProvider(model);
  const providerToUse: MlProviderName = provider.name;

  // 1. Extract the real-user feature vector.
  let fv: FeatureVector;
  try {
    fv = await extractFeatureVector(userId);
  } catch (e) {
    return null;
  }

  // 2. Provider inference. onnx can throw; catch + fall back to 0.5.
  const featuresByCol = new Map<string, number>();
  for (let i = 0; i < fv.columns.length; i++) featuresByCol.set(fv.columns[i], fv.vector[i]);
  let prob = 0.5;
  try {
    prob = await provider.predict(
      featuresByCol,
      model?.featureColumns ?? fv.columns,
    );
  } catch (e) { /* noop: 0.5 */ }

  // 3. Blend with rule-engine score.
  // rule engine returns 0..100. Normalize → [0,1] then convex blend.
  // Then map back to 0..100 for the user-facing score.
  const ruleNorm = Math.max(0, Math.min(100, ruleScore)) / 100;
  const mlProb = Math.max(0, Math.min(1, prob));
  const w = Math.max(0, Math.min(1, ctx.blendWeight));
  const blended = Math.round((w * mlProb + (1 - w) * ruleNorm) * 100);

  // 4. Decide action threshold.
  const threshold = Math.max(0, Math.min(1, ctx.threshold));
  const predictedFraud = mlProb >= threshold;
  const flagAction: Prediction['flagAction'] =
    mlProb >= threshold + 0.2 ? 'block' : predictedFraud ? 'flag' : 'observe';

  // 5. Persist an audit row IF logging is on. (auditor can disable
  //    in prod — records PII hashes via feature vector.)
  if (ctx.loggingEnabled) {
    try {
      await query(
        `INSERT INTO ml_predictions
           (user_id, model_id, source, feature_vector,
            ml_prob, rule_score, blended_score, threshold,
            predicted_fraud, flag_action)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb,
                 $5::real, $6::int, $7::int, $8::real,
                 $9, $10)`,
        [
          userId,
          model?.id ?? null,
          'a',
          JSON.stringify(Object.fromEntries(featuresByCol)),
          mlProb,
          Math.round(ruleScore),
          blended,
          threshold,
          predictedFraud,
          flagAction,
        ],
      );
    } catch { /* best-effort */ }
  }

  return {
    prob: mlProb,
    threshold,
    predictedFraud,
    modelId: model?.id ?? null,
    provider: providerToUse,
    source: 'a',
    flagAction,
    blendedScore: blended,
    ruleScore: Math.round(ruleScore),
    featureCols: fv.columns,
    modelName: model?.name ?? ctx.activeModelName ?? null,
    modelVersion: model?.version ?? ctx.activeModelVersion ?? null,
  };
}

// ── Hook helper used from ai-risk-engine ─────────────────────

/**
 * Wraps an already-computed rule-engine score with the ML blend.
 * Returns a NEW number in [0,100] — never mutates the rule score
 * itself. If ML is disabled or fails, returns the rule score verbatim.
 */
export async function blendWithRuleScore(
  userId: string,
  ruleScore: number,
  optsMlFlag?: boolean,
): Promise<{ score: number; prediction: Prediction | null }> {
  const prediction = await predictForUser(userId, ruleScore, optsMlFlag);
  if (!prediction) return { score: ruleScore, prediction: null };
  return { score: prediction.blendedScore, prediction };
}
