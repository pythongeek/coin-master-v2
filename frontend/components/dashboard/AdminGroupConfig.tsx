/**
 * ════════════════════════════════════════════════════════════════
 *  ADMIN GROUP CONFIG — Phase 2 / Day 9
 *  ════════════════════════════════════════════════════════════════
 *
 *  Tab inside the admin shell (rendered when `activeTab === 'group_config'`)
 *  that lets an operator tune the 24 group_play admin-config thresholds.
 *
 *  Reads/writes via the existing /api/admin/config endpoint:
 *    GET    /api/admin/config         → returns configWithMeta grouped by category
 *    PATCH  /api/admin/config         → updates any subset of keys
 *    POST   /api/admin/config/group-play-reset  → resets ONLY the 24 group_play keys
 *
 *  Filtered to just the `category === 'Group Play'` slice from the
 *  grouped response. Mirrors the existing AdminConfigPanel UI shape
 *  (icon + grid of inputs + "saved" feedback) but English-only since
 *  the Group Play labels in admin-group-config.ts are English.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Save, RefreshCw, Check, Snowflake, Users, Clock, DollarSign, Shield, Zap, Tag, Lock } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';

const API = process.env.NEXT_PUBLIC_API_URL || '';

interface ConfigItem {
  key: string;
  value: unknown;
  defaultValue: unknown;
  isModified: boolean;
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'string';
  category: string;
}

const CATEGORY_ICONS: Record<string, any> = {
  'Master toggles': Snowflake,
  'Member caps': Users,
  'Stake caps': DollarSign,
  'Timing': Clock,
  'Distribution & turn defaults': Settings,
  'House edge': Shield,
  'Invites & bonuses': Tag,
  'Feature flags': Lock,
};

const SECTION_ORDER = [
  'Master toggles',
  'Member caps',
  'Stake caps',
  'Timing',
  'Distribution & turn defaults',
  'House edge',
  'Invites & bonuses',
  'Feature flags',
];

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

export default function AdminGroupConfig() {
  const toast = useToast();
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // ── Load on mount ──
  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/admin/config`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      // The /admin/config endpoint returns `configWithMeta: { [category]: ConfigItem[] }`
      const grouped = (j.configWithMeta || {}) as Record<string, ConfigItem[]>;
      const groupPlay = grouped['Group Play'] || [];
      setItems(groupPlay);
    } catch (e: any) {
      toast.addToast(e?.message || 'Failed to load group config', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // ── Group items by description-derived section ──
  // The labels don't carry a "section" field, so we group by the description prefix
  // (the first noun in the description). Simpler: group by unit for numeric items, by
  // the "type" for booleans. We use the unique label-keyword bucket approach.
  const grouped = useMemo(() => {
    // Match each item to a section based on key prefix
    const buckets: Record<string, ConfigItem[]> = {};
    for (const item of items) {
      let section = 'Other';
      if (item.key.includes('AllowedCountries') || item.key.includes('BlockedCountries') || item.key === 'groupPlayEnabled') section = 'Master toggles';
      else if (item.key.includes('MaxMembers') || item.key.includes('MinMembers')) section = 'Member caps';
      else if (item.key.includes('Contribution') || item.key.includes('PoolCap')) section = 'Stake caps';
      else if (item.key.includes('Expiry') || item.key.includes('Countdown')) section = 'Timing';
      else if (item.key.includes('PayoutDistribution') || item.key.includes('TurnDecision') || item.key.includes('FounderShare')) section = 'Distribution & turn defaults';
      else if (item.key.includes('HouseEdge') || item.key.includes('HouseEdgeSpread')) section = 'House edge';
      else if (item.key.includes('Bonus') || item.key.includes('Invite')) section = 'Invites & bonuses';
      else if (item.key.includes('Spectator') || item.key.includes('PrivateAllowed')) section = 'Feature flags';
      if (!buckets[section]) buckets[section] = [];
      buckets[section].push(item);
    }
    // Order per SECTION_ORDER; append "Other" at the end
    const ordered: Record<string, ConfigItem[]> = {};
    for (const s of SECTION_ORDER) {
      if (buckets[s]) ordered[s] = buckets[s];
    }
    if (buckets['Other']) ordered['Other'] = buckets['Other'];
    return ordered;
  }, [items]);

  // ── Save a single key ──
  const handleSave = useCallback(async (key: string, value: unknown) => {
    setSaving(key);
    try {
      const r = await fetch(`${API}/admin/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ [key]: value }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      // Optimistic update — flip the isModified flag in local state
      setItems(prev => prev.map(it => it.key === key ? { ...it, value, isModified: value !== it.defaultValue } : it));
      setSaved(key);
      setTimeout(() => setSaved(null), 1500);
    } catch (e: any) {
      toast.addToast(`Save failed: ${e?.message}`, 'error');
    } finally {
      setSaving(null);
    }
  }, [toast]);

  // ── Reset ONLY the group_play keys (24) ──
  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset ALL 24 Group Play settings to defaults?')) return;
    try {
      const r = await fetch(`${API}/admin/config/group-play-reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      toast.addToast('Group Play settings reset', 'success');
      fetchConfig();
    } catch (e: any) {
      toast.addToast(`Reset failed: ${e?.message}`, 'error');
    }
  }, [toast, fetchConfig]);

  // ── Per-item renderer ──
  const renderItem = (item: ConfigItem) => {
    const Icon = item.type === 'boolean' ? Lock : item.type === 'string' ? Tag : Zap;
    const isSaving = saving === item.key;
    const isSaved = saved === item.key;
    const isModified = item.isModified;

    return (
      <div key={item.key} className="border border-border rounded-lg p-3 bg-surface/40 flex items-start gap-3">
        <Icon size={16} className="text-text-muted mt-1 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-text-primary font-mono text-sm">{item.label}</span>
            {isModified && <span className="text-[10px] uppercase tracking-widest text-amber-400">modified</span>}
            {isSaved && <Check size={12} className="text-brand-green" />}
          </div>
          <div className="text-text-muted text-[10px] font-mono mt-0.5">{item.key}</div>
          <div className="text-text-muted text-xs mt-1">{item.description}</div>
          <div className="mt-2 flex items-center gap-2">
            {item.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-sm font-mono cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(item.value)}
                  onChange={(e) => handleSave(item.key, e.target.checked)}
                  className="accent-brand-green"
                  disabled={isSaving}
                />
                <span className="text-text-secondary">{item.value ? 'true' : 'false'}</span>
              </label>
            ) : item.type === 'string' ? (
              <input
                type="text"
                value={String(item.value ?? '')}
                onChange={(e) => {
                  // Local-only update; commit onBlur
                  setItems(prev => prev.map(it => it.key === item.key ? { ...it, value: e.target.value } : it));
                }}
                onBlur={(e) => {
                  if (e.target.value !== String(item.defaultValue ?? '')) {
                    handleSave(item.key, e.target.value);
                  }
                }}
                className="flex-1 bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
                disabled={isSaving}
              />
            ) : (
              <>
                <input
                  type="number"
                  value={typeof item.value === 'number' ? item.value : parseFloat(String(item.value)) || 0}
                  min={item.min}
                  max={item.max}
                  step={item.unit === '$' || item.unit === 'coins' || item.unit === 'USD' ? 0.01 : 1}
                  onChange={(e) => {
                    setItems(prev => prev.map(it => it.key === item.key ? { ...it, value: parseFloat(e.target.value) || 0 } : it));
                  }}
                  onBlur={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!isNaN(n) && n !== (typeof item.defaultValue === 'number' ? item.defaultValue : parseFloat(String(item.defaultValue)))) {
                      handleSave(item.key, n);
                    }
                  }}
                  className="w-32 bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
                  disabled={isSaving}
                />
                {item.unit && <span className="text-text-muted text-xs font-mono">{item.unit}</span>}
                {(item.min !== undefined || item.max !== undefined) && (
                  <span className="text-text-muted text-[10px] font-mono">
                    [{item.min ?? '-∞'}, {item.max ?? '+∞'}]
                  </span>
                )}
              </>
            )}
            {isSaving && <RefreshCw size={12} className="text-text-muted animate-spin" />}
          </div>
        </div>
      </div>
    );
  };

  const totalItems = items.length;
  const modifiedCount = items.filter(i => i.isModified).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <Settings size={20} className="text-brand-green" />
          Group Play Settings
          <span className="text-[10px] uppercase tracking-widest font-mono text-text-muted">
            ({totalItems} total, {modifiedCount} modified)
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchConfig}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-brand-green/40 disabled:opacity-50 transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 disabled:opacity-50 transition"
          >
            <Save size={14} />
            Reset to defaults
          </button>
        </div>
      </div>

      {loading && items.length === 0 && (
        <div className="text-text-muted font-mono text-sm">Loading…</div>
      )}

      {/* Sections */}
      {Object.entries(grouped).map(([section, sectionItems]) => {
        const SectionIcon = CATEGORY_ICONS[section] || Settings;
        return (
          <div key={section} className="glass-card p-4 space-y-2">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <SectionIcon size={14} className="text-brand-info" />
              {section}
              <span className="text-[10px] uppercase tracking-widest text-text-muted font-mono">
                ({sectionItems.length} setting{sectionItems.length === 1 ? '' : 's'})
              </span>
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {sectionItems.map(renderItem)}
            </div>
          </div>
        );
      })}

      {items.length === 0 && !loading && (
        <div className="glass-card p-4 text-text-muted text-sm font-mono text-center">
          No group_play settings found. Run migration-group-play-config.sql.
        </div>
      )}
    </div>
  );
}