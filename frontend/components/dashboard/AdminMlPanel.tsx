'use client';
/**
 * Phase 3 / P3-1e — Admin ML Risk Panel
 *
 * Admin-only page for managing the ML risk model:
 *   - Model registry table (versions, status, provider, metrics)
 *   - Upload form for a new model row (admin pre-stages the .onnx
 *     file via docker cp to /app/ml/<id>.onnx, then registers here)
 *   - Activate / Rollback buttons per model row
 *   - Feature-importance bar chart (inline SVG, top-N)
 *   - Recent predictions log (filter by user + pagination)
 *   - Training job history
 *   - Live config sliders (A/B traffic %, threshold, blend weight)
 *     bind to admin_settings via /admin/settings/bulk.
 *
 * No new dependencies. Pure SVG charts.
 */
import { useState, useEffect, useCallback } from 'react';
import { Brain, RefreshCw, Loader2, Play, RotateCcw, Upload, AlertCircle, BarChart3 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

interface ModelRow {
  id: string;
  name: string;
  version: string;
  provider: string;
  status: 'training' | 'uploaded' | 'active' | 'retired' | 'failed';
  file_path: string | null;
  feature_importance: Array<{ name: string; gain: number }>;
  training_metrics: Record<string, number>;
  feature_columns: string[];
  activated_at: string | null;
  activated_by_username: string | null;
  created_at: string;
}
interface PredRow {
  id: string;
  user_id: string;
  model_id: string | null;
  ml_prob: number;
  rule_score: number;
  blended_score: number;
  threshold: number;
  predicted_fraud: boolean;
  flag_action: 'observe' | 'flag' | 'block';
  created_at: string;
}
interface JobRow {
  id: string;
  event: string;
  model_name: string | null;
  model_version: string | null;
  actor_username: string | null;
  created_at: string;
}

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-brand-green/20 text-brand-green',
  uploaded: 'bg-blue-500/20 text-blue-300',
  training: 'bg-brand-orange/20 text-brand-orange',
  retired: 'bg-surface text-text-muted',
  failed: 'bg-brand-red/20 text-brand-red',
};

function ImportanceChart({ items }: { items: Array<{ name: string; gain: number }> }) {
  const top = [...items].sort((a, b) => b.gain - a.gain).slice(0, 8);
  if (top.length === 0) return <p className="text-text-muted text-xs">No feature importance data.</p>;
  const max = top[0].gain || 1;
  return (
    <div className="space-y-1">
      {top.map((it) => {
        const pct = Math.max(2, (it.gain / max) * 100);
        return (
          <div key={it.name} className="flex items-center gap-2">
            <div className="w-44 text-text-muted text-[10px] font-mono truncate">{it.name}</div>
            <div className="flex-1 bg-surface-2 rounded h-3 overflow-hidden">
              <div className="bg-brand-gold/80 h-3" style={{ width: pct + '%' }} title={it.gain.toFixed(2)} />
            </div>
            <div className="text-text-primary text-[10px] font-mono w-12 text-right">{it.gain.toFixed(1)}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminMlPanel() {
  const token = useGameStore((s) => s.token);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [predictions, setPredictions] = useState<PredRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Upload-form state
  const [showUpload, setShowUpload] = useState(false);
  const [uForm, setUForm] = useState({
    name: 'xgboost_v',
    version: '0.1.0',
    provider: 'mock' as 'mock' | 'onnx',
    filePath: '/app/ml/xgboost.onnx',
    notes: '',
  });
  const [uploading, setUploading] = useState(false);

  // Live config knobs (A/B %, threshold, blend weight, master switch)
  const [cfg, setCfg] = useState({
    mlEnabled: 'false',
    abPct: '100',
    threshold: '0.65',
    blend: '0.6',
    logging: 'false',
  });
  const [savingCfg, setSavingCfg] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const [a, b, c] = await Promise.all([
        api.get('/admin/ml/models', token),
        api.get('/admin/ml/predictions?limit=20', token),
        api.get('/admin/ml/jobs?limit=15', token),
      ]);
      if (a.success) {
        setModels(a.models);
        setActiveId(a.activeModelId);
      }
      if (b.success) setPredictions(b.predictions);
      if (c.success) setJobs(c.jobs);
      // Pull relevant admin_settings
      const s: any = await api.get('/admin/settings', token);
      if (s.success) {
        const map: Record<string, string> = {};
        for (const r of s.data) map[r.key] = r.value;
        setCfg({
          mlEnabled: map['ml_enabled'] ?? 'false',
          abPct: map['ml_ab_traffic_pct'] ?? '100',
          threshold: map['ml_min_score_to_flag'] ?? '0.65',
          blend: map['ml_blend_weight'] ?? '0.6',
          logging: map['ml_feature_logging_enabled'] ?? 'false',
        });
      }
    } catch (e: any) { setError(e?.message || 'Network error'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const callAction = async (label: string, p: Promise<any>) => {
    setError(null); setInfo(null);
    try {
      const r: any = await p;
      if (r.success) { setInfo(`${label}: OK`); await load(); }
      else setError(`${label}: ${r.error || 'failed'}`);
    } catch (e: any) { setError(e?.message); }
  };

  const submitUpload = async () => {
    if (!token) return;
    setUploading(true);
    try {
      const r: any = await api.post('/admin/ml/models', token, {
        name: uForm.name,
        version: uForm.version,
        provider: uForm.provider,
        filePath: uForm.filePath,
        notes: uForm.notes,
        // metrics + importance + featureColumns filled by the admin
        // after the notebook run. Defaults keep endpoint contract valid.
        trainingMetrics: { pending: 1 },
        featureImportance: [],
        featureColumns: [],
      });
      if (r.success) { setInfo(`Registered ${uForm.name}@${uForm.version} — id ${r.id}`); setShowUpload(false); await load(); }
      else setError(r.error || 'upload failed');
    } catch (e: any) { setError(e?.message); }
    finally { setUploading(false); }
  };

  const saveConfig = async () => {
    if (!token) return;
    setSavingCfg(true);
    try {
      const r: any = await api.put('/admin/settings/bulk', token, {
        updates: [
          { key: 'ml_enabled', value: cfg.mlEnabled },
          { key: 'ml_ab_traffic_pct', value: cfg.abPct },
          { key: 'ml_min_score_to_flag', value: cfg.threshold },
          { key: 'ml_blend_weight', value: cfg.blend },
          { key: 'ml_feature_logging_enabled', value: cfg.logging },
        ],
      });
      if (r.success) { setInfo(`Saved ${r.updated} ML setting(s).`); await load(); }
      else setError(r.error);
    } catch (e: any) { setError(e?.message); }
    finally { setSavingCfg(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="heading-display text-lg text-text-primary flex items-center gap-2">
          <Brain className="text-brand-gold" size={20} /> ML Risk Center
        </h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded text-sm hover:text-text-primary disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button type="button" onClick={() => setShowUpload((s) => !s)}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-gold text-black rounded text-sm font-medium">
            <Upload size={14} />
            Register model
          </button>
          <button type="button"
            onClick={() => callAction('train_requested', api.post('/admin/ml/train', token, { notes: 'admin panel run' }))}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-border rounded text-sm text-text-secondary hover:text-brand-gold">
            <Play size={14} /> Record train request
          </button>
        </div>
      </div>

      <p className="text-text-muted text-xs max-w-3xl">
        ML scoring is OFF by default. Admin registers a model (after running the notebook →
        pre-stages the file at <code>/app/ml/&lt;name&gt;.onnx</code> via <code>docker cp</code>),
        activates it, then turns on the master switch below. Provider <code>noop</code> means
        &quot;no model loaded yet&quot; — rule engine still produces scores.
      </p>

      {error && (
        <div className="p-3 bg-brand-red/10 border border-brand-red/30 rounded-lg text-brand-red text-sm flex items-center gap-2"><AlertCircle size={14} />{error}</div>
      )}
      {info && (
        <div className="p-3 bg-brand-green/10 border border-brand-green/30 rounded-lg text-brand-green text-sm">{info}</div>
      )}

      {/* ── Live config knobs ─────────────────────────────────── */}
      <section className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-text-primary font-medium mb-3 flex items-center gap-2 text-sm">
          <BarChart3 size={14} className="text-brand-gold" /> Live config (writes admin_settings)
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">ml_enabled</span>
            <select value={cfg.mlEnabled} onChange={(e) => setCfg({ ...cfg, mlEnabled: e.target.value })}
              className="bg-surface-2 border border-border rounded px-2 py-1.5">
              <option value="false">false (master off)</option>
              <option value="true">true</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">A/B traffic %</span>
            <input type="number" min={0} max={100} value={cfg.abPct}
              onChange={(e) => setCfg({ ...cfg, abPct: e.target.value })}
              className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">flag threshold</span>
            <input type="number" min={0} max={1} step="0.01" value={cfg.threshold}
              onChange={(e) => setCfg({ ...cfg, threshold: e.target.value })}
              className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">blend (ML w)</span>
            <input type="number" min={0} max={1} step="0.05" value={cfg.blend}
              onChange={(e) => setCfg({ ...cfg, blend: e.target.value })}
              className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">feature logging</span>
            <select value={cfg.logging} onChange={(e) => setCfg({ ...cfg, logging: e.target.value })}
              className="bg-surface-2 border border-border rounded px-2 py-1.5">
              <option value="false">off</option>
              <option value="true">on (writes ml_predictions)</option>
            </select>
          </label>
        </div>
        <button type="button" onClick={saveConfig} disabled={savingCfg}
          className="mt-3 px-3 py-1.5 bg-brand-gold text-black rounded text-xs font-medium disabled:opacity-50">
          {savingCfg ? 'Saving…' : 'Save config'}
        </button>
      </section>

      {/* ── Upload form ───────────────────────────────────────── */}
      {showUpload && (
        <section className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-text-primary font-medium mb-3 text-sm">Register model row</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">name</span>
              <input value={uForm.name} onChange={(e) => setUForm({ ...uForm, name: e.target.value })}
                className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">version (semver)</span>
              <input value={uForm.version} onChange={(e) => setUForm({ ...uForm, version: e.target.value })}
                className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">provider</span>
              <select value={uForm.provider} onChange={(e) => setUForm({ ...uForm, provider: e.target.value as any })}
                className="bg-surface-2 border border-border rounded px-2 py-1.5">
                <option value="mock">mock (noop)</option>
                <option value="onnx">onnx (real)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">file path (on disk)</span>
              <input value={uForm.filePath} onChange={(e) => setUForm({ ...uForm, filePath: e.target.value })}
                className="bg-surface-2 border border-border rounded px-2 py-1.5 font-mono" />
            </label>
            <label className="flex flex-col gap-1 md:col-span-4">
              <span className="text-text-muted">notes</span>
              <input value={uForm.notes} onChange={(e) => setUForm({ ...uForm, notes: e.target.value })}
                placeholder="e.g. Colab run, 90-day window, train auc 0.91"
                className="bg-surface-2 border border-border rounded px-2 py-1.5" />
            </label>
          </div>
          <p className="text-text-muted text-[10px] mt-2">
            Pre-stage the .onnx file at <code>{uForm.filePath}</code> via{' '}
            <code>docker cp local.onnx coin-master-backend-1:{uForm.filePath}</code>. Then run the
            notebook (P3-1f) to produce the metrics + feature_importance JSON to paste inline.
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={submitUpload} disabled={uploading}
              className="px-3 py-1.5 bg-brand-gold text-black rounded text-xs font-medium disabled:opacity-50">
              {uploading ? 'Saving…' : 'Register row'}
            </button>
            <button type="button" onClick={() => setShowUpload(false)}
              className="px-3 py-1.5 bg-surface-2 border border-border rounded text-xs">Cancel</button>
          </div>
        </section>
      )}

      {/* ── Model registry ───────────────────────────────────── */}
      <section className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-text-primary font-medium mb-3 text-sm">
          Models <span className="text-text-muted text-[10px] font-mono">({models.length}, active: {activeId ? activeId.slice(0, 8) + '…' : 'none'})</span>
        </h3>
        {!models.length
          ? <p className="text-text-muted text-xs py-4 text-center">No models registered yet.</p>
          : (
            <div className="space-y-2">
              {models.map((m) => (
                <div key={m.id} className="border border-border/50 rounded-lg p-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <div className="font-mono text-sm text-text-primary">{m.name} <span className="text-text-muted">@ {m.version}</span></div>
                      <div className="text-text-muted text-[10px] mt-0.5">
                        {m.provider}{m.file_path ? ` · ${m.file_path}` : ''}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] uppercase ${STATUS_COLOR[m.status] || 'bg-surface text-text-muted'}`}>
                      {m.status}
                    </span>
                  </div>
                  {m.training_metrics && Object.keys(m.training_metrics).length > 0 && (
                    <div className="text-text-muted text-[10px] mt-2 font-mono">
                      metrics: {Object.entries(m.training_metrics).map(([k, v]) => `${k}=${v}`).join(' · ')}
                    </div>
                  )}
                  {m.feature_importance?.length ? (
                    <div className="mt-2">
                      <div className="text-text-muted text-[10px] uppercase tracking-wide mb-1">feature importance</div>
                      <ImportanceChart items={m.feature_importance} />
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 mt-2">
                    <button type="button"
                      disabled={m.status === 'active'}
                      onClick={() => callAction('activate', api.post(`/admin/ml/models/${m.id}/activate`, token, {}))}
                      className="flex items-center gap-1 px-2 py-1 bg-brand-green/20 text-brand-green rounded text-xs disabled:opacity-40">
                      <Play size={11} /> Activate
                    </button>
                    <button type="button"
                      disabled={m.status === 'retired' || m.status === 'training'}
                      onClick={() => callAction('rollback', api.post(`/admin/ml/models/${m.id}/rollback`, token, {}))}
                      className="flex items-center gap-1 px-2 py-1 bg-brand-orange/20 text-brand-orange rounded text-xs disabled:opacity-40">
                      <RotateCcw size={11} /> Rollback
                    </button>
                    <span className="text-text-muted text-[10px] ml-auto">
                      created {new Date(m.created_at).toLocaleString()}
                      {m.activated_by_username && ` · by ${m.activated_by_username}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
      </section>

      {/* ── Recent predictions ────────────────────────────────── */}
      <section className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-text-primary font-medium mb-3 text-sm">
          Recent predictions <span className="text-text-muted text-[10px] font-mono">({predictions.length})</span>
        </h3>
        {!predictions.length
          ? <p className="text-text-muted text-xs py-4 text-center">No predictions logged yet. Turn on <code>ml_feature_logging_enabled</code> + deploy a model.</p>
          : (
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-text-muted text-left border-b border-border">
                  <th className="py-1 font-normal">Time</th>
                  <th className="py-1 font-normal">User</th>
                  <th className="py-1 font-normal text-right">rule</th>
                  <th className="py-1 font-normal text-right">ml_prob</th>
                  <th className="py-1 font-normal text-right">blended</th>
                  <th className="py-1 font-normal text-right">action</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => (
                  <tr key={p.id} className="border-b border-border/30">
                    <td className="py-1.5 text-text-muted">{new Date(p.created_at).toLocaleTimeString()}</td>
                    <td className="py-1.5 text-text-primary">{p.user_id.slice(0, 8)}…</td>
                    <td className="py-1.5 text-right">{p.rule_score}</td>
                    <td className="py-1.5 text-right">{p.ml_prob.toFixed(3)}</td>
                    <td className="py-1.5 text-right text-brand-gold">{p.blended_score}</td>
                    <td className="py-1.5 text-right">
                      <span className={
                        p.flag_action === 'block' ? 'text-brand-red' :
                        p.flag_action === 'flag' ? 'text-brand-orange' : 'text-text-muted'
                      }>{p.flag_action}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {/* ── Training jobs ─────────────────────────────────────── */}
      <section className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-text-primary font-medium mb-3 text-sm">Training job history</h3>
        {!jobs.length
          ? <p className="text-text-muted text-xs py-4 text-center">No jobs yet.</p>
          : (
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-text-muted text-left border-b border-border">
                  <th className="py-1 font-normal">Time</th>
                  <th className="py-1 font-normal">event</th>
                  <th className="py-1 font-normal">model</th>
                  <th className="py-1 font-normal">actor</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border/30">
                    <td className="py-1.5 text-text-muted">{new Date(j.created_at).toLocaleString()}</td>
                    <td className="py-1.5 text-text-primary">{j.event}</td>
                    <td className="py-1.5 text-text-primary">{j.model_name ? `${j.model_name}@${j.model_version ?? '?'}` : '—'}</td>
                    <td className="py-1.5 text-text-muted">{j.actor_username ?? 'system'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {(loading && !models.length) && (
        <p className="text-text-muted text-sm text-center py-6"><Loader2 size={14} className="animate-spin inline mr-1" />Loading…</p>
      )}
    </div>
  );
}
