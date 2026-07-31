/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET INVITE LANDING — Phase 2 / Day 12
 *  ════════════════════════════════════════════════════════════════
 *
 *  Public-ish page that consumes an invite token and renders the
 *  "You've been invited to play CryptoFlip with @creator!" summary.
 *
 *  Behaviour:
 *    - GET /api/group-bet/invites/:token   → fetch invite summary
 *    - If invalid/expired/exhausted → show reason
 *    - If valid + logged-in → show "Join now" button + auto-trigger
 *      POST /api/group-bet/invites/:token/redeem on click
 *    - If valid + not logged-in → show "Log in to redeem" CTA
 *    - On success → toast + redirect to /group-bet/room/[shortCode]
 *
 *  Route: /group-bet/join/[token]
 *  The token is a 32-char base32 URL-safe string (no dashes).
 * ════════════════════════════════════════════════════════════════
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Users,
  Coins,
  Crown,
  Equal,
  Sparkles,
  Clock,
  CircleDot,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Copy,
  ChevronRight,
} from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

const PAYOUT_ICON: Record<string, any> = {
  equal: Equal,
  proportional: Sparkles,
  founder_boost: Crown,
};
const PAYOUT_LABEL: Record<string, string> = {
  equal: 'Equal split',
  proportional: 'Proportional',
  founder_boost: 'Founder +10%',
};

function fmtMoney(n: number | string): string {
  const v = typeof n === 'string' ? parseFloat(n) : n;
  return isFinite(v) ? v.toFixed(2) : '0.00';
}

export default function GroupInvitePage() {
  const router = useRouter();
  const toast = useToast();
  const params = useParams<{ token: string }>();
  const token = params?.token || '';

  const [invite, setInvite] = useState<any>(null);
  const [room, setRoom] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errMsg, setErrMsg] = useState<string>('');
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [redeemError, setRedeemError] = useState<string>('');
  const [joined, setJoined] = useState<boolean>(false);

  // ── On mount: load invite summary + (if valid) the room's public preview
  useEffect(() => {
    if (!token || !/^[a-z0-9]{8,48}$/.test(token)) {
      setErrMsg('Invalid invite link.');
      setLoading(false);
      return;
    }
    setHasToken(Boolean(getToken()));
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`${API}/group-bet/invites/${token}`);
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !j.success) {
          setErrMsg(j.error || 'Could not load invite');
          return;
        }
        setInvite(j.data);
        if (j.data?.shortCode && j.data?.valid !== false) {
          // Fetch public room preview for richer card
          try {
            const r2 = await fetch(`${API}/group-bet/by-code/${j.data.shortCode}`);
            const j2 = await r2.json();
            if (!cancelled && r2.ok && j2.success) setRoom(j2.data);
          } catch {}
        }
      } catch (e: any) {
        setErrMsg(e?.message || 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // ── On click of "Join now" — POST /api/group-bet/invites/:token/redeem
  const handleJoin = useCallback(async () => {
    const authToken = getToken();
    if (!authToken) {
      // Save current location so login redirects back here
      if (typeof window !== 'undefined') {
        localStorage.setItem('cf_post_login_redirect', window.location.pathname);
      }
      router.push(`/login?redirect=/group-bet/join/${token}`);
      return;
    }
    setRedeeming(true);
    setRedeemError('');
    try {
      const r = await fetch(`${API}/group-bet/invites/${token}/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok || !j.success) {
        setRedeemError(j.error || `HTTP ${r.status}`);
        return;
      }
      const data = j.data;
      toast.addToast(
        `Joined! +${data.inviteeBonus ?? 0} bonus credited${data.totalBonus ? ` (inviter got +${data.inviterBonus})` : ''}.`,
        'success',
      );
      setJoined(true);
      // Redirect to the room after a brief celebratory moment
      setTimeout(() => {
        if (invite?.shortCode) {
          router.push(`/group-bet/room/${invite.shortCode}`);
        }
      }, 1100);
    } catch (e: any) {
      setRedeemError(e?.message ?? 'Network error');
    } finally {
      setRedeeming(false);
    }
  }, [token, invite?.shortCode, router, toast]);

  // ── Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface/50 p-4 text-text-muted">
        <Loader2 size={28} className="animate-spin mb-2" />
        <span className="font-mono text-sm">Loading invite…</span>
      </div>
    );
  }

  // ── Token is invalid or expired/exhausted
  if (errMsg || !invite || invite.valid === false) {
    const reason = invite?.reason || 'NOT_FOUND';
    const title =
      reason === 'EXPIRED' ? 'This invite has expired'
      : reason === 'EXHAUSTED' ? 'This invite is fully redeemed'
      : 'Invite not found';
    const detail =
      reason === 'EXPIRED' ? 'The room owner needs to send a new invite.'
      : reason === 'EXHAUSTED' ? 'No seats left on this invite.'
      : 'The link may be incorrect or the room no longer exists.';
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface/50 p-4">
        <div className="glass-card p-6 max-w-md w-full text-center space-y-3">
          <AlertCircle size={36} className="mx-auto text-amber-400" />
          <h1 className="text-xl font-bold text-text-primary">{title}</h1>
          <p className="text-text-muted text-sm">{detail}</p>
          <Link href="/group-bet/lobby" className="inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-brand-green/60 bg-brand-green/10 text-brand-green">
            Browse lobby <ChevronRight size={14} />
          </Link>
        </div>
      </div>
    );
  }

  // ── Valid invite — render the summary card
  const expiry = invite.expiresAt ? new Date(invite.expiresAt) : null;
  const expMins = expiry ? Math.max(0, Math.floor((expiry.getTime() - Date.now()) / 60000)) : null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface/50 p-4">
      <div className="max-w-md w-full">
        {/* Header / brand */}
        <div className="text-center mb-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-green/10 border border-brand-green/40 text-brand-green text-xs uppercase tracking-widest font-mono">
            <Users size={14} />
            Group Bet invite
          </div>
        </div>

        {/* Room summary card */}
        <div className="glass-card p-5 mb-3">
          <div className="flex items-center gap-2 mb-2">
            <CircleDot size={16} className="text-brand-green" />
            <span className="font-mono font-bold text-text-primary">{invite.shortCode ?? room?.shortCode ?? '—'}</span>
            {room && (
              <span className="text-[10px] uppercase tracking-widest font-mono text-text-muted">
                {room.status}
              </span>
            )}
          </div>

          {room ? (
            <div className="space-y-2 mb-3">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = PAYOUT_ICON[room.payoutMode] || Equal;
                  return (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded border border-brand-info/30 text-brand-info text-[10px] uppercase tracking-widest font-mono">
                      <Icon size={10} />
                      {PAYOUT_LABEL[room.payoutMode] || room.payoutMode}
                    </span>
                  );
                })()}
              </div>
              <div className="flex items-baseline gap-2">
                <Coins size={16} className="text-brand-green" />
                <span className="font-bold text-text-primary text-lg">{fmtMoney(room.totalPool)}</span>
                <span className="text-xs text-text-muted">pool · {fmtMoney(room.perMemberStake)}/seat</span>
              </div>
              <div className="flex items-center justify-between text-xs text-text-muted">
                <span className="font-mono">
                  {room.currentMembers}/{room.maxMembers} joined
                </span>
                {expMins != null && expMins > 0 && (
                  <span className="font-mono inline-flex items-center gap-1">
                    <Clock size={10} />
                    {expMins}m left
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="text-text-muted text-xs font-mono mb-3">Room preview unavailable.</div>
          )}

          {/* reason EXPIRED/EXHAUSTED was already handled by the early-return above */}
        </div>

        {/* CTA panel */}
        {joined ? (
          <div className="glass-card p-4 text-center border-brand-green/40">
            <CheckCircle2 size={32} className="mx-auto text-brand-green mb-2" />
            <h2 className="text-text-primary font-bold mb-1">Joined! Bringing you in…</h2>
            <p className="text-text-muted text-xs">
              Your bonus has been credited (if admin enabled it).{room ? '' : ''}
            </p>
          </div>
        ) : hasToken ? (
          <button
            type="button"
            onClick={handleJoin}
            disabled={redeeming}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-brand-green/60 bg-brand-green text-surface font-bold hover:bg-brand-green/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {redeeming ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
            {redeeming ? 'Joining…' : 'Join now & accept invite'}
          </button>
        ) : (
          <div className="glass-card p-4 text-center">
            <p className="text-text-secondary text-sm mb-3">
              Log in to join this group.
            </p>
            <Link
              href={`/login?redirect=/group-bet/join/${token}`}
              className="inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-brand-green/60 bg-brand-green/10 text-brand-green font-bold"
            >
              Log in to join
              <ChevronRight size={14} />
            </Link>
          </div>
        )}

        {/* Error message after failed redeem */}
        {redeemError && (
          <div className="glass-card p-3 mt-3 border-rose-500/40 text-rose-400 text-xs">
            <AlertCircle size={14} className="inline mr-1" />
            {redeemError}
          </div>
        )}

        <p className="text-center text-[10px] text-text-muted font-mono mt-3">
          Don't share this invite beyond your friends — each redemption seat is one-of-a-kind.
        </p>
      </div>
    </div>
  );
}
