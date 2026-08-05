'use client';

/**
 * ════════════════════════════════════════════════════════════════
 *  ACTIVE GROUPS CARD — Gap 2
 *  ════════════════════════════════════════════════════════════════
 *
 *  Calls GET /api/group-bet/active and renders up to 5 of the user's
 *  most recent rooms (open/ready/flipping/resolved, non-frozen).
 *  The endpoint must be mounted BEFORE `/:id` on the server so that
 *  `id='active'` doesn't get caught by the param route.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, Crown, Trophy, Clock, XCircle, Sparkles } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

interface ActiveGroup {
  id: string;
  short_code: string;
  status: 'open' | 'ready' | 'flipping' | 'resolved';
  is_frozen: boolean;
  creator_id: string;
  creator_choice: 'heads' | 'tails';
  total_pool: string;
  creator_stake: string;
  per_member_stake: string;
  current_members: number;
  max_members: number;
  min_members: number;
  payout_mode: 'equal' | 'proportional' | 'founder_boost';
  turn_mode: 'creator' | 'auto_on_full' | 'random_lottery';
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  winning_side: 'heads' | 'tails' | null;
  viewer_role: 'creator' | 'member';
  viewer_choice: 'heads' | 'tails';
  viewer_stake: string;
  viewer_payout: string;
  viewer_is_winner: boolean | null;
}

const STATUS_ICON: Record<string, JSX.Element> = {
  open: <Clock size={14} className="text-amber-400" />,
  ready: <Sparkles size={14} className="text-brand-info" />,
  flipping: <Loader2 size={14} className="text-blue-400 animate-spin" />,
  resolved: <Trophy size={14} className="text-brand-green" />,
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Waiting for members',
  ready: 'Ready to flip',
  flipping: 'Flipping…',
  resolved: 'Resolved',
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

function fmtMoney(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (Number.isNaN(n)) return String(s);
  return `$${n.toFixed(2)}`;
}

function fmtWhen(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    const diffMs = Date.now() - d.getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return s;
  }
}

interface Props {
  token?: string;
  /** Optional override of the limit (defaults to API limit of 25) */
  limit?: number;
}

export function ActiveGroupsCard({ token, limit = 5 }: Props) {
  const [rooms, setRooms] = useState<ActiveGroup[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string>('');

  const fetchRooms = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const base = getApiBase();
      const r = await fetch(`${base}/group-bet/active`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const list: ActiveGroup[] = Array.isArray(j.data?.rooms) ? j.data.rooms : [];
      setRooms(list.slice(0, limit));
    } catch (e: any) {
      setErr(e?.message || 'failed to load');
      setRooms([]);
    } finally {
      setLoading(false);
    }
  }, [token, limit]);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  return (
    <div className="glass-card p-4 rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-brand-info" />
          <h3 className="text-sm font-mono uppercase tracking-widest text-text-primary">
            Active Groups
          </h3>
          <span className="text-[10px] text-text-muted font-mono">
            ({rooms.length})
          </span>
        </div>
        <button
          type="button"
          onClick={fetchRooms}
          disabled={loading}
          className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded-md border border-border bg-surface/40 hover:bg-surface text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {err && (
        <div className="text-[11px] font-mono text-brand-red bg-brand-red/5 border border-brand-red/30 rounded-md px-2 py-1.5 mb-2">
          {err}
        </div>
      )}

      {loading && rooms.length === 0 ? (
        <div className="text-center text-text-muted text-[11px] font-mono py-6">
          <Loader2 size={14} className="animate-spin mx-auto mb-1" />
          Loading…
        </div>
      ) : rooms.length === 0 ? (
        <div className="text-center text-text-muted text-[11px] font-mono py-6">
          No active groups. <a href="/group-bet/new" className="text-brand-info hover:underline">Create one →</a>
        </div>
      ) : (
        <ul className="space-y-2">
          {rooms.map((g) => {
            const won = g.viewer_is_winner === true;
            const lost = g.viewer_is_winner === false;
            const statusBadgeClass =
              g.status === 'resolved' && won ? 'border-brand-green/40 text-brand-green bg-brand-green/5' :
              g.status === 'resolved' && lost ? 'border-brand-red/40 text-brand-red bg-brand-red/5' :
              g.status === 'open' ? 'border-amber-500/30 text-amber-400 bg-amber-500/5' :
              g.status === 'flipping' ? 'border-blue-500/30 text-blue-400 bg-blue-500/5' :
              'border-border text-text-muted bg-surface/30';
            return (
              <li
                key={g.id}
                className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border ${statusBadgeClass}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {STATUS_ICON[g.status] ?? <XCircle size={14} className="text-text-muted" />}
                  {g.viewer_role === 'creator' ? (
                    <Crown size={10} className="text-brand-gold flex-shrink-0" />
                  ) : (
                    <span className="w-2.5 h-2.5 rounded-full bg-text-muted/40 flex-shrink-0" />
                  )}
                  <a
                    href={`/group-bet/${g.id}`}
                    className="font-mono text-xs font-semibold text-text-primary hover:text-brand-green truncate"
                  >
                    {g.short_code}
                  </a>
                  <span className="text-[10px] font-mono text-text-muted truncate">
                    {g.viewer_choice} · {fmtMoney(g.viewer_stake)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted flex-shrink-0">
                  <span>
                    {g.current_members}/{g.max_members}
                  </span>
                  <span>·</span>
                  <span>{fmtMoney(g.total_pool)}</span>
                  <span>·</span>
                  <span>{statusLabel(g.status)}</span>
                  <span>·</span>
                  <span>{fmtWhen(g.created_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rooms.length >= limit && (
        <div className="text-center text-[10px] font-mono text-text-muted mt-2">
          Showing top {limit}. <a href="/dashboard/groups" className="text-brand-info hover:underline">View all →</a>
        </div>
      )}
    </div>
  );
}

export default ActiveGroupsCard;
