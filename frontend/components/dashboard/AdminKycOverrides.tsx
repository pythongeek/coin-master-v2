'use client';
/**
 * =============================================================
 *  ADMIN KYC OVERRIDES - 4-tab admin UI for P3
 * =============================================================
 *  Tabs:
 *    1. Settings - tier thresholds, sanctioned list, expiry policy
 *    2. Overrides - grant/revoke per-user deposit KYC overrides
 *    3. Self-Exclusions - list, reverse, extend
 *    4. Audit Log - full audit trail of all admin actions
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Shield, AlertTriangle, Users, History, Save, Trash2, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Loader2, Clock,
} from 'lucide-react';
import {
  getKycConfig, listKycOverrides, listKycAudit, listSelfExclusions,
  getKycDepositStats,
  type KycConfig, type KycOverride, type KycAuditEntry, type SelfExclusion,
} from '@/lib/api/wallet';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

type Tab = 'settings' | 'overrides' | 'self_exclusions' | 'audit';

const TIER_LABELS: Record<number, string> = { 0: 'Tier 0 (Unverified)', 1: 'Tier 1 (Basic)', 2: 'Tier 2 (Intermediate)', 3: 'Tier 3 (Full)' };

export default function AdminKyc() {
  const [tab, setTab] = useState<Tab>('settings');
  const [config, setConfig] = useState<KycConfig | null>(null);
  const [overrides, setOverrides] = useState<KycOverride[]>([]);
  const [exclusions, setExclusions] = useState<SelfExclusion[]>([]);
  const [audit, setAudit] = useState<KycAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const token = getToken();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await getKycConfig(token);
      setConfig(c.config);
      const o = await listKycOverrides(token, { limit: 50 });
      setOverrides(o.overrides);
      const e = await listSelfExclusions(token, 'active');
      setExclusions(e.exclusions);
      const a = await listKycAudit(token, { limit: 50 });
      setAudit(a.entries);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function flash(type: 'ok' | 'err', msg: string) {
    setNotice({ type, msg });
    setTimeout(() => setNotice(null), 4000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <Shield size={20} className="text-brand-green" />
          KYC Management
        </h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-2 rounded bg-bg-elevated hover:bg-bg-elevated/70 disabled:opacity-50"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      {notice && (
        <div className={`p-3 rounded flex items-start gap-2 ${
          notice.type === 'ok' ? 'bg-brand-green/10 border border-brand-green/30' : 'bg-red-500/10 border border-red-500/30'
        }`}>
          {notice.type === 'ok' ? (
            <CheckCircle2 size={16} className="text-brand-green flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
          )}
          <span className={`text-sm ${notice.type === 'ok' ? 'text-brand-green' : 'text-red-300'}`}>
            {notice.msg}
          </span>
        </div>
      )}

      {/* Tab nav */}
      <div className="flex gap-2 border-b border-border">
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Shield size={14} />}>Settings</TabButton>
        <TabButton active={tab === 'overrides'} onClick={() => setTab('overrides')} icon={<Users size={14} />}>
          Overrides <CountBadge n={overrides.length} />
        </TabButton>
        <TabButton active={tab === 'self_exclusions'} onClick={() => setTab('self_exclusions')} icon={<AlertTriangle size={14} />}>
          Self-Exclusions <CountBadge n={exclusions.length} />
        </TabButton>
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')} icon={<History size={14} />}>Audit</TabButton>
      </div>

      {loading && !config && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-text-muted" size={28} />
        </div>
      )}

      {tab === 'settings' && config && <SettingsTab config={config} token={token} onUpdate={load} flash={flash} />}
      {tab === 'overrides' && <OverridesTab overrides={overrides} token={token} onUpdate={load} flash={flash} />}
      {tab === 'self_exclusions' && <SelfExclusionsTab exclusions={exclusions} token={token} onUpdate={load} flash={flash} />}
      {tab === 'audit' && <AuditTab entries={audit} token={token} flash={flash} />}
    </div>
  );
}

function TabButton({ children, active, onClick, icon }: {
  children: React.ReactNode; active: boolean; onClick: () => void; icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 font-mono text-sm flex items-center gap-2 border-b-2 transition ${
        active
          ? 'border-brand-green text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function CountBadge({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-brand-green/20 text-brand-green">{n}</span>;
}

// =========================================================================
//  Settings tab
// =========================================================================

function SettingsTab({ config, token, onUpdate, flash }: {
  config: KycConfig;
  token: string;
  onUpdate: () => void;
  flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Enforcement mode banner */}
      <div className={`p-3 rounded border flex items-center gap-3 ${
        config.enforcementMode === 'strict'
          ? 'bg-red-500/10 border-red-500/30'
          : config.enforcementMode === 'warn'
          ? 'bg-amber-500/10 border-amber-500/30'
          : 'bg-bg-elevated/30 border-border'
      }`}>
        <Clock size={18} className={config.enforcementMode === 'strict' ? 'text-red-400' : config.enforcementMode === 'warn' ? 'text-amber-400' : 'text-text-muted'} />
        <div className="flex-1">
          <div className="text-text-primary font-mono text-sm font-bold">
            Enforcement mode: <span className="uppercase">{config.enforcementMode}</span>
          </div>
          <div className="text-text-muted text-[10px] font-mono">
            {config.enforcementMode === 'warn' && config.strictAfter && `Auto-flips to STRICT on ${config.strictAfter}`}
            {config.enforcementMode === 'off' && 'All deposit KYC checks are advisory only'}
            {config.enforcementMode === 'strict' && 'All tier checks block hard'}
          </div>
        </div>
        <select
          value={config.enforcementMode}
          onChange={async (e) => {
            try {
              const r = await fetch('/api/admin/kyc/thresholds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ enforcementMode: e.target.value, reason: 'Updated via admin UI' }),
              });
              const data = await r.json();
              if (data.success) { flash('ok', `Enforcement mode: ${e.target.value}`); onUpdate(); }
              else flash('err', data.error || 'Failed');
            } catch (err: unknown) { flash('err', (err as Error).message); }
          }}
          className="bg-bg-base border border-border rounded px-2 py-1 font-mono text-xs"
        >
          <option value="off">off</option>
          <option value="warn">warn</option>
          <option value="strict">strict</option>
        </select>
      </div>

      {/* Tier thresholds */}
      <Card title="Tier Thresholds" subtitle="Per-tier max single-tx + daily cumulative deposits (USDT)">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((t) => (
            <TierCard
              key={t}
              tier={t}
              maxPerTx={config.thresholds[`tier${t}` as 'tier0' | 'tier1' | 'tier2' | 'tier3'].maxPerTx}
              maxDaily={config.thresholds[`tier${t}` as 'tier0' | 'tier1' | 'tier2' | 'tier3'].maxDaily}
              token={token}
              onUpdate={onUpdate}
              flash={flash}
            />
          ))}
        </div>
      </Card>

      {/* Sanctioned countries */}
      <SanctionedCard config={config} token={token} onUpdate={onUpdate} flash={flash} />

      {/* KYC expiry policy */}
      <ExpiryCard config={config} token={token} onUpdate={onUpdate} flash={flash} />
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="glass-card p-4 rounded-xl">
      <h3 className="text-text-primary font-mono text-base font-bold mb-1">{title}</h3>
      {subtitle && <p className="text-text-muted text-xs font-mono mb-3">{subtitle}</p>}
      {children}
    </div>
  );
}

function TierCard({ tier, maxPerTx, maxDaily, token, onUpdate, flash }: {
  tier: number; maxPerTx: number; maxDaily: number;
  token: string; onUpdate: () => void; flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  const [perTx, setPerTx] = useState(maxPerTx.toString());
  const [daily, setDaily] = useState(maxDaily.toString());
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch('/api/admin/kyc/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          tier,
          maxPerTx: parseFloat(perTx),
          maxDaily: parseFloat(daily),
          reason: `Tier ${tier} limits updated via admin UI`,
        }),
      });
      const data = await r.json();
      if (data.success) { flash('ok', `${TIER_LABELS[tier]} updated`); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
    setSaving(false);
  }

  return (
    <div className="bg-bg-elevated/50 border border-border rounded-lg p-3 space-y-2">
      <div className="text-text-primary font-mono text-sm font-bold">{TIER_LABELS[tier]}</div>
      <label className="block">
        <span className="text-[10px] text-text-muted font-mono">Max single-tx (USDT)</span>
        <input
          type="number"
          value={perTx}
          onChange={(e) => setPerTx(e.target.value)}
          className="w-full mt-1 px-2 py-1 bg-bg-base border border-border rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
        />
      </label>
      <label className="block">
        <span className="text-[10px] text-text-muted font-mono">Max daily cumulative (USDT)</span>
        <input
          type="number"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          className="w-full mt-1 px-2 py-1 bg-bg-base border border-border rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-brand-green/20 text-brand-green rounded text-xs font-mono hover:bg-brand-green/30 disabled:opacity-50"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
        Save
      </button>
    </div>
  );
}

function SanctionedCard({ config, token, onUpdate, flash }: {
  config: KycConfig;
  token: string;
  onUpdate: () => void;
  flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  const [newCountry, setNewCountry] = useState('');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);

  async function update(action: 'add' | 'remove', country: string, r?: string) {
    if (!country || country.length !== 2) {
      flash('err', 'Country must be 2-letter ISO code');
      return;
    }
    const reasonText = r || reason;
    if (!reasonText || reasonText.length < 10) {
      flash('err', 'Reason required (min 10 chars) for audit');
      return;
    }
    setWorking(true);
    try {
      const res = await fetch('/api/admin/kyc/sanctioned-countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action, country: country.toUpperCase(), reason: reasonText }),
      });
      const data = await res.json();
      if (data.success) { flash('ok', `${country.toUpperCase()} ${action}ed`); setNewCountry(''); setReason(''); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
    setWorking(false);
  }

  return (
    <Card title="Sanctioned Countries" subtitle="ISO codes blocked from deposits. Admin-editable.">
      <div className="flex flex-wrap gap-2 mb-4">
        {config.sanctionedCountries.length === 0 ? (
          <span className="text-text-muted text-xs font-mono">No countries sanctioned.</span>
        ) : (
          config.sanctionedCountries.map((c) => (
            <div key={c} className="flex items-center gap-1.5 px-2.5 py-1 bg-red-500/15 border border-red-500/40 rounded text-xs font-mono text-red-300">
              <span className="font-bold">{c}</span>
              <button
                type="button"
                onClick={() => {
                  const r = prompt('Reason for removing ' + c + ' from sanctioned list?');
                  if (r) update('remove', c, r);
                }}
                className="text-red-400 hover:text-red-200"
                title="Remove from sanctioned list"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          maxLength={2}
          value={newCountry}
          onChange={(e) => setNewCountry(e.target.value.toUpperCase())}
          placeholder="XX"
          className="w-20 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green uppercase"
        />
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (min 10 chars)"
          className="flex-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
        />
        <button
          type="button"
          onClick={() => update('add', newCountry)}
          disabled={working}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-red-500/20 text-red-300 rounded text-xs font-mono hover:bg-red-500/30 disabled:opacity-50"
        >
          {working ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add
        </button>
      </div>
    </Card>
  );
}

function ExpiryCard({ config, token, onUpdate, flash }: {
  config: KycConfig;
  token: string;
  onUpdate: () => void;
  flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  const [enabled, setEnabled] = useState(config.expiryPolicy.enabled);
  const [autoAction, setAutoAction] = useState(config.expiryPolicy.autoAction);
  const [graceDays, setGraceDays] = useState(config.expiryPolicy.graceDays.toString());
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch('/api/admin/kyc/expiry-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          enabled,
          autoAction,
          graceDays: parseInt(graceDays),
          reason: 'Expiry policy updated via admin UI',
        }),
      });
      const data = await r.json();
      if (data.success) { flash('ok', 'Expiry policy updated'); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
    setSaving(false);
  }

  return (
    <Card title="KYC Expiry Policy" subtitle="When KYC ages out, what happens?">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <label className="block">
          <span className="text-[10px] text-text-muted font-mono">Enabled</span>
          <select
            value={enabled ? 'true' : 'false'}
            onChange={(e) => setEnabled(e.target.value === 'true')}
            className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary"
          >
            <option value="false">false (no expiry)</option>
            <option value="true">true (apply policy)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] text-text-muted font-mono">Auto action when expired</span>
          <select
            value={autoAction}
            onChange={(e) => setAutoAction(e.target.value as typeof autoAction)}
            className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary"
          >
            <option value="warn_only">warn_only (no downgrade)</option>
            <option value="downgrade_to_tier0">downgrade_to_tier0</option>
            <option value="downgrade_to_tier1">downgrade_to_tier1</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] text-text-muted font-mono">Grace days</span>
          <input
            type="number"
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            className="w-full mt-1 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-green/20 text-brand-green rounded text-xs font-mono hover:bg-brand-green/30 disabled:opacity-50"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
        Save
      </button>
    </Card>
  );
}

// =========================================================================
//  Overrides tab
// =========================================================================

function OverridesTab({ overrides, token, onUpdate, flash }: {
  overrides: KycOverride[];
  token: string;
  onUpdate: () => void;
  flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  const [userId, setUserId] = useState('');
  const [days, setDays] = useState('30');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);

  async function grant() {
    if (!userId) { flash('err', 'User ID required'); return; }
    if (!reason || reason.length < 10) { flash('err', 'Reason required (min 10 chars)'); return; }
    setWorking(true);
    try {
      const r = await fetch('/api/admin/kyc/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          userId,
          grantedDays: parseInt(days),
          reason,
        }),
      });
      const data = await r.json();
      if (data.success) { flash('ok', `Override granted for ${days} days`); setUserId(''); setReason(''); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
    setWorking(false);
  }

  async function revoke(uid: string) {
    const r = prompt(`Reason for revoking override on user ${uid}?`);
    if (!r) return;
    try {
      const res = await fetch(`/api/admin/kyc/overrides/${uid}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ reason: r }),
      });
      const data = await res.json();
      if (data.success) { flash('ok', 'Override revoked'); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
  }

  return (
    <div className="space-y-4">
      <Card title="Grant New Override" subtitle="Per-user deposit KYC bypass (7/14/30/60 days)">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="User UUID"
            className="px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
          />
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-sm text-text-primary"
          >
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
          </select>
          <button
            type="button"
            onClick={grant}
            disabled={working}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-brand-green/20 text-brand-green rounded text-xs font-mono hover:bg-brand-green/30 disabled:opacity-50"
          >
            {working ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Grant
          </button>
        </div>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (min 10 chars) — e.g., VIP customer KYC in progress"
          className="w-full mt-2 px-2 py-1.5 bg-bg-base border border-border rounded font-mono text-xs text-text-primary focus:outline-none focus:border-brand-green"
        />
      </Card>

      <Card title={`Active Overrides (${overrides.length})`}>
        {overrides.length === 0 ? (
          <p className="text-text-muted text-xs font-mono">No active overrides.</p>
        ) : (
          <div className="space-y-2">
            {overrides.map((o) => (
              <div key={o.user_id} className="p-3 bg-bg-elevated/50 border border-border rounded flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-text-primary font-mono text-sm">
                    {o.username || o.user_id.slice(0, 12)} <span className="text-text-muted">({o.email || '-'})</span>
                  </div>
                  <div className="text-[10px] text-text-muted font-mono truncate">{o.kyc_deposit_override_reason}</div>
                  <div className="text-[10px] text-text-muted font-mono mt-0.5">
                    Tier: {o.kyc_tier || '0'} · Granted by: {o.granted_by_username || '-'} · Expires: {new Date(o.kyc_deposit_override_until).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(o.user_id)}
                  className="p-2 text-red-400 hover:text-red-200 hover:bg-red-500/10 rounded"
                  title="Revoke"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// =========================================================================
//  Self-Exclusions tab
// =========================================================================

function SelfExclusionsTab({ exclusions, token, onUpdate, flash }: {
  exclusions: SelfExclusion[];
  token: string;
  onUpdate: () => void;
  flash: (type: 'ok' | 'err', msg: string) => void;
}) {
  async function reverse(uid: string) {
    const reason = prompt(`Reason for reversing self-exclusion for user ${uid}? (min 20 chars)`);
    if (!reason || reason.length < 20) {
      flash('err', 'Reason required (min 20 chars)');
      return;
    }
    try {
      const r = await fetch('/api/admin/kyc/self-exclusion/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ userId: uid, reason }),
      });
      const data = await r.json();
      if (data.success) { flash('ok', 'Self-exclusion reversed'); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
  }

  async function extend(uid: string) {
    const input = prompt(`Extend self-exclusion for user ${uid}. Enter number of additional days (1-3650):`);
    const days = parseInt(input || '');
    if (!days || days < 1 || days > 3650) {
      flash('err', 'Days must be 1-3650');
      return;
    }
    const reason = prompt('Reason for extending?');
    if (!reason || reason.length < 10) {
      flash('err', 'Reason required (min 10 chars)');
      return;
    }
    try {
      const r = await fetch('/api/admin/kyc/self-exclusion/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ userId: uid, additionalDays: days, reason }),
      });
      const data = await r.json();
      if (data.success) { flash('ok', `Extended by ${days} days`); onUpdate(); }
      else flash('err', data.error || 'Failed');
    } catch (err: unknown) { flash('err', (err as Error).message); }
  }

  return (
    <Card title={`Active Self-Exclusions (${exclusions.length})`} subtitle="Users who cannot deposit or bet until their exclusion date">
      {exclusions.length === 0 ? (
        <p className="text-text-muted text-xs font-mono">No active self-exclusions.</p>
      ) : (
        <div className="space-y-2">
          {exclusions.map((e) => (
            <div key={e.id} className="p-3 bg-bg-elevated/50 border border-border rounded flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-text-primary font-mono text-sm">
                  {e.username} <span className="text-text-muted">({e.email || '-'})</span>
                </div>
                <div className="text-[10px] text-text-muted font-mono mt-0.5">
                  Self-excluded until: {new Date(e.self_excluded_until).toLocaleDateString()} ({e.days_remaining} days left)
                </div>
              </div>
              <button
                type="button"
                onClick={() => extend(e.id)}
                className="flex items-center gap-1 px-2.5 py-1 bg-amber-500/20 text-amber-300 rounded text-[10px] font-mono hover:bg-amber-500/30"
                title="Extend the self-exclusion period"
              >
                <Plus size={10} /> Extend
              </button>
              <button
                type="button"
                onClick={() => reverse(e.id)}
                className="flex items-center gap-1 px-2.5 py-1 bg-red-500/20 text-red-300 rounded text-[10px] font-mono hover:bg-red-500/30"
                title="Reverse the self-exclusion (allow user to deposit again)"
              >
                <Trash2 size={10} /> Reverse
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// =========================================================================
//  Audit tab
// =========================================================================

function AuditTab({ entries }: { entries: KycAuditEntry[]; token: string; flash: (type: 'ok' | 'err', msg: string) => void }) {
  return (
    <Card title={`Audit Log (${entries.length})`} subtitle="All admin actions on KYC config + per-user overrides">
      {entries.length === 0 ? (
        <p className="text-text-muted text-xs font-mono">No audit entries yet.</p>
      ) : (
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {entries.map((e) => (
            <div key={e.id} className="p-2 bg-bg-elevated/30 border border-border rounded text-[10px] font-mono">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-text-primary font-bold">{e.action}</span>
                <span className="text-text-muted">{new Date(e.created_at).toLocaleString()}</span>
              </div>
              <div className="text-text-muted">
                by <span className="text-text-primary">{e.admin_username}</span>
                {e.user_username && <> · user: <span className="text-text-primary">{e.user_username}</span></>}
              </div>
              <div className="text-text-secondary mt-0.5">{e.reason}</div>
              {e.details && Object.keys(e.details).length > 0 && (
                <details className="mt-1">
                  <summary className="text-text-muted cursor-pointer hover:text-text-primary text-[9px]">details</summary>
                  <pre className="mt-1 p-1 bg-bg-base rounded text-[9px] overflow-x-auto">{JSON.stringify(e.details, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}