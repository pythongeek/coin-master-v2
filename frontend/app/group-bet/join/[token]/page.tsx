'use client';

/**
 * ════════════════════════════════════════════════════════════════
 *  /group-bet/join/[token] — Deep-link landing page (Gap 5)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Receives the invitee when they tap a `group_invite` link from
 *  WhatsApp / Telegram / a QR code / etc. Flow:
 *    1. Resolve the token via GET /api/group-bet/invites/:token
 *    2. Display the room preview (short code, creator, pool, mode,
 *       max members, expires_at) so the invitee can make an informed
 *       decision before joining.
 *    3. If logged-in: call POST /api/group-bet/invites/:token/redeem
 *       and auto-redirect to /group-bet/room/[shortCode].
 *    4. If not logged-in: render a sign-in CTA + keep the token in
 *       sessionStorage so we can attach it to the next signup login.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Sparkles, ArrowRight, LogIn, Hash, Trophy, Users, Clock, AlertTriangle, Gift } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

interface InvitePreview {
  token: string;
  groupId: string;
  shortCode: string;
  creatorUsername: string | null;
  creatorId: string;
  maxRedemptions: number;
  redemptionsLeft: number;
  expiresAt: string;
  status: 'ok' | 'expired' | 'exhausted' | 'not_found' | 'joiin_failed';
  invalidReason: 'expired' | 'exhausted' | 'not_found' | null;
  // Optional room preview (resolved from group_bet JOIN)
  room?: {
    shortCode: string;
    creatorChoice: 'heads' | 'tails';
    perMemberStake: string;
    currentMembers: number;
    maxMembers: number;
    payoutMode: 'equal' | 'proportional' | 'founder_boost';
    turnMode: 'creator' | 'auto_on_full' | 'random_lottery';
    expiresAt: string;
    status: string;
    shareUrl: string;
  };
}

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

function PickEmoji(side: 'heads' | 'tails'): string {
  return side === 'heads' ? '🪙 heads' : '🎯 tails';
}

export default function DeepLinkJoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = (params?.token ?? '') as string;

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string>('');
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [redeemResult, setRedeemResult] = useState<{ shortCode: string; bonus?: { inviterBonus?: number; inviteeBonus?: number; totalBonus?: number; firstDepositBonus?: number } } | null>(null);
  const [authToken] = useState<string>(getToken());

  // Step 1: resolve the invite token via GET /api/group-bet/invites/:token
  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const base = getApiBase();
      const r = await fetch(`${base}/group-bet/invites/${encodeURIComponent(token)}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      const j = await r.json();
      if (!r.ok) {
        setPreview({
          token,
          groupId: '',
          shortCode: '',
          creatorUsername: null,
          creatorId: '',
          maxRedemptions: 0,
          redemptionsLeft: 0,
          expiresAt: '',
          status: j?.code === 'INVITE_EXPIRED' ? 'expired' : j?.code === 'INVITE_EXHAUSTED' ? 'exhausted' : 'not_found',
          invalidReason: j?.code === 'INVITE_EXPIRED' ? 'expired' : j?.code === 'INVITE_EXHAUSTED' ? 'exhausted' : 'not_found',
        });
      } else {
        setPreview(j.data as InvitePreview);
      }
    } catch (e: any) {
      setErr(e?.message || 'failed to load invite');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchPreview();
  }, [token, fetchPreview]);

  // Step 3: auto-redeem. If already logged in, redeem on user action.
  const handleRedeem = useCallback(async () => {
    if (!authToken) {
      // Stash token in sessionStorage so the post-signup auth can resume the redeem.
      if (typeof window !== 'undefined') sessionStorage.setItem('pending_invite_token', token);
      router.push(`/login?return=/group-bet/join/${encodeURIComponent(token)}`);
      return;
    }
    setRedeeming(true);
    try {
      const base = getApiBase();
      const r = await fetch(`${base}/group-bet/invites/${encodeURIComponent(token)}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRedeemResult({
        shortCode: j.data?.groupId ? '' : '', // filled below
        bonus: {
          inviterBonus: j.data?.inviterBonus,
          inviteeBonus: j.data?.inviteeBonus,
          totalBonus: j.data?.totalBonus,
        },
      });
      // Resolve the short code via the joined room's group_identifier
      // (the redeem response includes the groupId; we need the short code)
      // The room is fetched by id; for brevity we route via the getGroupPreview.
      const roomRes = await fetch(`${base}/group-bet/${encodeURIComponent(j.data?.groupId ?? '')}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const roomJ = await roomRes.json();
      const shortCode = roomJ?.data?.shortCode ?? '';
      // Auto-redirect per the spec: /group-bet/room/[shortCode]
      if (shortCode) {
        router.push(`/group-bet/room/${encodeURIComponent(shortCode)}`);
      }
    } catch (e: any) {
      setErr(e?.message || 'redeem failed');
    } finally {
      setRedeeming(false);
    }
  }, [authToken, router, token]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="text-text-muted font-mono text-sm flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Loading invite…
        </div>
      </main>
    );
  }

  if (err && !preview) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 rounded-xl border border-brand-red/30 bg-brand-red/5">
          <h1 className="text-lg font-mono font-bold text-brand-red mb-2">Invite error</h1>
          <p className="text-sm text-text-secondary">{err}</p>
          <Link href="/dashboard" className="mt-4 inline-block text-xs font-mono text-brand-info hover:underline">← Back to dashboard</Link>
        </div>
      </main>
    );
  }

  if (!preview) return null;

  // Invalid invite: expired / exhausted / not_found
  if (preview.status !== 'ok') {
    const msg = preview.status === 'expired' ? 'This invite has expired.'
      : preview.status === 'exhausted' ? 'This invite has reached its maximum redemptions.'
      : 'This invite is invalid or no longer available.';
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 rounded-xl border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={18} className="text-amber-400" />
            <h1 className="text-lg font-mono font-bold text-amber-400">Invite unavailable</h1>
          </div>
          <p className="text-sm text-text-secondary">{msg}</p>
          <Link href="/dashboard" className="mt-4 inline-block text-xs font-mono text-brand-info hover:underline">← Back to dashboard</Link>
        </div>
      </main>
    );
  }

  const room = preview.room;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card max-w-md w-full p-6 rounded-xl">
        <div className="flex items-center gap-2 mb-3">
          <Gift size={18} className="text-brand-green" />
          <h1 className="text-lg font-mono font-bold text-text-primary">You're invited to join</h1>
        </div>

        {room && (
          <div className="space-y-2 mb-5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted flex items-center gap-1.5">
                <Hash size={12} /> Short code
              </span>
              <Link href={`/group-bet/room/${room.shortCode}`} className="text-brand-info hover:underline">
                {room.shortCode}
              </Link>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted flex items-center gap-1.5">
                <Sparkles size={12} /> Picks {PickEmoji(room.creatorChoice)}
              </span>
              <span className="text-text-primary">{fmtMoney(room.perMemberStake)} / member</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted flex items-center gap-1.5">
                <Users size={12} /> Members
              </span>
              <span className="text-text-primary">{room.currentMembers} / {room.maxMembers}</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted flex items-center gap-1.5">
                <Trophy size={12} /> Mode
              </span>
              <span className="text-text-primary">{room.payoutMode} / {room.turnMode}</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted flex items-center gap-1.5">
                <Clock size={12} /> Expires
              </span>
              <span className="text-text-primary">{fmtDate(room.expiresAt)}</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text-muted">Status</span>
              <span className="text-brand-info">{room.status}</span>
            </div>
          </div>
        )}

        <div className="border-t border-border pt-4 mb-4">
          <p className="text-[11px] font-mono text-text-muted mb-2">
            ✨ First-time invitee bonus: <strong className="text-brand-green">+5 coins</strong> (one-time only).
          </p>
          <p className="text-[11px] font-mono text-text-muted">
            By joining, you'll be debited <strong className="text-text-primary">{fmtMoney(room?.perMemberStake)}</strong> from your balance (refundable if the group expires).
          </p>
        </div>

        {redeemResult && (
          <div className="border border-brand-green/30 bg-brand-green/5 rounded-lg p-3 mb-3">
            <p className="text-sm font-mono text-brand-green">
              ✓ Joined! Routing to room…
            </p>
            {redeemResult.bonus?.totalBonus ? (
              <p className="text-[11px] font-mono text-text-muted mt-1">
                Bonus: inviter +{redeemResult.bonus.inviterBonus ?? 0}, invitee +{redeemResult.bonus.inviteeBonus ?? 0}
              </p>
            ) : null}
          </div>
        )}

        {authToken ? (
          <button
            onClick={handleRedeem}
            disabled={redeeming}
            className="w-full px-4 py-3 rounded-xl bg-brand-green text-bg-base font-mono font-semibold text-sm hover:bg-brand-green/90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
          >
            {redeeming ? (
              <><Loader2 size={14} className="animate-spin" /> Redeeming…</>
            ) : (
              <>Accept Invite <ArrowRight size={14} /></>
            )}
          </button>
        ) : (
          <Link
            href={`/login?return=/group-bet/join/${encodeURIComponent(token)}`}
            className="w-full px-4 py-3 rounded-xl bg-brand-info text-bg-base font-mono font-semibold text-sm hover:bg-brand-info/90 transition-all flex items-center justify-center gap-2"
          >
            <LogIn size={14} /> Sign in to accept invite
          </Link>
        )}

        <p className="text-[10px] font-mono text-text-muted text-center mt-3">
          Inviter: <span className="text-text-secondary">{preview.creatorUsername ?? preview.creatorId.slice(0, 8)}</span>
          {' · '}
          Redemptions left: {preview.redemptionsLeft} / {preview.maxRedemptions}
        </p>
      </div>
    </main>
  );
}
