/**
 * ════════════════════════════════════════════════════════════════
 *  ADMIN GROUPS PANEL — Phase 1 / Day 7
 *  ════════════════════════════════════════════════════════════════
 *
 *  Single dashboard for the new admin-groups endpoints:
 *    GET    /api/admin/groups                  — list (with filters)
 *    GET    /api/admin/groups/:id              — full detail
 *    POST   /api/admin/groups/:id/force-cancel — refunds all members
 *    POST   /api/admin/groups/:id/freeze      — toggles is_frozen
 *    POST   /api/admin/groups/:id/mark-fraud  — force-freeze + fraud_score=100
 *
 *  Surgical scope: pure addition. No changes to the admin sidebar
 *  layout, navigation, or other panels. Mirrors AdminFraudPanel.tsx.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Users, RefreshCw, Search, Snowflake, Trash2, AlertOctagon, ChevronRight, X, Eye, Flag, ChevronLeft, Undo2 } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { useToast } from '@/components/providers/ToastProvider';

interface GroupSummary {
  id: string;
  short_code: string;
  status: string;
  is_frozen: boolean;
  fraud_score: number;
  creator_id: string;
  creator_choice: string;
  total_pool: string | number;
  current_members: number;
  max_members: number;
  payout_mode: string;
  turn_mode: string;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  member_count: number;
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  winnings: number;
  roomsWon: number;
  totalStake: number;
}

interface GroupDetail extends GroupSummary {
  per_member_stake?: string;
  creator_stake?: string;
  min_members?: number;
  currency?: string;
  client_seed?: string;
  nonce?: number;
  server_seed_hash?: string;
  winning_side?: string | null;
  result_hash?: string | null;
  auto_flip_seconds?: number;
  invite_token?: string;
  members: Array<{
    user_id: string;
    role: 'creator' | 'member';
    choice: string;
    stake: string | number;
    weight: string | number;
    payout_amount: string | number | null;
    is_winner: boolean | null;
    joined_at: string;
  }>;
  audit: Array<{
    action: string;
    actor_id: string | null;
    payload: any;
    ip_address: string | null;
    created_at: string;
  }>;
  fraudSignals: Array<{
    id: string;
    signal_type: string;
    severity: string;
    status: string;
    metadata: any;
    detected_at: string;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-brand-info/20 text-brand-info border-brand-info/30',
  ready: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  flipping: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  resolved: 'bg-brand-green/20 text-brand-green border-brand-green/30',
  cancelled: 'bg-text-muted/20 text-text-muted border-text-muted/30',
  expired: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  frozen: 'bg-brand-red/20 text-brand-red border-brand-red/30',
};

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function fmtMoney(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (Number.isNaN(n)) return String(s);
  return `$${n.toFixed(2)}`;
}

// ─── Leaderboard sub-component (Gap 3) ─────────────────────
// Top-50 users by group-bet winnings over the last 7 days. The
// backend endpoint enforces the 7-day window + min-fraud-score so we
// can't accidentally render historic rows.
function LeaderboardTab(props: {
  loading: boolean;
  err: string;
  enabled: boolean;
  entries: LeaderboardEntry[];
  onRefresh: () => void;
}) {
  const { loading, err, enabled, entries, onRefresh } = props;
  return (
    <div className="glass-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-sm font-mono uppercase tracking-widest text-text-primary">
            🏆 Top-50 Winners · last 7 days
          </h3>
          <p className="text-[11px] text-text-muted font-mono mt-0.5">
            Aggregated from <code>group_bet_member.payout_amount</code> for resolved, non-frozen groups.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface/60 border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {!enabled && (
        <div className="px-4 py-3 text-xs font-mono text-amber-400 bg-amber-500/5 border-b border-amber-500/30">
          ⚠️ Group leaderboard is disabled in admin-config ({'groupLeaderboardEnabled'}=false). Admin can re-enable it from the Game Config panel.
        </div>
      )}
      {err && (
        <div className="px-4 py-3 text-xs font-mono text-brand-red bg-brand-red/5 border-b border-brand-red/30">
          {err}
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="bg-surface/60 text-text-muted text-[10px] uppercase tracking-widest font-mono">
          <tr>
            <th className="px-3 py-2 text-right">Rank</th>
            <th className="px-3 py-2 text-left">User</th>
            <th className="px-3 py-2 text-right">Winnings</th>
            <th className="px-3 py-2 text-right">Rooms won</th>
            <th className="px-3 py-2 text-right">Stake total</th>
          </tr>
        </thead>
        <tbody>
          {loading && entries.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted text-xs">Loading…</td></tr>
          ) : entries.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted text-xs">No winners in the last 7 days yet.</td></tr>
          ) : entries.map((row) => (
            <tr key={row.userId} className="border-t border-border hover:bg-surface/40">
              <td className="px-3 py-2 text-right font-mono text-text-primary">#{row.rank}</td>
              <td className="px-3 py-2 text-left font-mono text-text-primary">{row.username || row.userId.slice(0, 8)}</td>
              <td className="px-3 py-2 text-right font-mono text-brand-green">${row.winnings.toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-mono text-text-secondary">{row.roomsWon}</td>
              <td className="px-3 py-2 text-right font-mono text-text-muted">${row.totalStake.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function GroupAdminPanel() {
  const store = useGameStore();
  const toast = useToast();

  const [token] = useState(getToken());

  // List + filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [onlyFrozen, setOnlyFrozen] = useState<boolean>(false);
  const [minFraudScore, setMinFraudScore] = useState<number>(0);
  const [search, setSearch] = useState<string>('');
  const [list, setList] = useState<GroupSummary[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [listErr, setListErr] = useState<string>('');

  // Detail view
  const [selected, setSelected] = useState<GroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailErr, setDetailErr] = useState<string>('');

  // Mark-fraud modal
  const [markModal, setMarkModal] = useState<{ open: boolean; groupId: string; signalType: string; severity: string; reason: string }>(
    { open: false, groupId: '', signalType: 'group_unusual_pattern', severity: 'high', reason: '' },
  );

  // Sub-tab: 'list' | 'leaderboard'
  const [activeTab, setActiveTab] = useState<'list' | 'leaderboard'>('list');

  // Leaderboard state
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState<boolean>(false);
  const [leaderboardErr, setLeaderboardErr] = useState<string>('');
  const [leaderboardEnabled, setLeaderboardEnabled] = useState<boolean>(true);

  const authHeaders = useMemo(() => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }), [token]);

  const backendBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    // Browser → same-origin /api proxy → backend (see frontend/lib/api/base.ts)
    if (!process.env.NEXT_PUBLIC_API_URL) return '/api';
    return process.env.NEXT_PUBLIC_API_URL;
  }, []);

  // ── Fetch the list of groups ─────────────────────────────────
  const fetchList = useCallback(async () => {
    setListLoading(true);
    setListErr('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (onlyFrozen) params.set('frozen', 'true');
      if (minFraudScore > 0) params.set('minFraudScore', String(minFraudScore));
      if (search) params.set('creatorId', search);
      params.set('limit', '50');
      const r = await fetch(`${backendBase}/admin/groups?${params.toString()}`, { headers: authHeaders });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      setList(j.data as GroupSummary[]);
    } catch (e: any) {
      setListErr(e?.message || 'Failed to load groups');
      setList([]);
    } finally {
      setListLoading(false);
    }
  }, [authHeaders, backendBase, statusFilter, onlyFrozen, minFraudScore, search]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // ── Fetch detail for one group ─────────────────────────────
  const fetchDetail = useCallback(async (groupIdOrShort: string) => {
    setDetailLoading(true);
    setDetailErr('');
    try {
      const r = await fetch(`${backendBase}/admin/groups/${encodeURIComponent(groupIdOrShort)}`, { headers: authHeaders });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      setSelected(j.data as GroupDetail);
    } catch (e: any) {
      setDetailErr(e?.message || 'Failed to load group');
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  }, [authHeaders, backendBase]);

  // ── POST handlers ───────────────────────────────────────────
  // Gap 3: Fetch the leaderboard (Top-50 by winnings over 7 days)
  const fetchLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    setLeaderboardErr('');
    try {
      const r = await fetch(`${backendBase}/admin/groups/leaderboard`, { headers: authHeaders });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setLeaderboard(Array.isArray(j.data) ? j.data : []);
      setLeaderboardEnabled(!!j.leaderboardEnabled);
    } catch (e: any) {
      setLeaderboardErr(e?.message || 'failed to load leaderboard');
    } finally {
      setLeaderboardLoading(false);
    }
  }, [authHeaders, backendBase]);

  useEffect(() => {
    if (activeTab === 'leaderboard') fetchLeaderboard();
  }, [activeTab, fetchLeaderboard]);

  const doPost = useCallback(async (groupId: string, path: 'force-cancel' | 'freeze' | 'mark-fraud' | 'refund' | 'shadow' | `kick/${string}`, body: Record<string, any> = {}) => {
    try {
      const r = await fetch(`${backendBase}/admin/groups/${groupId}/${path}`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      toast.addToast(`${path} succeeded`, 'success');
      // Refresh list + (if open) detail
      fetchList();
      if (selected?.id === groupId) fetchDetail(groupId);
      return j.data;
    } catch (e: any) {
      toast.addToast(`${path} failed: ${e?.message}`, 'error');
      return null;
    }
  }, [authHeaders, backendBase, toast, fetchList, fetchDetail, selected]);

  // ── Kick a specific member (Day 9) ────────────────────────
  const doKick = useCallback(async (groupId: string, userId: string, reason: string) => {
    return doPost(groupId, `kick/${userId}` as `kick/${string}`, { reason });
  }, [doPost]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <Users size={20} className="text-brand-green" />
          Group Bet Console
        </h2>
        <button
          type="button"
          onClick={fetchList}
          disabled={listLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-brand-green/40 disabled:opacity-50 transition"
        >
          <RefreshCw size={14} className={listLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="glass-card p-2 flex gap-2 mb-3">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-3 py-1 rounded-lg text-sm font-mono ${
            activeTab === 'list'
              ? 'bg-brand-green/20 text-brand-green border border-brand-green/40'
              : 'bg-surface/60 text-text-muted border border-border'
          }`}
        >
          📋 Group List
        </button>
        <button
          onClick={() => setActiveTab('leaderboard')}
          className={`px-3 py-1 rounded-lg text-sm font-mono ${
            activeTab === 'leaderboard'
              ? 'bg-brand-green/20 text-brand-green border border-brand-green/40'
              : 'bg-surface/60 text-text-muted border border-border'
          }`}
        >
          🏆 Leaderboard (7d)
        </button>
      </div>

      {activeTab === 'list' && (
      <>
      <div className="glass-card p-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="ready">Ready</option>
            <option value="flipping">Flipping</option>
            <option value="resolved">Resolved</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm font-mono text-text-secondary">
          <input
            type="checkbox"
            checked={onlyFrozen}
            onChange={(e) => setOnlyFrozen(e.target.checked)}
            className="accent-brand-green"
          />
          Frozen only
        </label>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Min fraud score</label>
          <input
            type="number"
            value={minFraudScore}
            onChange={(e) => setMinFraudScore(Number(e.target.value) || 0)}
            className="w-20 bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
            min={0}
            max={100}
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Creator user id (search)</label>
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="UUID…"
              className="w-full bg-surface border border-border rounded-lg pl-7 pr-2 py-1 text-sm font-mono text-text-primary"
            />
          </div>
        </div>
      </div>

      {/* List */}
      {listErr && (
        <div className="glass-card p-4 border border-brand-red/30 bg-brand-red/5 text-brand-red text-sm">
          {listErr}
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface/60 text-text-muted text-[10px] uppercase tracking-widest font-mono">
            <tr>
              <th className="px-3 py-2 text-left">Short code</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Pool</th>
              <th className="px-3 py-2 text-right">Members</th>
              <th className="px-3 py-2 text-left">Payout</th>
              <th className="px-3 py-2 text-right">Fraud</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {listLoading && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-text-muted font-mono">Loading…</td></tr>
            )}
            {!listLoading && list.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-text-muted font-mono">No groups match the current filters.</td></tr>
            )}
            {list.map((g) => (
              <tr key={g.id} className="border-t border-border hover:bg-surface/40 transition cursor-pointer" onClick={() => fetchDetail(g.id)}>
                <td className="px-3 py-2 font-mono">
                  <span className="text-brand-green">{g.short_code}</span>
                  {g.is_frozen && <Snowflake size={12} className="inline ml-2 text-brand-info" />}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-mono border ${STATUS_COLORS[g.status] || 'border-border text-text-muted'}`}>
                    {g.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtMoney(g.total_pool)}</td>
                <td className="px-3 py-2 text-right font-mono">{g.current_members}/{g.max_members}</td>
                <td className="px-3 py-2 font-mono text-text-secondary">{g.payout_mode}</td>
                <td className="px-3 py-2 text-right font-mono">
                  <span className={Number(g.fraud_score) >= 80 ? 'text-brand-red' : Number(g.fraud_score) >= 40 ? 'text-amber-400' : 'text-text-secondary'}>
                    {g.fraud_score}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-text-secondary text-xs">{fmtDate(g.created_at)}</td>
                <td className="px-3 py-2 text-right">
                  <ChevronRight size={14} className="text-text-muted" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail drawer */}
      {selected && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Eye size={18} /> Group {selected.short_code}
              <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-mono border ${STATUS_COLORS[selected.status] || 'border-border'}`}>
                {selected.status}
              </span>
              {selected.is_frozen && <Snowflake size={14} className="text-brand-info" />}
            </h3>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-text-muted hover:text-text-primary"
            >
              <X size={18} />
            </button>
          </div>

          {detailErr && (
            <div className="text-sm text-brand-red">{detailErr}</div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
            <div><span className="text-text-muted">Creator:</span> {selected.creator_id.slice(0, 8)}…</div>
            <div><span className="text-text-muted">Choice:</span> {selected.creator_choice}</div>
            <div><span className="text-text-muted">Payout:</span> {selected.payout_mode}</div>
            <div><span className="text-text-muted">Turn:</span> {selected.turn_mode}</div>
            <div><span className="text-text-muted">Pool:</span> {fmtMoney(selected.total_pool)}</div>
            <div><span className="text-text-muted">Members:</span> {selected.current_members}/{selected.max_members}</div>
            <div><span className="text-text-muted">Fraud score:</span> {selected.fraud_score}</div>
            <div><span className="text-text-muted">Created:</span> {fmtDate(selected.created_at)}</div>
            {selected.winning_side && (
              <div><span className="text-text-muted">Winning side:</span> {selected.winning_side}</div>
            )}
            {selected.result_hash && (
              <div className="col-span-2"><span className="text-text-muted">Result hash:</span> <code className="text-[10px]">{selected.result_hash}</code></div>
            )}
            <div className="col-span-2"><span className="text-text-muted">Expires:</span> {fmtDate(selected.expires_at)}</div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={() => doPost(selected.id, 'force-cancel', { reason: 'admin override from console' })}
              disabled={['cancelled', 'resolved', 'expired'].includes(selected.status)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-red/30 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <Trash2 size={14} /> Force-cancel
            </button>
            <button
              type="button"
              onClick={() => doPost(selected.id, 'freeze', { reason: 'admin freeze from console' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-info/30 text-brand-info hover:bg-brand-info/10 transition"
            >
              <Snowflake size={14} /> {selected.is_frozen ? 'Unfreeze' : 'Freeze'}
            </button>
            <button
              type="button"
              onClick={() => setMarkModal({
                open: true,
                groupId: selected.id,
                signalType: 'group_unusual_pattern',
                severity: 'high',
                reason: '',
              })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition"
            >
              <Flag size={14} /> Mark fraud
            </button>
            {/* Day 9: Refund (reverses a FINISHED room's payouts) */}
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Refund this resolved room? This will debit every winner\'s balance and zero out their payout. Continue?')) {
                  doPost(selected.id, 'refund', { reason: 'admin refund from console' });
                }
              }}
              disabled={selected.status !== 'resolved'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <Undo2 size={14} /> Refund
            </button>
            {/* Day 9: Shadow (admin silently observes) */}
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Shadow this group? You will silently observe (no state change). Continue?')) {
                  doPost(selected.id, 'shadow', { reason: 'admin shadow from console' });
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-text-muted/30 text-text-secondary hover:text-text-primary hover:bg-surface/50 transition"
            >
              <Eye size={14} /> Shadow
            </button>
          </div>

          {/* Members */}
          <div>
            <h4 className="text-sm font-bold text-text-primary mb-1">Members ({selected.members.length})</h4>
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface/60 text-text-muted text-[10px] uppercase tracking-widest font-mono">
                  <tr>
                    <th className="px-2 py-1 text-left">User</th>
                    <th className="px-2 py-1 text-left">Role</th>
                    <th className="px-2 py-1 text-left">Choice</th>
                    <th className="px-2 py-1 text-right">Stake</th>
                    <th className="px-2 py-1 text-right">Weight</th>
                    <th className="px-2 py-1 text-right">Payout</th>
                    <th className="px-2 py-1">Winner</th>
                                      <th className="px-2 py-1">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {selected.members.map((m) => (
                                      <tr key={m.user_id} className="border-t border-border">
                                        <td className="px-2 py-1 font-mono">{m.user_id.slice(0, 8)}…</td>
                                        <td className="px-2 py-1 font-mono text-text-secondary">{m.role}</td>
                                        <td className="px-2 py-1 font-mono">{m.choice}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmtMoney(m.stake)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{m.weight}</td>
                                        <td className="px-2 py-1 text-right font-mono">{m.payout_amount === null ? '—' : fmtMoney(m.payout_amount)}</td>
                                        <td className="px-2 py-1 text-center">{m.is_winner === null ? '—' : m.is_winner ? '✓' : '✗'}</td>
                                        <td className="px-2 py-1 text-center">
                                          {['resolved', 'cancelled', 'expired'].includes(selected.status) ? (
                                            <span className="text-text-muted text-[10px]">—</span>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (window.confirm(`Kick ${m.user_id.slice(0,8)}… from this group? Their stake (${fmtMoney(m.stake)}) will be refunded.`)) {
                                                  doKick(selected.id, m.user_id, 'admin kick from console');
                                                }
                                              }}
                                              className="text-rose-400 hover:bg-rose-500/10 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest"
                                            >
                                              Kick
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
              </table>
            </div>
          </div>

          {/* Fraud signals */}
          {selected.fraudSignals.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-text-primary mb-1 flex items-center gap-1">
                <AlertOctagon size={14} className="text-amber-400" /> Fraud signals ({selected.fraudSignals.length})
              </h4>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-surface/60 text-text-muted text-[10px] uppercase tracking-widest font-mono">
                    <tr>
                      <th className="px-2 py-1 text-left">Signal</th>
                      <th className="px-2 py-1 text-left">Severity</th>
                      <th className="px-2 py-1 text-left">Status</th>
                      <th className="px-2 py-1 text-left">Detected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.fraudSignals.map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="px-2 py-1 font-mono text-amber-400">{s.signal_type}</td>
                        <td className="px-2 py-1 font-mono uppercase">{s.severity}</td>
                        <td className="px-2 py-1 font-mono text-text-secondary">{s.status}</td>
                        <td className="px-2 py-1 font-mono text-text-secondary">{fmtDate(s.detected_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Audit (last 10) */}
          {selected.audit.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-text-primary mb-1">Audit (last {Math.min(10, selected.audit.length)})</h4>
              <div className="border border-border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-surface/60 text-text-muted text-[10px] uppercase tracking-widest font-mono sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left">When</th>
                      <th className="px-2 py-1 text-left">Action</th>
                      <th className="px-2 py-1 text-left">Actor</th>
                      <th className="px-2 py-1 text-left">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.audit.slice(0, 10).map((a, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-2 py-1 font-mono text-text-secondary">{fmtDate(a.created_at)}</td>
                        <td className="px-2 py-1 font-mono">{a.action}</td>
                        <td className="px-2 py-1 font-mono text-text-secondary">{a.actor_id ? a.actor_id.slice(0, 8) + '…' : 'system'}</td>
                        <td className="px-2 py-1 font-mono text-text-secondary">{a.ip_address || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mark-fraud modal */}
      {markModal.open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setMarkModal(m => ({ ...m, open: false }))}>
          <div className="glass-card p-5 max-w-md w-full mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Flag size={18} className="text-amber-400" /> Mark as fraud
            </h3>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-muted font-mono">Signal type</label>
              <select
                value={markModal.signalType}
                onChange={(e) => setMarkModal(m => ({ ...m, signalType: e.target.value }))}
                className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
              >
                <option value="group_unusual_pattern">group_unusual_pattern</option>
                <option value="group_sybil_suspected">group_sybil_suspected</option>
                <option value="group_invite_farm_suspected">group_invite_farm_suspected</option>
                <option value="group_founder_collusion">group_founder_collusion</option>
                <option value="group_withdraw_hold">group_withdraw_hold</option>
                <option value="group_vpn_suspected">group_vpn_suspected</option>
                <option value="group_compromised_creator">group_compromised_creator</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-muted font-mono">Severity</label>
              <select
                value={markModal.severity}
                onChange={(e) => setMarkModal(m => ({ ...m, severity: e.target.value }))}
                className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-muted font-mono">Reason</label>
              <textarea
                value={markModal.reason}
                onChange={(e) => setMarkModal(m => ({ ...m, reason: e.target.value }))}
                rows={3}
                placeholder="Why are you flagging this group?"
                className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => setMarkModal(m => ({ ...m, open: false }))}
                className="px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!markModal.reason.trim()) {
                    toast.addToast('Reason required', 'error');
                    return;
                  }
                  const ok = await doPost(markModal.groupId, 'mark-fraud', {
                    signalType: markModal.signalType,
                    severity: markModal.severity,
                    reason: markModal.reason,
                  });
                  if (ok) setMarkModal(m => ({ ...m, open: false, reason: '' }));
                }}
                disabled={!markModal.reason.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Flag size={14} /> Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Back-to-list helper */}
      {selected && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
          >
            <ChevronLeft size={12} /> Close detail
          </button>
        </div>
      )}
      </>
      )}

      {activeTab === 'leaderboard' && (
        <LeaderboardTab
          loading={leaderboardLoading}
          err={leaderboardErr}
          enabled={leaderboardEnabled}
          entries={leaderboard}
          onRefresh={fetchLeaderboard}
        />
      )}
    </div>
  );
}