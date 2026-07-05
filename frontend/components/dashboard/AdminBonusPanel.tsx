'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN BONUS PANEL — Manage bonus campaigns & user grants
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import { useGameStore } from '@/lib/store';
import { Gift, Plus, Edit2, Trash2, Users, TrendingUp, CheckCircle, AlertCircle, Search, X, Save } from 'lucide-react';
import { api } from '@/lib/api';

const BONUS_TYPES = [
  'welcome', 'deposit_match', 'cashback', 'free_spin', 'reload',
  'vip_tier', 'tournament', 'loss_back', 'manual', 'affiliate_reward', 'rain',
];

const TYPE_LABELS: Record<string, string> = {
  welcome: 'Welcome',
  deposit_match: 'Deposit Match',
  cashback: 'Cashback',
  free_spin: 'Free Spin',
  reload: 'Reload',
  vip_tier: 'VIP Tier',
  tournament: 'Tournament',
  loss_back: 'Loss Back',
  manual: 'Manual / User-specific',
  affiliate_reward: 'Affiliate Reward',
  rain: 'Rain',
};

interface Campaign {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  bonus_type: string;
  amount_coins: number | null;
  percent: number | null;
  max_amount_coins: number | null;
  free_spin_count: number | null;
  free_spin_value_coins: number | null;
  wagering_multiplier: number;
  max_withdrawal_multiplier: number;
  max_withdrawal_coins: number | null;
  min_deposit_to_withdraw_pct: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  claim_window_hours: number | null;
  expires_after_hours: number;
  max_claims_total: number;
  max_claims_per_user: number;
  total_budget_coins: number | null;
  requires_opt_in: boolean;
  auto_grant_on_event: string | null;
  claims_count: number;
  total_paid_coins: number;
  created_at: string;
}

interface CampaignStats {
  totalCampaigns: number;
  activeCampaigns: number;
  totalPaidCoins: number;
  totalClaims: number;
  byType: Array<{ bonus_type: string; count: number; paid: number }>;
}

interface UserBrief {
  id: string;
  username: string;
  email: string | null;
  balance: number;
}

const now = new Date();
const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const toDatetimeLocal = (d: Date) => d.toISOString().slice(0, 16);

const EMPTY_FORM = {
  code: '',
  name: '',
  description: '',
  bonus_type: 'welcome',
  amount_coins: '',
  percent: '',
  max_amount_coins: '',
  free_spin_count: '',
  free_spin_value_coins: '',
  wagering_multiplier: '30',
  max_withdrawal_multiplier: '10',
  max_withdrawal_coins: '',
  min_deposit_to_withdraw_pct: '0',
  is_active: true,
  starts_at: toDatetimeLocal(now),
  ends_at: toDatetimeLocal(thirtyDaysLater),
  claim_window_hours: '72',
  expires_after_hours: '168',
  max_claims_total: '0',
  max_claims_per_user: '1',
  total_budget_coins: '',
  requires_opt_in: true,
  auto_grant_on_event: '',
};

export default function AdminBonusPanel() {
  const token = useGameStore((s) => s.token);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantCampaign, setGrantCampaign] = useState<Campaign | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [foundUsers, setFoundUsers] = useState<UserBrief[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [grantAmount, setGrantAmount] = useState('');
  const [grantNote, setGrantNote] = useState('');

  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [cRes, sRes] = await Promise.all([
        api.get('/admin/bonus-campaigns', token),
        api.get('/admin/bonus-campaigns/stats/summary', token),
      ]);
      if (cRes.success) setCampaigns(cRes.campaigns || []);
      if (sRes.success) setStats(sRes.stats || null);
    } catch (err) {
      setNotice({ message: 'Failed to load bonus campaigns', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toForm = (c?: Campaign) => ({
    code: c?.code ?? '',
    name: c?.name ?? '',
    description: c?.description ?? '',
    bonus_type: c?.bonus_type ?? 'welcome',
    amount_coins: c?.amount_coins?.toString() ?? '',
    percent: c?.percent?.toString() ?? '',
    max_amount_coins: c?.max_amount_coins?.toString() ?? '',
    free_spin_count: c?.free_spin_count?.toString() ?? '',
    free_spin_value_coins: c?.free_spin_value_coins?.toString() ?? '',
    wagering_multiplier: c?.wagering_multiplier?.toString() ?? '30',
    max_withdrawal_multiplier: c?.max_withdrawal_multiplier?.toString() ?? '10',
    max_withdrawal_coins: c?.max_withdrawal_coins?.toString() ?? '',
    min_deposit_to_withdraw_pct: c?.min_deposit_to_withdraw_pct?.toString() ?? '0',
    is_active: c?.is_active ?? true,
    starts_at: c?.starts_at ? new Date(c.starts_at).toISOString().slice(0, 16) : '',
    ends_at: c?.ends_at ? new Date(c.ends_at).toISOString().slice(0, 16) : '',
    claim_window_hours: c?.claim_window_hours?.toString() ?? '72',
    expires_after_hours: c?.expires_after_hours?.toString() ?? '168',
    max_claims_total: c?.max_claims_total?.toString() ?? '0',
    max_claims_per_user: c?.max_claims_per_user?.toString() ?? '1',
    total_budget_coins: c?.total_budget_coins?.toString() ?? '',
    requires_opt_in: c?.requires_opt_in ?? true,
    auto_grant_on_event: c?.auto_grant_on_event ?? '',
  });

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (c: Campaign) => {
    setEditing(c);
    setForm(toForm(c));
    setFormOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    console.log('submitting form', form);
    const payload = {
      ...form,
      amount_coins: form.amount_coins ? parseFloat(form.amount_coins) : null,
      percent: form.percent ? parseFloat(form.percent) : null,
      max_amount_coins: form.max_amount_coins ? parseFloat(form.max_amount_coins) : null,
      free_spin_count: form.free_spin_count ? parseInt(form.free_spin_count) : null,
      free_spin_value_coins: form.free_spin_value_coins ? parseFloat(form.free_spin_value_coins) : null,
      wagering_multiplier: parseFloat(form.wagering_multiplier),
      max_withdrawal_multiplier: parseFloat(form.max_withdrawal_multiplier),
      max_withdrawal_coins: form.max_withdrawal_coins ? parseFloat(form.max_withdrawal_coins) : null,
      min_deposit_to_withdraw_pct: parseFloat(form.min_deposit_to_withdraw_pct),
      claim_window_hours: form.claim_window_hours ? parseInt(form.claim_window_hours) : null,
      expires_after_hours: parseInt(form.expires_after_hours),
      max_claims_total: parseInt(form.max_claims_total),
      max_claims_per_user: parseInt(form.max_claims_per_user),
      total_budget_coins: form.total_budget_coins ? parseFloat(form.total_budget_coins) : null,
      auto_grant_on_event: form.auto_grant_on_event || null,
      starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : new Date().toISOString(),
      ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
    };
    try {
      const res = editing
        ? await api.patch(`/admin/bonus-campaigns/${editing.id}`, token, payload)
        : await api.post('/admin/bonus-campaigns', token, payload);
      if (res.success) {
        setNotice({ message: editing ? 'Campaign updated' : 'Campaign created', type: 'success' });
        setFormOpen(false);
        await fetchData();
      } else {
        setNotice({ message: res.error || 'Save failed', type: 'error' });
      }
    } catch (err) {
      setNotice({ message: 'Network error', type: 'error' });
    }
  };

  const remove = async (id: string) => {
    if (!token || !confirm('Delete this campaign?')) return;
    const res = await api.delete(`/admin/bonus-campaigns/${id}`, token);
    if (res.success) {
      setNotice({ message: 'Campaign deleted', type: 'success' });
      await fetchData();
    } else {
      setNotice({ message: res.error || 'Delete failed', type: 'error' });
    }
  };

  const searchUsers = async () => {
    if (!token || userSearch.length < 2) return;
    try {
      const res = await api.get(`/admin/users/search?q=${encodeURIComponent(userSearch)}`, token);
      if (res.success) setFoundUsers(res.users || []);
    } catch (err) {
      setNotice({ message: 'User search failed', type: 'error' });
    }
  };

  const grant = async () => {
    if (!token || !grantCampaign || selectedUsers.length === 0) return;
    try {
      const res = await api.post(`/admin/bonus-campaigns/${grantCampaign.id}/grant`, token, {
        userIds: selectedUsers,
        amount: grantAmount ? parseFloat(grantAmount) : undefined,
        note: grantNote,
      });
      if (res.success) {
        setNotice({ message: `Granted bonus to ${res.grantedCount} user(s)`, type: 'success' });
        setGrantOpen(false);
        setSelectedUsers([]);
        setGrantAmount('');
        setGrantNote('');
        await fetchData();
      } else {
        setNotice({ message: res.error || 'Grant failed', type: 'error' });
      }
    } catch (err) {
      setNotice({ message: 'Network error', type: 'error' });
    }
  };

  const input = (label: string, key: keyof typeof form, type = 'text', required = false) => (
    <label className="block">
      <span className="text-text-secondary text-xs font-mono">{label}</span>
      <input
        type={type}
        required={required}
        value={form[key] as string}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-brand-gold focus:outline-none"
      />
    </label>
  );

  const toggle = (label: string, key: keyof typeof form) => (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={!!form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
        className="accent-brand-gold"
      />
      <span className="text-text-secondary text-xs font-mono">{label}</span>
    </label>
  );

  return (
    <div className="space-y-6">
      {notice && (
        <div className={`p-3 rounded-xl text-xs font-mono border flex items-center gap-2 mb-4 ${notice.type === 'success' ? 'bg-brand-green/10 text-brand-green border-brand-green/20' : 'bg-brand-red/10 text-brand-red border-brand-red/20'}`}>
          <AlertCircle size={14} />
          {notice.message}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Campaigns', value: stats?.totalCampaigns ?? 0, Icon: Gift },
          { label: 'Active', value: stats?.activeCampaigns ?? 0, Icon: CheckCircle },
          { label: 'Total Claims', value: stats?.totalClaims ?? 0, Icon: Users },
          { label: 'Paid Out', value: `$${(stats?.totalPaidCoins ?? 0).toFixed(2)}`, Icon: TrendingUp },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-text-muted mb-1">
              <Icon size={14} />
              <span className="text-xs font-mono">{label}</span>
            </div>
            <div className="text-2xl font-bold text-text-primary">{value}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex justify-between items-center">
        <h2 className="heading-display text-lg text-text-primary">Bonus Campaigns</h2>
        <button
          onClick={openNew}
          className="flex items-center gap-2 px-4 py-2 bg-brand-maroon hover:bg-brand-maroon/90 text-white rounded-lg text-sm font-medium transition"
        >
          <Plus size={16} /> New Campaign
        </button>
      </div>

      {loading && <p className="text-text-muted text-sm font-mono">Loading...</p>}

      {/* Campaigns grid */}
      <div className="grid md:grid-cols-2 gap-4">
        {campaigns.map((c) => (
          <div key={c.id} className={`bg-surface border rounded-xl p-4 ${c.is_active ? 'border-border' : 'border-brand-red/30 opacity-70'}`}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-brand-gold/10 text-brand-gold">{TYPE_LABELS[c.bonus_type]}</span>
                  {!c.is_active && <span className="text-xs font-mono px-2 py-0.5 rounded bg-brand-red/10 text-brand-red">Inactive</span>}
                </div>
                <h3 className="text-text-primary font-semibold mt-1">{c.name}</h3>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-brand-gold/10 rounded text-brand-gold"><Edit2 size={14} /></button>
                <button onClick={() => remove(c.id)} className="p-1.5 hover:bg-brand-red/10 rounded text-brand-red"><Trash2 size={14} /></button>
              </div>
            </div>
            <p className="text-text-muted text-xs mb-3 line-clamp-2">{c.description || 'No description'}</p>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono text-text-secondary mb-3">
              <div>Amount: ${c.amount_coins ?? 0}</div>
              <div>Wager: {c.wagering_multiplier}x</div>
              <div>Claims: {c.claims_count}/{c.max_claims_total || '∞'}</div>
              <div>Paid: ${c.total_paid_coins.toFixed(2)}</div>
            </div>
            <button
              onClick={() => { setGrantCampaign(c); setGrantOpen(true); }}
              className="w-full py-1.5 border border-brand-gold/30 text-brand-gold text-xs font-mono rounded hover:bg-brand-gold/10 transition"
            >
              Grant to user(s)
            </button>
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-50 bg-void/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="heading-display text-lg text-text-primary">{editing ? 'Edit Campaign' : 'New Campaign'}</h3>
              <button onClick={() => setFormOpen(false)}><X size={18} className="text-text-muted" /></button>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                {input('Name', 'name', 'text', true)}
                {input('Code', 'code')}
              </div>
              <label className="block">
                <span className="text-text-secondary text-xs font-mono">Description</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-brand-gold focus:outline-none"
                  rows={2}
                />
              </label>
              <div className="grid md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-text-secondary text-xs font-mono">Bonus Type</span>
                  <select
                    value={form.bonus_type}
                    onChange={(e) => setForm((f) => ({ ...f, bonus_type: e.target.value }))}
                    className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-brand-gold focus:outline-none"
                  >
                    {BONUS_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </label>
                {input('Amount ($)', 'amount_coins', 'number')}
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                {input('Percent (%)', 'percent', 'number')}
                {input('Max Amount ($)', 'max_amount_coins', 'number')}
                {input('Total Budget ($)', 'total_budget_coins', 'number')}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {input('Free Spin Count', 'free_spin_count', 'number')}
                {input('Free Spin Value ($)', 'free_spin_value_coins', 'number')}
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                {input('Wagering Multiplier', 'wagering_multiplier', 'number')}
                {input('Max Withdrawal Multiplier', 'max_withdrawal_multiplier', 'number')}
                {input('Max Withdrawal ($)', 'max_withdrawal_coins', 'number')}
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                {input('Min Deposit to Withdraw %', 'min_deposit_to_withdraw_pct', 'number')}
                {input('Claim Window (hrs)', 'claim_window_hours', 'number')}
                {input('Expires After (hrs)', 'expires_after_hours', 'number')}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {input('Starts At', 'starts_at', 'datetime-local')}
                {input('Ends At', 'ends_at', 'datetime-local')}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {input('Max Claims Total (0=∞)', 'max_claims_total', 'number')}
                {input('Max Claims Per User', 'max_claims_per_user', 'number')}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-text-secondary text-xs font-mono">Auto-grant on Event</span>
                  <select
                    value={form.auto_grant_on_event}
                    onChange={(e) => setForm((f) => ({ ...f, auto_grant_on_event: e.target.value }))}
                    className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-brand-gold focus:outline-none"
                  >
                    <option value="">None</option>
                    <option value="signup">Signup</option>
                    <option value="deposit">Deposit</option>
                    <option value="rain">Rain</option>
                    <option value="vip_tier">VIP Tier</option>
                  </select>
                </label>
              </div>
              <div className="flex gap-4">
                {toggle('Active', 'is_active')}
                {toggle('Requires Opt-in', 'requires_opt_in')}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 border border-border rounded-lg text-sm text-text-muted hover:bg-surface">Cancel</button>
                <button type="submit" className="flex items-center gap-2 px-4 py-2 bg-brand-gold text-black rounded-lg text-sm font-medium hover:bg-brand-gold/90">
                  <Save size={14} /> Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Grant Modal */}
      {grantOpen && grantCampaign && (
        <div className="fixed inset-0 z-50 bg-void/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="heading-display text-lg text-text-primary">Grant: {grantCampaign.name}</h3>
              <button onClick={() => setGrantOpen(false)}><X size={18} className="text-text-muted" /></button>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search username..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && searchUsers()}
                  className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
                />
                <button onClick={searchUsers} className="p-2 bg-brand-maroon text-white rounded-lg"><Search size={16} /></button>
              </div>
              {foundUsers.length > 0 && (
                <div className="max-h-40 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                  {foundUsers.map((u) => (
                    <label key={u.id} className="flex items-center gap-2 p-2 cursor-pointer hover:bg-surface/50">
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(u.id)}
                        onChange={(e) => {
                          setSelectedUsers((prev) => e.target.checked
                            ? [...prev, u.id]
                            : prev.filter((id) => id !== u.id));
                        }}
                        className="accent-brand-gold"
                      />
                      <span className="text-sm text-text-primary">{u.username}</span>
                      <span className="text-xs text-text-muted ml-auto">${u.balance.toFixed(2)}</span>
                    </label>
                  ))}
                </div>
              )}
              <label className="block">
                <span className="text-text-secondary text-xs font-mono">Override Amount (optional)</span>
                <input
                  type="number"
                  value={grantAmount}
                  onChange={(e) => setGrantAmount(e.target.value)}
                  className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
                />
              </label>
              <label className="block">
                <span className="text-text-secondary text-xs font-mono">Note</span>
                <input
                  type="text"
                  value={grantNote}
                  onChange={(e) => setGrantNote(e.target.value)}
                  className="mt-1 w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button onClick={() => setGrantOpen(false)} className="px-4 py-2 border border-border rounded-lg text-sm text-text-muted">Cancel</button>
                <button onClick={grant} className="px-4 py-2 bg-brand-gold text-black rounded-lg text-sm font-medium">Grant {selectedUsers.length} user(s)</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
