'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  AdminFraudDigest — Phase 3 / P3-5
 *
 *  Sub-panel for the Daily Fraud Digest (08:00 UTC). Embedded in
 *  the Fraud Center. Five sections:
 *
 *    1. Status card — enabled flag + recipient + send hour + last sent
 *    2. Recent history table — last 30 days of digests
 *    3. Settings — toggle enabled, edit recipient, edit send hour,
 *       edit min_signals threshold
 *    4. Actions — "Send test now" + "Preview" buttons
 *    5. Preview payload — JSON dump of what the digest would contain
 *
 *  Auth: relies on the parent AdminClientShell being super_admin.
 *  The backend returns 403 if the role is wrong.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Mail, Save, RefreshCw, Send, Eye, AlertCircle, CheckCircle2,
  Calendar, Settings as SettingsIcon, Clock, ListChecks,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import { useToast } from '@/components/providers/ToastProvider';

interface DigestRow {
  id: number; report_date: string; report_kind: string;
  recipient: string; queued_at: string; sent_at: string | null;
  status: string; last_error: string | null; total_signals: number;
}
interface DigestSettings {
  daily_fraud_report_enabled?: string;
  daily_fraud_report_recipient?: string;
  daily_fraud_report_send_hour_utc?: string;
  daily_fraud_report_min_signals?: string;
}

export default function AdminFraudDigest() {
  const token = useGameStore((s) => s.token);
  const toast = useToast();
  const [history, setHistory] = useState<DigestRow[]>([]);
  const [settings, setSettings] = useState<DigestSettings>({});
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Edit buffers
  const [recipientDraft, setRecipientDraft] = useState('');
  const [hourDraft, setHourDraft] = useState('8');
  const [minSignalsDraft, setMinSignalsDraft] = useState('1');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [h, s] = await Promise.all([
        api.get('/admin/fraud/reports?limit=30', token),
        api.get('/admin/fraud/reports/settings', token),
      ]);
      if (!h.success) throw new Error(h.error || 'history failed');
      if (!s.success) throw new Error(s.error || 'settings failed');
      setHistory(h.data as DigestRow[]);
      setSettings(s.data as DigestSettings);
      setRecipientDraft((s.data as DigestSettings).daily_fraud_report_recipient ?? 'ohmyholy99@gmail.com');
      setHourDraft((s.data as DigestSettings).daily_fraud_report_send_hour_utc ?? '8');
      setMinSignalsDraft((s.data as DigestSettings).daily_fraud_report_min_signals ?? '1');
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

  const onSendNow = async (force: boolean) => {
    if (!token) return;
    if (!confirm(`Send a digest now${force ? ' (force re-send)' : ''}?`)) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.post('/admin/fraud/reports/send-now', token, {
        force,
        recipient: recipientDraft.trim() || undefined,
      });
      if (!r.success) throw new Error(r.error || 'send failed');
      setToast(`Digest queued (sent=${r.data?.sent}, reason=${r.data?.reason ?? 'ok'})`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const onPreview = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/admin/fraud/reports/preview', token);
      if (!r.success) throw new Error(r.error || 'preview failed');
      setPreview(r.data as Record<string, unknown>);
      setToast('Preview rendered.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const onSaveSettings = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        enabled: settings.daily_fraud_report_enabled === 'true',
        recipient: recipientDraft.trim(),
        send_hour_utc: parseInt(hourDraft, 10),
        min_signals: parseInt(minSignalsDraft, 10),
      };
      const r = await api.post('/admin/fraud/reports/settings', token, body);
      if (!r.success) throw new Error(r.error || 'save failed');
      setToast('Settings saved.');
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const onToggleEnabled = async () => {
    if (!token) return;
    const next = settings.daily_fraud_report_enabled !== 'true';
    setLoading(true);
    setError(null);
    try {
      const r = await api.post('/admin/fraud/reports/settings', token, { enabled: next });
      if (!r.success) throw new Error(r.error || 'toggle failed');
      setToast(`Daily digest ${next ? 'enabled' : 'paused'}.`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading && history.length === 0 && Object.keys(settings).length === 0) {
    return (
      <div className="p-6 text-slate-400 flex items-center gap-2">
        <RefreshCw className="animate-spin" size={16} /> Loading…
      </div>
    );
  }

  const enabled = settings.daily_fraud_report_enabled === 'true';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail size={20} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-slate-100">Daily Fraud Digest (P3-5)</h2>
          <span className="text-xs text-slate-500">Sends at {settings.daily_fraud_report_send_hour_utc ?? '8'}:00 UTC</span>
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

      {/* ── Section 1: Status ────────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Calendar size={16} /> Status
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-slate-500">Enabled?</div>
            <div className={enabled ? 'text-emerald-300' : 'text-amber-300'}>
              {enabled ? 'yes — daily digest will fire' : 'paused'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Recipient</div>
            <div className="text-slate-100 font-mono">
              {settings.daily_fraud_report_recipient ?? '(unset)'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Send hour (UTC)</div>
            <div className="text-slate-100">{settings.daily_fraud_report_send_hour_utc ?? '8'}:00</div>
          </div>
          <div>
            <div className="text-slate-500">Min signals / day</div>
            <div className="text-slate-100">{settings.daily_fraud_report_min_signals ?? '1'}</div>
          </div>
          <div>
            <div className="text-slate-500">Last digest</div>
            <div className="text-slate-100">
              {history.length > 0
                ? `${history[0].report_date} (${history[0].status}, ${history[0].total_signals} signals)`
                : 'none yet'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Total digests</div>
            <div className="text-slate-100">{history.length}</div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Actions ───────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Send size={16} /> Actions
        </h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onSendNow(false)}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
          >
            <Send size={14} /> Send today's digest
          </button>
          <button
            onClick={() => onSendNow(true)}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded"
          >
            <Send size={14} /> Force re-send (bypass idempotency)
          </button>
          <button
            onClick={onPreview}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-100 rounded"
          >
            <Eye size={14} /> Preview (no send)
          </button>
          <button
            onClick={onToggleEnabled}
            disabled={loading}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded ${
              enabled ? 'bg-rose-700 hover:bg-rose-600' : 'bg-emerald-700 hover:bg-emerald-600'
            } text-white`}
          >
            {enabled ? 'Pause digest' : 'Resume digest'}
          </button>
        </div>
        {preview && (
          <details className="mt-3">
            <summary className="text-xs text-slate-400 cursor-pointer">
              Preview payload ({Object.keys(preview).length} top-level fields,{' '}
              total_signals={String(preview.total_signals ?? '?')})
            </summary>
            <pre className="mt-2 text-xs bg-slate-950 p-3 rounded text-slate-200 overflow-x-auto max-h-96">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </details>
        )}
      </div>

      {/* ── Section 3: Settings ─────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <SettingsIcon size={16} /> Settings
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400">Recipient email</label>
            <input
              type="email"
              value={recipientDraft}
              onChange={(e) => setRecipientDraft(e.target.value)}
              className="w-full mt-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-sm"
              placeholder="ohmyholy99@gmail.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400">Send hour (UTC, 0–23)</label>
              <input
                type="number"
                min={0}
                max={23}
                value={hourDraft}
                onChange={(e) => setHourDraft(e.target.value)}
                className="w-full mt-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">Min signals to send</label>
              <input
                type="number"
                min={0}
                value={minSignalsDraft}
                onChange={(e) => setMinSignalsDraft(e.target.value)}
                className="w-full mt-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-sm"
              />
            </div>
          </div>
          <button
            onClick={onSaveSettings}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
          >
            <Save size={14} /> Save settings
          </button>
        </div>
      </div>

      {/* ── Section 4: History ───────────────────────────────── */}
      <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <ListChecks size={16} /> History (last 30)
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">No digests yet. Click "Send today's digest" to generate one.</p>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left p-1">id</th>
                <th className="text-left p-1">date</th>
                <th className="text-left p-1">kind</th>
                <th className="text-left p-1">status</th>
                <th className="text-left p-1">signals</th>
                <th className="text-left p-1">recipient</th>
                <th className="text-left p-1">queued</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="p-1 text-slate-300">{row.id}</td>
                  <td className="p-1 text-slate-200">{row.report_date}</td>
                  <td className="p-1 text-slate-400">{row.report_kind}</td>
                  <td className={`p-1 ${
                    row.status === 'sent' ? 'text-emerald-300'
                      : row.status === 'error' ? 'text-rose-300'
                      : row.status === 'skipped' ? 'text-amber-300'
                      : 'text-slate-200'
                  }`}>{row.status}</td>
                  <td className="p-1 text-slate-300">{row.total_signals}</td>
                  <td className="p-1 text-slate-400 truncate max-w-xs">{row.recipient}</td>
                  <td className="p-1 text-slate-500 flex items-center gap-1">
                    <Clock size={10} />
                    {new Date(row.queued_at).toISOString().slice(11, 19)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}