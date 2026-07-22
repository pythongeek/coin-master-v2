'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  AdminGeoipSettings — Phase 3 / P3-4b
 *
 *  Operator UI for the MaxMind GeoIP2 integration. Five sections:
 *
 *    1. Status card — provider, .mmdb file size/mtime, in-process
 *       reader state, cache row counts.
 *    2. Provider switcher — radio buttons (maxmind / geoip_lite /
 *       noop) + mmdb_path input. Save → invalidates the in-process
 *       reader on the backend (no container restart).
 *    3. High-risk country editor — pill-style chip list. Add/remove
 *       2-letter ISO codes. Empty list falls back to defaults.
 *    4. Cache tools — purge maxmind / geoip_lite / all cache rows.
 *       Shows last 10 lookups for context.
 *    5. Live IP probe — admin types an IP, gets a full
 *       `lookupCountry()` record back.
 *
 *  Auth: relies on the parent AdminClientShell being super_admin
 *  (matches the existing super_admin-gated tabs). The component
 *  doesn't double-check on the client — the backend returns 403 if
 *  the role is wrong.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Globe2, Save, RefreshCw, Trash2, AlertCircle, CheckCircle2,
  Database, Search, ShieldAlert, ListChecks, Clock,
} from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import { useToast } from '@/components/providers/ToastProvider';

interface GeoipStatus {
  provider: 'maxmind' | 'geoip_lite' | 'noop';
  mmdbPath: string;
  fileStat: { exists: boolean; sizeBytes: number | null; mtime: string | null };
  reader: { loaded: boolean; path: string | null; lastError: string | null };
  cacheTtlDays: number;
  mismatchWeight: number;
  highRiskOverride: string;
  cacheRowCounts: Record<string, number>;
  lastLookups: Array<{
    ip: string; provider: string; country_code: string;
    is_anonymous: boolean; is_hosting: boolean; confidence: number;
    checked_at: string;
  }>;
}

interface HighRiskResponse {
  provenance: 'default' | 'admin_override';
  countries: string[];
}

export default function AdminGeoipSettings() {
  const token = useGameStore((s) => s.token);
  const toast = useToast();
  const [status, setStatus] = useState<GeoipStatus | null>(null);
  const [highRisk, setHighRisk] = useState<HighRiskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Edit buffers
  const [providerDraft, setProviderDraft] = useState<'maxmind' | 'geoip_lite' | 'noop'>('maxmind');
  const [mmdbPathDraft, setMmdbPathDraft] = useState('');
  const [countryDraft, setCountryDraft] = useState('');
  const [countriesDraft, setCountriesDraft] = useState<string[]>([]);
  const [probeIp, setProbeIp] = useState('');
  const [probeResult, setProbeResult] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([
        api.get('/admin/geoip/status', token),
        api.get('/admin/geoip/high-risk-countries', token),
      ]);
      if (!s.success) throw new Error(s.error || 'status failed');
      if (!h.success) throw new Error(h.error || 'high-risk failed');
      setStatus(s.data as GeoipStatus);
      setHighRisk(h.data as HighRiskResponse);
      setProviderDraft(s.data.provider);
      setMmdbPathDraft(s.data.mmdbPath);
      setCountriesDraft(h.data.countries);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const setToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    if (toast?.addToast) {
      toast.addToast(msg, kind);
    }
    if (kind === 'success') setInfo(msg); else setError(msg);
  };

  // ── Provider switch ──────────────────────────────────────────
  const onSaveProvider = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const body: { provider: string; mmdb_path?: string } = { provider: providerDraft };
      if (providerDraft === 'maxmind' && mmdbPathDraft.trim()) {
        body.mmdb_path = mmdbPathDraft.trim();
      }
      const r = await api.put('/admin/geoip/provider', token, body);
      if (!r.success) throw new Error(r.error || 'save failed');
      setToast(`Provider switched to ${providerDraft}.`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── High-risk countries ──────────────────────────────────────
  const onAddCountry = () => {
    const up = countryDraft.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(up)) {
      setToast('Country must be a 2-letter ISO code (e.g. KP, IR).', 'error');
      return;
    }
    if (countriesDraft.includes(up)) {
      setToast(`${up} already in list.`, 'error');
      return;
    }
    setCountriesDraft([...countriesDraft, up]);
    setCountryDraft('');
  };

  const onRemoveCountry = (code: string) => {
    setCountriesDraft(countriesDraft.filter((c) => c !== code));
  };

  const onSaveCountries = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.put('/admin/geoip/high-risk-countries', token, { countries: countriesDraft });
      if (!r.success) throw new Error(r.error || 'save failed');
      setToast(countriesDraft.length === 0
        ? 'Saved. Falling back to defaults.'
        : `Saved ${countriesDraft.length} countries.`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const onResetToDefaults = () => {
    // The default list lives in backend/src/services/maxmind.ts.
    // We mirror it client-side for the "reset" button convenience.
    setCountriesDraft(['KP', 'IR', 'MM', 'AF', 'YE', 'SY', 'SO', 'LY', 'SD', 'CD', 'XX', 'YY']);
  };

  // ── Cache purge ─────────────────────────────────────────────
  const onPurgeCache = async (provider: 'maxmind' | 'geoip_lite' | 'all') => {
    if (!token) return;
    if (!confirm(`Purge ${provider === 'all' ? 'all' : `the ${provider}`} cache rows?`)) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.post('/admin/geoip/cache/purge', token, { provider });
      if (!r.success) throw new Error(r.error || 'purge failed');
      setToast(`Purged ${r.data.deleted} cache rows.`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Probe ───────────────────────────────────────────────────
  const onProbe = async () => {
    if (!token) return;
    if (!probeIp.trim()) return;
    setLoading(true);
    setError(null);
    setProbeResult(null);
    try {
      const r = await api.get(`/admin/geoip/probe?ip=${encodeURIComponent(probeIp.trim())}`, token);
      if (!r.success) throw new Error(r.error || 'probe failed');
      setProbeResult(r.data);
      setToast(`Probe complete in ${r.data.elapsedMs}ms.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────
  if (loading && !status) {
    return (
      <div className="p-6 text-slate-400 flex items-center gap-2">
        <RefreshCw className="animate-spin" size={16} /> Loading…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe2 size={20} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-slate-100">GeoIP Settings (P3-4b)</h2>
          <span className="text-xs text-slate-500">MaxMind GeoLite2 + IP/KYC mismatch scoring</span>
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

      {status && (
        <>
          {/* ── Section 1: Status card ───────────────────────────── */}
          <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
              <Database size={16} /> Status
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-slate-500">Provider</div>
                <div className="text-slate-100 font-mono">{status.provider}</div>
              </div>
              <div>
                <div className="text-slate-500">Reader loaded?</div>
                <div className={status.reader.loaded ? 'text-emerald-300' : 'text-amber-300'}>
                  {status.reader.loaded ? 'yes' : 'no (falling back)'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">.mmdb path</div>
                <div className="text-slate-100 font-mono text-xs break-all">{status.mmdbPath}</div>
              </div>
              <div>
                <div className="text-slate-500">File exists?</div>
                <div className={status.fileStat.exists ? 'text-emerald-300' : 'text-rose-300'}>
                  {status.fileStat.exists ? `yes (${(status.fileStat.sizeBytes ?? 0).toLocaleString()} bytes)` : 'no'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Last open error</div>
                <div className="text-amber-300 text-xs">{status.reader.lastError ?? '—'}</div>
              </div>
              <div>
                <div className="text-slate-500">Cache rows</div>
                <div className="text-slate-100 font-mono">
                  {Object.entries(status.cacheRowCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '0'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Cache TTL</div>
                <div className="text-slate-100">{status.cacheTtlDays} days</div>
              </div>
              <div>
                <div className="text-slate-500">Mismatch weight</div>
                <div className="text-slate-100">{status.mismatchWeight}</div>
              </div>
            </div>
            {status.reader.lastError && !status.fileStat.exists && (
              <div className="mt-3 p-2 bg-slate-800/60 rounded text-xs text-slate-300">
                💡 Mount a <code>GeoLite2-Country.mmdb</code> at this path to enable real MaxMind lookups.
                Run <code className="bg-slate-900 px-1 rounded">./scripts/download-geoip.sh</code> with
                <code className="bg-slate-900 px-1 rounded ml-1">MAXMIND_LICENSE_KEY</code> set,
                then switch provider here.
              </div>
            )}
          </div>

          {/* ── Section 2: Provider switcher ─────────────────────── */}
          <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
              <ShieldAlert size={16} /> Provider
            </h3>
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="geoip-provider"
                  value="maxmind"
                  checked={providerDraft === 'maxmind'}
                  onChange={() => setProviderDraft('maxmind')}
                  className="mt-1"
                />
                <div>
                  <div className="text-slate-100">maxmind (default)</div>
                  <div className="text-xs text-slate-500">
                    Use the official MaxMind GeoLite2-Country .mmdb file. Most accurate;
                    detects anonymous/hosting traits. Requires the file at the path below.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="geoip-provider"
                  value="geoip_lite"
                  checked={providerDraft === 'geoip_lite'}
                  onChange={() => setProviderDraft('geoip_lite')}
                  className="mt-1"
                />
                <div>
                  <div className="text-slate-100">geoip_lite</div>
                  <div className="text-xs text-slate-500">
                    Always-on fallback using the npm `geoip-lite` package. Country only,
                    no anonymous/hosting detection. No .mmdb file required.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="geoip-provider"
                  value="noop"
                  checked={providerDraft === 'noop'}
                  onChange={() => setProviderDraft('noop')}
                  className="mt-1"
                />
                <div>
                  <div className="text-slate-100">noop (disabled)</div>
                  <div className="text-xs text-slate-500">
                    Disable geo lookup entirely. Useful for dev/sandboxes or to suppress
                    country-based signals during an investigation.
                  </div>
                </div>
              </label>
            </div>
            {providerDraft === 'maxmind' && (
              <div className="mt-3">
                <label className="text-xs text-slate-400">.mmdb path</label>
                <input
                  type="text"
                  value={mmdbPathDraft}
                  onChange={(e) => setMmdbPathDraft(e.target.value)}
                  className="w-full mt-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-xs"
                  placeholder="/app/geoip/GeoLite2-Country.mmdb"
                />
              </div>
            )}
            <button
              onClick={onSaveProvider}
              disabled={loading}
              className="mt-3 flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
            >
              <Save size={14} /> Save provider
            </button>
          </div>

          {/* ── Section 3: High-risk country editor ──────────────── */}
          <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
              <ListChecks size={16} /> High-risk countries
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              Users whose IP (or whose KYC country) is in this list get an
              <code className="bg-slate-900 px-1 rounded mx-1">ip_high_risk_country</code>
              fraud signal. Empty list falls back to defaults (KP, IR, MM, AF, YE, SY, SO, LY, SD, CD, XX, YY).
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
              {(countriesDraft.length === 0 ? ['— using defaults —'] : countriesDraft).map((c) => (
                <span key={c} className="flex items-center gap-1 px-2 py-1 bg-slate-800 rounded text-sm text-slate-100">
                  {c !== '— using defaults —' && (
                    <button
                      onClick={() => onRemoveCountry(c)}
                      className="text-rose-400 hover:text-rose-300"
                      aria-label={`Remove ${c}`}
                    >
                      ×
                    </button>
                  )}
                  {c}
                </span>
              ))}
            </div>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={countryDraft}
                onChange={(e) => setCountryDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddCountry(); } }}
                placeholder="2-letter ISO code"
                maxLength={2}
                className="flex-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 uppercase text-sm font-mono"
              />
              <button
                onClick={onAddCountry}
                className="px-3 py-1 text-sm bg-slate-700 hover:bg-slate-600 text-slate-100 rounded"
              >
                Add
              </button>
              <button
                onClick={onResetToDefaults}
                className="px-3 py-1 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
              >
                Use defaults
              </button>
            </div>
            <button
              onClick={onSaveCountries}
              disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
            >
              <Save size={14} /> Save countries
            </button>
          </div>

          {/* ── Section 4: Cache tools ───────────────────────────── */}
          <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
              <Trash2 size={16} /> Cache
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              Cache rows live for {status.cacheTtlDays} days. Purge after switching providers
              or when stale data is suspected.
            </p>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => onPurgeCache('maxmind')}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-100 rounded"
              >
                <Trash2 size={14} /> Purge maxmind
              </button>
              <button
                onClick={() => onPurgeCache('geoip_lite')}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-100 rounded"
              >
                <Trash2 size={14} /> Purge geoip_lite
              </button>
              <button
                onClick={() => onPurgeCache('all')}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-rose-800 hover:bg-rose-700 text-slate-100 rounded"
              >
                <Trash2 size={14} /> Purge all
              </button>
            </div>
            <div className="mt-3">
              <h4 className="text-xs text-slate-400 mb-2 flex items-center gap-1">
                <Clock size={12} /> Last 10 cache lookups
              </h4>
              <div className="space-y-1 text-xs font-mono">
                {status.lastLookups.length === 0 && (
                  <div className="text-slate-500">no lookups yet</div>
                )}
                {status.lastLookups.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 text-slate-300">
                    <span className="text-slate-500 w-32 truncate">{l.ip}</span>
                    <span className="text-slate-500 w-20">{l.provider}</span>
                    <span className="text-emerald-300">{l.country_code}</span>
                    {l.is_anonymous && <span className="text-rose-300">anon</span>}
                    {l.is_hosting && <span className="text-amber-300">hosting</span>}
                    <span className="text-slate-500 ml-auto">{(l.confidence ?? 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Section 5: Live IP probe ─────────────────────────── */}
          <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/40">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
              <Search size={16} /> Live probe
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              Look up a single IP and see exactly which provider answered, with full record.
              Useful for debugging KYC-mismatch signals.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={probeIp}
                onChange={(e) => setProbeIp(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onProbe(); } }}
                placeholder="8.8.8.8 or 2001:db8::1"
                className="flex-1 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-sm"
              />
              <button
                onClick={onProbe}
                disabled={loading || !probeIp.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded"
              >
                <Search size={14} /> Probe
              </button>
            </div>
            {probeResult != null && (
              <pre className="text-xs bg-slate-950 p-3 rounded text-slate-200 overflow-x-auto">
                {JSON.stringify(probeResult as object, null, 2)}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}