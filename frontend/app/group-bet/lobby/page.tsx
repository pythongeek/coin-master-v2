/**\n * ════════════════════════════════════════════════════════════════\n *  GROUP-BET LOBBY — Phase 2 / Day 12\n *  ════════════════════════════════════════════════════════════════\n *
 *  Lobby browser UI for the multiplayer Group Bet system. Uses:\n *    GET /api/group-bet/lobby         (public — open/ready rooms)\n *    GET /api/group-bet/friends/active (auth required)\n *    GET /api/group-bet/user/history    (auth required)\n *    GroupShareModal — opens on \"Share\" button click in each card\n *\n *  Mirrors the design language of /group-bet (Day-7 smoke page):\n *  dark surfaces, brand-green accents, monospace meta text.\n *  Lives at /group-bet/lobby (NOT /lobby) to avoid colliding with any\n *  existing single-player lobby.\n * ════════════════════════════════════════════════════════════════\n */

'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Users,
  Coins,
  Clock,
  Filter,
  RefreshCw,
  Sparkles,
  Crown,
  Equal,
  Trophy,
  Loader2,
  AlertCircle,
  Plus,
  ChevronRight,
  Copy,
} from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import { getApiBase } from '@/lib/api/base';
import { useGameStore } from '@/lib/store';

const API = getApiBase();

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

// ─── Types mirroring backend listOpenGroups return shape ────────────
interface LobbyRoom {
  id: string;
  shortCode: string;
  status: 'open' | 'ready' | 'flipping' | 'resolved' | 'cancelled' | 'expired' | 'frozen';
  gameType: string;
  creatorId: string;
  creatorChoice: 'heads' | 'tails';
  creatorStake: string;
  perMemberStake: string;
  totalPool: string;
  minMembers: number;
  maxMembers: number;
  currentMembers: number;
  payoutMode: 'equal' | 'proportional' | 'founder_boost';
  turnMode: 'creator' | 'auto_on_full' | 'random_lottery';
  autoFlipSeconds: number;
  expiresAt: string;
  resolvedAt: string | null;
  winningSide: string | null;
  createdAt: string;
}

interface PaginatedList {
  rooms: LobbyRoom[];
  total: number;
  limit: number;
  offset: number;
}

const PAYOUT_ICON = {
  equal: Equal,
  proportional: Sparkles,
  founder_boost: Crown,
} as const;

const PAYOUT_LABEL = {
  equal: 'Equal split',
  proportional: 'Weight × pool',
  founder_boost: 'Founder +10%',
} as const;

function payoutIcon(mode: keyof typeof PAYOUT_ICON) {
  return PAYOUT_ICON[mode] || Equal;
}
function payoutLabel(mode: keyof typeof PAYOUT_LABEL) {
  return PAYOUT_LABEL[mode] || mode;
}

function fmtMoney(n: string | number): string {
  const v = typeof n === 'string' ? parseFloat(n) : n;
  return isFinite(v) ? v.toFixed(2) : '0.00';
}

function fmtRelativeTime(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '—';
  const diff = Math.floor((date.getTime() - Date.now()) / 1000);
  if (diff < 0) {
    const absDiff = -diff;
    if (absDiff < 60) return `${absDiff}s ago`;
    if (absDiff < 3600) return `${Math.floor(absDiff / 60)}m ago`;
    if (absDiff < 86400) return `${Math.floor(absDiff / 3600)}h ago`;
    return `${Math.floor(absDiff / 86400)}d ago`;
  }
  if (diff < 60) return `${diff}s left`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h left`;
  return `${Math.floor(diff / 86400)}d left`;
}

export default function GroupBetLobbyPage() {
  const router = useRouter();
  const toast = useToast();
  // Gap 17: pull country from the game store so the lobby knows the
  // user's current ISO 3166 country code. We then derive:
  //   - viewerCountry → sent to /api/group-bet/lobby so the server
  //     filters rooms (server-side filter is the source of truth).
  //   - userIsBlocked → if the user's country doesn't fall in the
  //     locally-known allow list (we treat `'*'` as "everyone").
  //   - restrictedCountry → if user.country is set AND not in the
  //     allowlist; we render the "🌍 Restricted country" banner
  //     and disable the Join buttons on every card.
  const storeUser = useGameStore((s: any) => s.user);
  const userCountry: string = (storeUser?.country || '').toUpperCase().trim();
  const [allowedCountries, setAllowedCountries] = useState<string[]>(['*']);
  const [hasToken, setHasToken] = useState<boolean>(false);

  const [filters, setFilters] = useState<{
    payoutMode: '' | 'equal' | 'proportional' | 'founder_boost';
    minPool: string;
    maxPool: string;
    limit: number;
    offset: number;
  }>({
    payoutMode: '',
    minPool: '',
    maxPool: '',
    limit: 24,
    offset: 0,
  });

  const [lobby, setLobby] = useState<PaginatedList>({ rooms: [], total: 0, limit: 24, offset: 0 });
  const [friendsActive, setFriendsActive] = useState<LobbyRoom[]>([]);
  const [myHistory, setMyHistory] = useState<LobbyRoom[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errMsg, setErrMsg] = useState<string>('');

  // ── Auth gate + country allowlist boot on mount ──────────────
  useEffect(() => {
    setHasToken(Boolean(getToken()));
    // Fetch the public group-admin config once. This avoids hard-coding
    // the allowlist on the client (the server is authoritative, but
    // the client-side filter + badge need the same value). The endpoint
    // lives at /api/public (no auth required, no admin prefix).
    fetch(`${API.replace(/\/group-bet$/, '')}/public`)
      .then((r) => r.json().catch(() => null))
      .then((j) => {
        const v = j?.data?.groupPlayAllowedCountries ?? j?.groupPlayAllowedCountries;
        if (typeof v === 'string') {
          setAllowedCountries(
            v.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean),
          );
        }
      })
      .catch(() => {}); // best-effort; UI graceful-degrades to "*"
  }, []);

  // Compute the country-restriction flag. `*` means everyone is allowed.
  const userIsBlocked =
    userCountry.length > 0 &&
    !allowedCountries.includes('*') &&
    !allowedCountries.includes(userCountry);
  const restrictedCountry = userCountry.length > 0 && (userIsBlocked || userCountry !== '');

  // ── Fetch all 3 endpoints in parallel ────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setErrMsg('');
    const q = new URLSearchParams({
      limit: String(filters.limit),
      offset: String(filters.offset),
      ...(filters.payoutMode ? { payoutMode: filters.payoutMode } : {}),
      ...(filters.minPool ? { minPool: filters.minPool } : {}),
      ...(filters.maxPool ? { maxPool: filters.maxPool } : {}),
      // Gap 17: server-side country filter. Sent as a query param so
      // the server's listOpenGroups() can cross-check the allowlist
      // and exclude rooms the user shouldn't see.
      ...(userCountry ? { viewerCountry: userCountry } : {}),
    });
    const token = getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const lobbyUrl = `${API}/group-bet/lobby?${q}`;

    const promises: Promise<Response>[] = [fetch(lobbyUrl)];
    const friendsUrl = `${API}/group-bet/friends/active?limit=12`;
    const historyUrl = `${API}/group-bet/user/history?limit=12`;
    if (token) {
      promises.push(fetch(friendsUrl, { headers }));
      promises.push(fetch(historyUrl, { headers }));
    }

    try {
      const results = await Promise.allSettled(promises);
      // [0] = lobby, [1] = friends, [2] = history (only if token)
      const lobRes = results[0];
      if (lobRes.status === 'fulfilled' && lobRes.value.ok) {
        const j = await lobRes.value.json();
        if (j.success && j.data) setLobby(j.data);
      } else {
        setErrMsg('Failed to load lobby. Try again in a moment.');
      }
      if (token && results[1] && results[1].status === 'fulfilled' && (results[1] as PromiseFulfilledResult<Response>).value.ok) {
        const j = await (results[1] as PromiseFulfilledResult<Response>).value.json();
        if (j.success && j.data) setFriendsActive(j.data.rooms || []);
      }
      if (token && results[2] && results[2].status === 'fulfilled' && (results[2] as PromiseFulfilledResult<Response>).value.ok) {
        const j = await (results[2] as PromiseFulfilledResult<Response>).value.json();
        if (j.success && j.data) setMyHistory((j.data.rooms || []).slice(0, 5));
      }
    } catch (e: any) {
      setErrMsg(e?.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Filter handlers ─────────────────────────────────────────────
  const resetFilters = () => {
    setFilters({ payoutMode: '', minPool: '', maxPool: '', limit: 24, offset: 0 });
  };

  const showAuthWall = !hasToken;

  return (
    <div className="min-h-screen bg-surface/50 px-4 sm:px-6 lg:px-8 py-6">
      {/* ───── Header ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary flex items-center gap-2">
            <Users className="text-brand-green" />
            Group Bet Lobby
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Open rooms — pick one to join, or{' '}
            <Link href="/group-bet/create" className="text-brand-green hover:underline font-mono">
              create your own
            </Link>{' '}
            and invite friends.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-brand-green/40 disabled:opacity-50 transition"
            aria-label="Refresh lobby"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <Link
            href="/group-bet/create"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-green/40 bg-brand-green/10 text-brand-green hover:bg-brand-green/20 transition"
          >
            <Plus size={14} />
            Create room
          </Link>
        </div>
      </div>

      {/* ───── Filters bar ────────────────────────────────────────── */}
      <div className="glass-card p-3 mb-4">
        <div className="flex items-center gap-2 text-xs text-text-muted font-mono mb-2">
          <Filter size={12} />
          Filters
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* payout mode chips */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted mr-1">Payout:</span>
            {(['', 'equal', 'proportional', 'founder_boost'] as const).map((mode) => (
              <button
                key={mode || 'all'}
                type="button"
                onClick={() => setFilters((f) => ({ ...f, payoutMode: mode, offset: 0 }))}
                className={`px-2 py-1 rounded text-[10px] uppercase tracking-widest font-mono border transition ${
                  filters.payoutMode === mode
                    ? 'border-brand-green/60 bg-brand-green/10 text-brand-green'
                    : 'border-border text-text-secondary hover:bg-surface/50'
                }`}
              >
                {mode === '' ? 'all' : mode.replace('_', ' ')}
              </button>
            ))}
          </div>

          <span className="text-text-muted/30">|</span>

          {/* pool range */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">Pool</span>
            <input
              type="number"
              placeholder="min"
              value={filters.minPool}
              min={0}
              onChange={(e) => setFilters((f) => ({ ...f, minPool: e.target.value, offset: 0 }))}
              className="w-20 bg-surface/60 border border-border rounded px-2 py-1 text-xs font-mono text-text-primary"
            />
            <span className="text-text-muted/40">–</span>
            <input
              type="number"
              placeholder="max"
              value={filters.maxPool}
              min={0}
              onChange={(e) => setFilters((f) => ({ ...f, maxPool: e.target.value, offset: 0 }))}
              className="w-20 bg-surface/60 border border-border rounded px-2 py-1 text-xs font-mono text-text-primary"
            />
          </div>

          {(filters.payoutMode || filters.minPool || filters.maxPool) && (
            <button
              type="button"
              onClick={resetFilters}
              className="px-2 py-1 rounded text-[10px] uppercase tracking-widest font-mono border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {showAuthWall && (
        <div className="glass-card p-4 mb-4 text-text-secondary flex items-center gap-3">
          <AlertCircle size={16} className="text-amber-400" />
          <span className="text-sm">
            You're not logged in. Showing the public lobby. To join a room,{' '}
            <Link href="/login" className="text-brand-green hover:underline">log in</Link> first.
          </span>
        </div>
      )}

      {errMsg && (
        <div className="glass-card p-3 mb-4 border-rose-500/30 text-rose-400 text-sm">{errMsg}</div>
      )}

      {/* ───── Main grid + sidebars ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* ── Lobby grid ──────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Trophy size={14} className="text-brand-green" />
              Open rooms
              <span className="text-[10px] font-mono text-text-muted">
                ({lobby.total} total)
              </span>
            </h2>
            {loading && <Loader2 size={14} className="text-text-muted animate-spin" />}
          </div>

          {/* Gap 17: surface the country restriction as a clear banner.
              The server already filtered out rooms, but we render this
              so the user understands why their list is empty / short. */}
          {userCountry && userIsBlocked && (
            <div className="mb-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5 flex items-start gap-2">
              <span className="text-amber-400 text-lg leading-none">🌍</span>
              <div className="flex-1">
                <p className="text-sm font-mono text-amber-300">
                  <strong>Restricted country</strong> ({userCountry})
                </p>
                <p className="text-[11px] font-mono text-text-muted mt-0.5">
                  Your region is not in the operator-configured allowlist
                  (
                  {allowedCountries.includes('*')
                    ? '*'
                    : allowedCountries.join(', ')}
                  ). Rooms are hidden and Joining is disabled.
                </p>
              </div>
            </div>
          )}

          {lobby.rooms.length === 0 && !loading && (
            <div className="glass-card p-6 text-center text-text-muted font-mono text-sm">
              No rooms match your filters.{' '}
              <button onClick={resetFilters} className="text-brand-green hover:underline">
                Reset filters
              </button>
              , or
              <Link href="/group-bet/create" className="text-brand-green hover:underline ml-1">
                create the first one
              </Link>.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {lobby.rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                authed={hasToken}
                disabled={userIsBlocked}
                onClick={() => {
                  // Gap 17: don't navigate to a room if the user is
                  // country-blocked. The server enforces this too, but
                  // we don't want to even load the room page.
                  if (userIsBlocked) return;
                  router.push(`/group-bet/room/${room.shortCode}`);
                }}
              />
            ))}
          </div>

          {/* pagination */}
          {lobby.total > filters.limit && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <button
                type="button"
                disabled={filters.offset === 0 || loading}
                onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - f.limit) }))}
                className="px-3 py-1 rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-30"
              >
                ← Prev
              </button>
              <span className="text-xs font-mono text-text-muted">
                {filters.offset + 1}–{Math.min(filters.offset + filters.limit, lobby.total)} of {lobby.total}
              </span>
              <button
                type="button"
                disabled={filters.offset + filters.limit >= lobby.total || loading}
                onClick={() => setFilters((f) => ({ ...f, offset: f.offset + f.limit }))}
                className="px-3 py-1 rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          )}
        </section>

        {/* ── Sidebars (My + Friends) ────────────────────────── */}
        <aside className="space-y-4">
          {hasToken && (
            <div className="glass-card p-3">
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2 mb-2">
                <Users size={14} className="text-brand-info" />
                My active groups
              </h3>
              {myHistory.length === 0 ? (
                <p className="text-xs text-text-muted">None yet — join or create one!</p>
              ) : (
                <ul className="space-y-1">
                  {myHistory.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/group-bet/room/${r.shortCode}`}
                        className="text-xs text-text-secondary hover:text-brand-green block font-mono"
                      >
                        <span className="font-bold">{r.shortCode}</span> ·{' '}
                        <span className="text-text-muted">{r.status}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {hasToken && (
            <div className="glass-card p-3">
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2 mb-2">
                <Sparkles size={14} className="text-brand-info" />
                Friends' active
              </h3>
              {friendsActive.length === 0 ? (
                <p className="text-xs text-text-muted">No friends active right now.</p>
              ) : (
                <ul className="space-y-1">
                  {friendsActive.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/group-bet/room/${r.shortCode}`}
                        className="text-xs text-text-secondary hover:text-brand-green block font-mono"
                      >
                        <span className="font-bold">{r.shortCode}</span> ·{' '}
                        {fmtMoney(r.perMemberStake)}/seat ·{' '}
                        <span className="text-text-muted">{r.currentMembers}/{r.maxMembers}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Room card ───────────────────────────────────────────────────────
function RoomCard({ room, authed, disabled, onClick }: { room: LobbyRoom; authed: boolean; disabled?: boolean; onClick: () => void }) {
  const Icon = payoutIcon(room.payoutMode);
  const seatsLeft = Math.max(0, room.maxMembers - room.currentMembers);
  const isFull = seatsLeft === 0;
  const almostFull = !isFull && seatsLeft <= Math.max(1, Math.floor(room.maxMembers / 3));
  // Gap 17: country-blocked users see the card grayed out and cannot click.
  const isBlocked = !!disabled;
  const isUnclickable = isFull || isBlocked;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isUnclickable}
      title={isBlocked ? 'Group play is restricted in your country' : undefined}
      className={`text-left glass-card p-3 hover:border-brand-green/40 transition relative ${
        isUnclickable ? 'opacity-60 cursor-not-allowed' : 'hover:bg-surface/40'
      }`}
    >
      {/* header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-xs text-text-secondary">
          <span className="text-text-primary font-bold">{room.shortCode}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {isBlocked && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 text-[10px] uppercase tracking-widest font-mono">
              🌍 Restricted
            </span>
          )}
          <span className="text-[10px] uppercase tracking-widest font-mono text-text-muted">
            {room.status}
          </span>
        </span>
      </div>

      {/* payout mode + creator stake */}
      <div className="flex items-center gap-2 mb-2">
        <span className="flex items-center gap-1 px-2 py-0.5 rounded border border-brand-info/30 text-brand-info text-[10px] uppercase tracking-widest font-mono">
          <Icon size={10} />
          {payoutLabel(room.payoutMode)}
        </span>
        {almostFull && !isFull && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded border border-amber-500/30 text-amber-400 text-[10px] uppercase tracking-widest font-mono">
            <Sparkles size={10} />
            Filling fast
          </span>
        )}
      </div>

      {/* pool */}
      <div className="flex items-baseline gap-1.5 mb-2">
        <Coins size={14} className="text-brand-green" />
        <span className="font-bold text-text-primary text-lg">{fmtMoney(room.totalPool)}</span>
        <span className="text-xs text-text-muted">pool</span>
      </div>

      {/* members / seats */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1 text-text-secondary">
          <Users size={12} />
          <span className="font-mono">
            {room.currentMembers}/{room.maxMembers}
          </span>
        </div>
        <div className="flex items-center gap-1 text-text-muted">
          <Clock size={10} />
          <span className="font-mono text-[10px]">
            {room.status === 'open' || room.status === 'ready' ? fmtRelativeTime(room.expiresAt) : '—'}
          </span>
        </div>
      </div>

      {/* per-seat cost */}
      <div className="mt-2 pt-2 border-t border-border text-[10px] text-text-muted font-mono flex items-center justify-between">
        <span>
          {fmtMoney(room.perMemberStake)} <span className="text-text-muted/60">·</span> per seat
        </span>
        <span className="text-text-muted/60">{room.creatorChoice}</span>
      </div>
    </button>
  );
}
