/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET SMOKE PAGE — Phase 1 / Day 7
 *  ════════════════════════════════════════════════════════════════
 *
 *  This is a self-contained end-to-end smoke page that lets an
 *  authenticated user:
 *    1. Create a group via POST /api/group-bet (creator)
 *    2. Spectate the group via useGroupBetSocket({ groupId, spectator: true })
 *    3. Watch the 10 server → room events stream into the UI
 *    4. Cancel + share buttons exercise the full stack
 *
 *  Lives at /group-bet (NOT /game) so it doesn't conflict with the
 *  existing single-player coinflip page. Accessible only to logged-in
 *  users (the API enforces auth).
 *
 *  This is intentionally a "single page app" for testing the wiring —
 *  not a polished UX. The real group-bet game UI is Phase 2 work.
 * ════════════════════════════════════════════════════════════════
 */

'use client';

import { useState, useEffect } from 'react';
import { useGroupBetSocket } from '@/lib/useGroupBetSocket';
import { useGameStore } from '@/lib/store';
import { useToast } from '@/components/providers/ToastProvider';
import Link from 'next/link';
import { Users, Copy, Send, X, Check } from 'lucide-react';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL || '';

export default function GroupBetSmokePage() {
  const store = useGameStore();
  const toast = useToast();

  const [token] = useState(getToken());
  const [groupId, setGroupId] = useState<string>('');
  const [shortCode, setShortCode] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Form fields for create
  const [creatorChoice, setCreatorChoice] = useState<'heads' | 'tails'>('heads');
  const [creatorStake, setCreatorStake] = useState<number>(50);
  const [perMemberStake, setPerMemberStake] = useState<number>(50);
  const [minMembers, setMinMembers] = useState<number>(2);
  const [maxMembers, setMaxMembers] = useState<number>(5);

  // Spectate the room (once created)
  const {
    lastByEvent,
    latest,
    history,
    liveStatus,
    liveTotalPool,
    liveCurrentMembers,
    shareInvite,
  } = useGroupBetSocket({ groupId: groupId || '', spectator: !!groupId });

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const create = async () => {
    if (!token) {
      toast.addToast('Please log in first', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${BACKEND}/group-bet`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          creatorChoice,
          creatorStake,
          perMemberStake,
          minMembers,
          maxMembers,
          payoutMode: 'equal',
          turnMode: 'creator',
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      setGroupId(j.data.id);
      setShortCode(j.data.shortCode);
      toast.addToast(`Created group ${j.data.shortCode}`, 'success');
    } catch (e: any) {
      toast.addToast(`Create failed: ${e?.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!groupId) return;
    if (!window.confirm('Cancel this room? All members will be refunded.')) return;
    setBusy(true);
    try {
      const r = await fetch(`${BACKEND}/group-bet/${groupId}/cancel`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reason: 'smoke page cancel' }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      toast.addToast(`Cancelled; ${j.data.refundedMembers} refunded`, 'success');
    } catch (e: any) {
      toast.addToast(`Cancel failed: ${e?.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!shortCode) return;
    const url = `${window.location.origin}/group-bet/join/${shortCode}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      // Also log it server-side via socket.io
      shareInvite('copy');
    } catch {
      // Clipboard blocked — fall back to text-only
    }
  };

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="heading-display text-2xl text-text-primary flex items-center gap-2">
          <Users size={20} className="text-brand-green" /> Group Bet Smoke
        </h1>
        <Link href="/game" className="text-xs text-text-muted hover:text-text-primary">← Back to single-player</Link>
      </div>

      {/* Auth gate */}
      {!token && (
        <div className="glass-card p-4 border border-amber-500/30 bg-amber-500/5 text-amber-400 text-sm">
          Please <Link href="/login" className="underline">log in</Link> first to use the smoke page.
        </div>
      )}

      {token && !groupId && (
        <div className="glass-card p-4 space-y-3">
          <h2 className="heading-display text-sm text-text-primary">Create a group</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Choice</label>
              <select value={creatorChoice} onChange={(e) => setCreatorChoice(e.target.value as any)} className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary">
                <option value="heads">Heads</option>
                <option value="tails">Tails</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Creator stake</label>
              <input type="number" value={creatorStake} onChange={(e) => setCreatorStake(Number(e.target.value))} className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary" min={10} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Per-member stake</label>
              <input type="number" value={perMemberStake} onChange={(e) => setPerMemberStake(Number(e.target.value))} className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary" min={10} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Min members</label>
              <input type="number" value={minMembers} onChange={(e) => setMinMembers(Number(e.target.value))} className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary" min={2} max={5} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-text-muted font-mono">Max members</label>
              <input type="number" value={maxMembers} onChange={(e) => setMaxMembers(Number(e.target.value))} className="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-text-primary" min={2} max={10} />
            </div>
          </div>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="w-full py-2 rounded-lg font-mono text-sm bg-brand-green text-void hover:bg-brand-green-dim disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      )}

      {token && groupId && (
        <>
          {/* Live status */}
          <div className="glass-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="heading-display text-sm text-text-primary">
                Group {shortCode}
              </h2>
              <span className="text-[10px] uppercase tracking-widest font-mono text-text-muted">
                status: <span className="text-text-primary">{liveStatus || 'unknown'}</span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div><span className="text-text-muted">Pool:</span> {liveTotalPool ?? '—'}</div>
              <div><span className="text-text-muted">Members:</span> {liveCurrentMembers ?? '—'}</div>
              <div><span className="text-text-muted">Latest:</span> {latest?.event ?? '—'}</div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={copyInvite}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-brand-green/40"
              >
                {copied ? <Check size={14} className="text-brand-green" /> : <Copy size={14} />}
                Copy invite link
              </button>
              <button
                type="button"
                onClick={() => shareInvite('whatsapp')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-brand-green/40"
              >
                <Send size={14} /> Share via WhatsApp
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={busy || ['cancelled', 'resolved', 'expired'].includes(liveStatus || '')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-red/30 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <X size={14} /> Cancel room
              </button>
            </div>
          </div>

          {/* Live event history */}
          <div className="glass-card p-4">
            <h3 className="text-sm font-bold text-text-primary mb-2">
              Live event stream ({history.length})
            </h3>
            {history.length === 0 ? (
              <div className="text-xs text-text-muted font-mono">
                No events yet. Open the invite link in another tab as a second user to drive traffic.
              </div>
            ) : (
              <ul className="space-y-1 text-xs font-mono max-h-64 overflow-y-auto">
                {history.map((h, i) => (
                  <li key={i} className="border-b border-border/40 pb-1">
                    <span className="text-brand-green">{h.event}</span>{' '}
                    <span className="text-text-muted">{new Date(h.receivedAt).toLocaleTimeString()}</span>
                    {h.payload.shortCode && (
                      <span className="text-text-secondary"> · {String(h.payload.shortCode)}</span>
                    )}
                    {h.payload.totalPool !== undefined && (
                      <span className="text-text-secondary"> · pool=${String(h.payload.totalPool)}</span>
                    )}
                    {h.payload.actorUserId && (
                      <span className="text-text-secondary"> · by {String(h.payload.actorUserId).slice(0, 8)}…</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Last event per type (sanity) */}
          <div className="glass-card p-4 text-xs font-mono">
            <h3 className="text-sm font-bold text-text-primary mb-2">Per-event last-payload map</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {(['group:created', 'group:join', 'group:leave', 'group:ready', 'group:resolved', 'group:cancelled', 'group:expired', 'group:updated'] as const).map((ev) => (
                <div key={ev} className="flex justify-between border-b border-border/40">
                  <span className="text-text-muted">{ev}</span>
                  <span className={lastByEvent[ev] ? 'text-brand-green' : 'text-text-muted'}>
                    {lastByEvent[ev] ? '✓' : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </main>
  );
}