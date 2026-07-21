'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  AdminCohorts — Phase 3 / P3-6
 *
 *  Sub-panel for the Behavioral Cohort Comparison (weekly batch).
 *  Embedded in the Fraud Center. Four sections:
 *
 *    1. Status card — enabled flag + next scheduled run + z-threshold
 *    2. Cohort overview — list of cohorts with size + last-computed-at
 *    3. Outlier review — recent outliers with severity chips
 *    4. Actions — "Run weekly analysis now" button
 *
 *  Auth: relies on the parent AdminClientShell being super_admin.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Users, RefreshCw, Send, AlertCircle, CheckCircle2,
  Calendar, Settings as SettingsIcon, AlertOctagon, Clock,
  Activity, BarChart3,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import { useToast } from '@/components/providers/ToastProvider';

interface CohortRow {
  cohort_key: string;
  size: number;
  last_computed_at: string | null;
}
interface OutlierRow {
  user_id: string;
  cohort_key: string;
  metric: string;
  user_value: number;
  cohort_mean: number;
  cohort_stddev: number;
  z_score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detected_at: string;
}
interface CohortSettings {
  cohort_analysis_enabled?: string;
  cohort_analysis_z_threshold?: string;
  cohort_analysis_lookback_days?: string;
  cohort_analysis_send_hour_utc?: string;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-brand-red/20 text-brand-red',
  high:     'bg-brand-orange/20 text-brand-orange',
  medium:   'bg-brand-gold/20 text-brand-gold',
  low:      'bg-blue-500/20 text-blue-400',
};

export default function AdminCohorts() {
  const token = useGameStore((s) => s.token);
  const toast = useToast();
  const [cohorts, setCohorts] = useState<CohortRow[]>([]);
  const [outliers, setOutliers] = useState<OutlierRow[]>([]);
  const [settings, setSettings] = useState<CohortSettings>({});
  const [totalOutliers, setTotalOutliers] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [o, s] = await Promise.all([
        api.get('/admin/cohorts/overview', token),
        api.get('/admin/cohorts/settings', token),
      ]);
      if (!o.success) throw new Error(o.error || 'overview failed');
      if (!s.success) throw new Error(s.error || 'settings failed');
      setCohorts(o.data.cohorts);
      setTotalOutliers(o.data.total_outliers);
      setEnabled(o.data.enabled);
      setSettings(s.data);
      // Outliers (best-effort; non-fatal if it fails)
      try {
        const r = await api.get('/admin/cohorts/outliers?limit=30', token);
        if (r.success) setOutliers(r.data);
      } catch { /* ignore */ }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const setToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    if (toast?.addToast) toast.addToast(msg, kind);
    if (kind === 'success') setInfo(msg); else setError(msg);
  };

  const onRunNow = async () => {
    if (!token) return;
    if (!confirm('Run the weekly cohort analysis now? This may take a few minutes on large user bases.')) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.post('/admin/cohorts/run-now', token, {});
      if (!r.success) throw new Error(r.error || 'run-now failed');
      const d = r.data;
      setToast(`Run complete: cohorts=${d.cohortsScanned}, outliers=${d.outliersFound}, signals=${d.signalsWritten}, errors=${d.errors.length}`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading && cohorts.length === 0 && outliers.length === 0) {
    return (
      <div className="p-6 text-slate-400 flex items-center gap-2">
        <RefreshCw className="animate-spin" size={16} /> Loading…
      </div>
    );
  }

  const z = Number(settings.cohort_analysis_z_threshold ?? '2.5');
  const lookback = Number(settings.cohort_analysis_lookback_days ?? '90');
  const sendHour = Number(settings.cohort_analysis_send_hour_utc ?? '4');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users size={20} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-slate-100">Cohort Comparison (P3-6)</h2>
          <span className="text-xs text-slate-500">Weekly batch, Sunday {sendHour}:00 UTC</span>
        </div>
        <button
          onClick={() => load()}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-100 rounded"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-rose-900/40 text-rose-200 text-sm flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}
      {info && (
        <div className="p-3 rounded bg-emerald-900/30 text-emerald-200 text-sm flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
          <div>{info}</div>
        </div>
      )}

      {/* ── Section 1: Status ──────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Calendar size={16} /> Status
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-slate-500">Enabled?</div>
            <div className={enabled ? 'text-emerald-300' : 'text-amber-300'}>
              {enabled ? 'yes — weekly batch will run' : 'paused'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Schedule</div>
            <div className="text-slate-100">Sunday {sendHour}:00 UTC (z≥{z.toFixed(1)}, {lookback}d window)</div>
          </div>
          <div>
            <div className="text-slate-500">Cohorts tracked</div>
            <div className="text-slate-100">{cohorts.length}</div>
          </div>
          <div>
            <div className="text-slate-500">Total outliers (lifetime)</div>
            <div className="text-slate-100">{totalOutliers}</div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Actions ──────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Send size={16} /> Actions
        </h3>
        <button
          onClick={onRunNow}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
        >
          <Send size={14} /> Run weekly analysis now
        </button>
        <p className="mt-2 text-xs text-slate-500">
          Runs the same code path as the Sunday cron. Safe to run multiple times — the operations are idempotent.
        </p>
      </div>

      {/* ── Section 3: Cohort overview ───────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <BarChart3 size={16} /> Cohorts ({cohorts.length})
        </h3>
        {cohorts.length === 0 ? (
          <p className="text-xs text-slate-500">No cohorts yet. Click "Run weekly analysis now" to compute the first batch.</p>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left p-1">cohort_key</th>
                <th className="text-right p-1">size</th>
                <th className="text-left p-1">last computed</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.cohort_key} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="p-1 text-slate-200 font-mono">{c.cohort_key}</td>
                  <td className="p-1 text-slate-300 text-right">{c.size}</td>
                  <td className="p-1 text-slate-500 flex items-center gap-1">
                    <Clock size={10} />
                    {c.last_computed_at ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Section 4: Outliers ──────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <AlertOctagon size={16} /> Recent outliers ({outliers.length})
        </h3>
        {outliers.length === 0 ? (
          <p className="text-xs text-slate-500">No outliers detected in the last batch. Either the user base is well-behaved or no batch has run yet.</p>
        ) : (
          <div className="space-y-2">
            {outliers.map((o, i) => (
              <div key={i} className={`bg-surface border rounded p-2 ${
                o.severity === 'critical' ? 'border-brand-red/40'
                  : o.severity === 'high' ? 'border-brand-orange/40'
                  : o.severity === 'medium' ? 'border-brand-gold/40'
                  : 'border-border'
              }`}>
                <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${SEVERITY_STYLES[o.severity] || ''}`}>
                      {o.severity}
                    </span>
                    <span className="text-slate-300 font-mono">user={o.user_id.slice(0, 8)}</span>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-400">cohort={o.cohort_key}</span>
                  </div>
                  <span className="text-text-muted text-[10px]">{new Date(o.detected_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-xs text-slate-200">
                  <span className="text-slate-500">metric:</span> {o.metric}{' '}
                  <span className="text-slate-500">· value:</span> {Number(o.user_value).toFixed(2)}{' '}
                  <span className="text-slate-500">· cohort μ:</span> {Number(o.cohort_mean).toFixed(2)}{' '}
                  <span className="text-slate-500">· cohort σ:</span> {Number(o.cohort_stddev).toFixed(2)}
                </div>
                <div className="mt-1 text-xs">
                  <span className="text-slate-500">z-score:</span>{' '}
                  <span className={
                    Math.abs(o.z_score) >= 6 ? 'text-brand-red font-bold'
                      : Math.abs(o.z_score) >= 4 ? 'text-brand-orange font-bold'
                      : 'text-brand-gold font-bold'
                  }>
                    {o.z_score >= 0 ? '+' : ''}{o.z_score.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Section 5: Settings info ─────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <SettingsIcon size={16} /> Settings
        </h3>
        <p className="text-xs text-slate-500 mb-2">
          Edit via <code className="bg-slate-900 px-1 rounded">admin_settings</code> directly (or use the existing Admin Settings panel):
        </p>
        <table className="w-full text-xs font-mono">
          <tbody>
            <tr><td className="p-1 text-slate-500">cohort_analysis_enabled</td><td className="p-1 text-slate-200">{settings.cohort_analysis_enabled ?? 'true'}</td></tr>
            <tr><td className="p-1 text-slate-500">cohort_analysis_z_threshold</td><td className="p-1 text-slate-200">{settings.cohort_analysis_z_threshold ?? '2.5'}</td></tr>
            <tr><td className="p-1 text-slate-500">cohort_analysis_lookback_days</td><td className="p-1 text-slate-200">{settings.cohort_analysis_lookback_days ?? '90'}</td></tr>
            <tr><td className="p-1 text-slate-500">cohort_analysis_send_hour_utc</td><td className="p-1 text-slate-200">{settings.cohort_analysis_send_hour_utc ?? '4'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}