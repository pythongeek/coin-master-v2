'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  AdminSettingsPanel — Phase 2.4
 *  Full live CRUD for admin_settings. Curated groups so the UI
 *  doesn't dump every row of admin_settings into a single table.
 *
 *  Surgical scope: pure addition. No other admin tabs touched.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import { SlidersHorizontal, Save, RefreshCw, Search, AlertCircle } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

interface SettingRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: string | Date | null;
}

const GROUPS_ORDER = [
  'Bonus & Wagering',
  'Fraud Detection',
  'IP Reputation',
  'Safety & Limits',
  'Admin & Auth',
  'Other',
] as const;

export default function AdminSettingsPanel() {
  const token = useGameStore((s) => s.token);
  const [groups, setGroups] = useState<Record<string, SettingRow[]> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r: any = await api.get('/admin/settings/groups', token);
      if (r.success) setGroups(r.groups);
      else setError(r.error || 'Load failed');
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (key: string, current: string) => {
    setEdits((prev) => ({ ...prev, [key]: current }));
  };

  const cancelEdit = (key: string) => {
    setEdits((prev) => {
      const c = { ...prev };
      delete c[key];
      return c;
    });
  };

  const setEdit = (key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  const saveAll = async () => {
    if (!token) return;
    const keys = Object.keys(edits);
    if (keys.length === 0) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const updates = keys.map((k) => {
        const row = findRow(groups, k);
        return {
          key: k,
          value: edits[k],
          description: row?.description ?? undefined,
        };
      });
      const r: any = await api.put('/admin/settings/bulk', token, { updates });
      if (r.success) {
        setInfo(`Saved ${r.updated} setting(s).`);
        setEdits({});
        await load();
      } else {
        setError(r.error || 'Save failed');
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="heading-display text-lg text-text-primary flex items-center gap-2">
          <SlidersHorizontal className="text-brand-gold" size={20} /> Admin Settings
        </h2>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter by key…"
            value={filter}
            onChange={(e) => setFilter(e.target.value.toLowerCase())}
            className="bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary w-48"
          />
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || Object.keys(edits).length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-gold text-black rounded-lg text-sm font-medium disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving…' : `Save ${Object.keys(edits).length} change(s)`}
          </button>
        </div>
      </div>

      <p className="text-text-muted text-xs font-mono max-w-2xl">
        Live-tunable runtime settings. Changes take effect immediately for
        the services that read them (e.g. ip_reputation_provider, fraud
        thresholds, bonus parameters). super_admin only. All writes
        audit-logged.
      </p>

      {error && (
        <div className="p-3 bg-brand-red/10 border border-brand-red/30 rounded-lg text-brand-red text-sm flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {info && (
        <div className="p-3 bg-brand-green/10 border border-brand-green/30 rounded-lg text-brand-green text-sm">
          {info}
        </div>
      )}

      {!groups && !error && (
        <p className="text-text-muted text-sm py-8 text-center">{loading ? 'Loading…' : 'No settings found.'}</p>
      )}

      {groups && GROUPS_ORDER.map((groupName) => {
        const rows = (groups[groupName] || []).filter(
          (r) => !filter || r.key.toLowerCase().includes(filter),
        );
        if (rows.length === 0) return null;
        return (
          <section key={groupName} className="bg-surface border border-border rounded-lg p-4">
            <h3 className="text-text-primary font-medium mb-3 flex items-center justify-between">
              <span>{groupName}</span>
              <span className="text-text-muted text-xs font-mono">{rows.length} key(s)</span>
            </h3>
            <div className="space-y-2">
              {rows.map((r) => {
                const editing = Object.prototype.hasOwnProperty.call(edits, r.key);
                const editedValue = editing ? edits[r.key] : r.value;
                const changed = editing && edits[r.key] !== r.value;
                return (
                  <div key={r.key} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start border-b border-border pb-2 last:border-0">
                    <div className="md:col-span-3">
                      <div className="text-text-primary font-mono text-xs">{r.key}</div>
                      {r.description && (
                        <div className="text-text-muted text-[10px] mt-1">{r.description}</div>
                      )}
                    </div>
                    <div className="md:col-span-7">
                      {editing ? (
                        <input
                          type="text"
                          value={editedValue}
                          onChange={(e) => setEdit(r.key, e.target.value)}
                          className={`w-full bg-surface-2 border rounded-lg px-2 py-1 text-sm font-mono ${changed ? 'border-brand-gold text-text-primary' : 'border-border text-text-muted'}`}
                        />
                      ) : (
                        <code className="text-text-muted text-xs bg-surface-2 px-2 py-1 rounded block break-all">
                          {r.value}
                        </code>
                      )}
                    </div>
                    <div className="md:col-span-2 flex items-center justify-end gap-2">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => cancelEdit(r.key)}
                            className="text-xs text-text-muted hover:text-text-primary"
                          >
                            Cancel
                          </button>
                          <span className="text-xs text-text-muted">
                            {r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '—'}
                          </span>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(r.key, r.value)}
                          className="px-2 py-1 bg-surface-2 border border-border rounded text-xs text-text-secondary hover:text-brand-gold"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function findRow(
  groups: Record<string, SettingRow[]> | null,
  key: string,
): SettingRow | undefined {
  if (!groups) return undefined;
  for (const arr of Object.values(groups)) {
    const r = arr.find((x) => x.key === key);
    if (r) return r;
  }
  return undefined;
}