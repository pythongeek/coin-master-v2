'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  X,
  Copy,
  Check,
  Link as LinkIcon,
  QrCode,
  Coins,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

interface InviteInfo {
  valid: boolean;
  reason?: string;
  token?: string;
  url?: string;
  qrDataUrl?: string;
  shortCode?: string;
  maxRedemptions?: number;
  redeemedCount?: number;
  expiresAt?: string;
  groupId?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  roomId: string;
  roomShortCode: string;
  api?: string;
  authed?: boolean;
}

const DEFAULT_API =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) || '';

export function GroupShareModal({
  open,
  onClose,
  roomId,
  roomShortCode,
  api = DEFAULT_API,
  authed = true,
}: Props) {
  const toast = useToast();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errMsg, setErrMsg] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [recentChannel, setRecentChannel] = useState<string>('');
  const [linkedCopied, setLinkedCopied] = useState<boolean>(false);
  const [busyRedeem, setBusyRedeem] = useState<boolean>(false);
  const [redeemResult, setRedeemResult] = useState<{
    inviterBonus: number;
    inviteeBonus: number;
    joinResult: any;
  } | null>(null);

  const shareUrl = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/group-bet/room/${roomShortCode}`;
  }, [roomShortCode]);

  // ── 1. On open: request a fresh invite token from the backend
  // (or fall back to the deterministic short-code URL if unauthorized)
  useEffect(() => {
    if (!open) return;
    setErrMsg('');
    setInvite(null);
    setRedeemResult(null);
    setCopied(false);
    setRecentChannel('');
    setLinkedCopied(false);

    if (!authed) {
      setInvite({ valid: true, url: shareUrl, shortCode: roomShortCode });
      return;
    }

    const token = getToken();
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r1 = await fetch(`${api}/group-bet/${roomId}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j1 = await r1.json();
        if (cancelled) return;
        if (!r1.ok || !j1.success) {
          setErrMsg(j1.error || 'Could not generate invite');
          return;
        }
        const tokenStr: string = j1.data.token;
        const r2 = await fetch(`${api}/group-bet/invites/${tokenStr}`);
        const j2 = await r2.json();
        if (cancelled) return;
        if (!r2.ok || !j2.success) {
          setErrMsg(j2.error || 'Could not resolve invite');
          return;
        }
        const info: InviteInfo = {
          valid: j2.data.valid === true,
          token: tokenStr,
          url: shareUrl,
          qrDataUrl: j2.data.qrDataUrl,
          shortCode: roomShortCode,
          maxRedemptions: j2.data.maxRedemptions,
          redeemedCount: j2.data.redeemedCount,
          expiresAt: j2.data.expiresAt,
          groupId: roomId,
        };
        setInvite(info);
      } catch (e: any) {
        setErrMsg(e?.message || 'unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, roomId, roomShortCode, api, authed, shareUrl]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.addToast(`${label} copied to clipboard`, 'success');
      setCopied(true);
      setLinkedCopied(label === 'Invite link');
      setTimeout(() => { setCopied(false); setLinkedCopied(false); }, 2000);
    } catch {
      toast.addToast('Copy failed - please copy from the link field', 'error');
    }
  }, [toast]);

  const handleShareChannel = useCallback(async (channel: 'whatsapp' | 'telegram' | 'twitter' | 'email' | 'copy' | 'qr' | 'link') => {
    if (!invite?.token) return;
    const token = getToken();
    if (!token) {
      toast.addToast('Please log in to track your share', 'error');
      return;
    }
    setRecentChannel(channel);
    try {
      const message = `Join my CryptoFlip group room "${invite.shortCode}" - I'll get a bonus when you join!\n` + (invite.url ?? '');
      const targets: Record<string, () => void> = {
        whatsapp: () => window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank'),
        telegram: () => window.open(`https://t.me/share/url?url=${encodeURIComponent(invite.url ?? '')}&text=${encodeURIComponent(message)}`, '_blank'),
        twitter: () => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`, '_blank'),
        email: () => window.location.href = `mailto:?subject=CryptoFlip Group Room&body=${encodeURIComponent(message)}`,
        copy: () => invite.url && handleCopy(invite.url, 'Invite link'),
        qr: () => toast.addToast('Show your friend the QR code above', 'info'),
        link: () => invite.url && handleCopy(invite.url, 'Invite link'),
      };
      targets[channel]?.();

      await fetch(`${api}/group-bet/${roomId}/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      }).catch(() => {});
    } catch (e: any) {
      toast.addToast(`Share failed: ${e?.message ?? 'unknown'}`, 'error');
    }
  }, [invite?.token, invite?.url, invite?.shortCode, roomId, api, toast, handleCopy]);

  // ── 2. Open a separate tab with the invite-join landing page so the
  // invitee can accept the invite and redeem the bonus.
  const handleOpenJoinPage = useCallback(() => {
    if (!invite?.token) return;
    window.open(`/group-bet/join/${invite.token}`, '_blank');
  }, [invite?.token]);

  // ── 3. Dev-only: force a redeem on your own invite to prove the wire.
  // In production the invitee redeems via the /group-bet/join/:token page.
  const handleSelfTestRedeem = useCallback(async () => {
    if (!invite?.token) return;
    setBusyRedeem(true);
    try {
      const r = await fetch(`${api}/group-bet/invites/${invite.token}/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok || !j.success) {
        toast.addToast(j.error || 'redeem failed', 'error');
        return;
      }
      setRedeemResult({
        inviterBonus: j.data.inviterBonus ?? 0,
        inviteeBonus: j.data.inviteeBonus ?? 0,
        joinResult: j.data.joinResult,
      });
      toast.addToast('Self-test redeem succeeded', 'success');
    } catch (e: any) {
      toast.addToast(e?.message ?? 'Redeem failed', 'error');
    } finally {
      setBusyRedeem(false);
    }
  }, [invite?.token, api, toast]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-card p-5 w-full max-w-md" role="dialog" aria-label="Group share">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <QrCode size={18} className="text-brand-green" />
            Share & invite
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-surface/50">
            <X size={16} />
          </button>
        </div>

        {/* invite URL display */}
        <div className="mb-3">
          <label className="text-xs uppercase tracking-widest font-mono text-text-muted">Invite link</label>
          <div className="flex items-center gap-2 mt-1">
            <div
              className="flex-1 truncate bg-surface/60 border border-border rounded-lg px-2 py-2 text-sm font-mono text-text-primary"
              title={invite?.url ?? shareUrl}
            >
              {invite?.url ?? shareUrl}
            </div>
            <button
              type="button"
              onClick={() => invite?.url && handleCopy(invite.url, 'Invite link')}
              disabled={!invite?.url}
              className="flex items-center gap-1 px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-30"
              title="Copy invite link"
            >
              {copied && linkedCopied ? <Check size={14} className="text-brand-green" /> : <Copy size={14} />}
            </button>
          </div>
        </div>

        {/* QR code */}
        {invite?.qrDataUrl ? (
          <div className="flex flex-col items-center mb-3">
            <div className="bg-white p-1.5 rounded-lg shadow-sm">
              <img src={invite.qrDataUrl} alt="Invite QR" width={160} height={160} className="block" />
            </div>
            <span className="text-[10px] font-mono text-text-muted mt-1">scan to open</span>
          </div>
        ) : invite && !authed ? (
          <div className="text-xs text-text-muted text-center mb-3">Login to generate a unique QR code.</div>
        ) : (
          <div className="flex items-center justify-center mb-3 text-text-muted">
            {loading ? <Loader2 size={20} className="animate-spin" /> : <QrCode size={20} className="opacity-30" />}
          </div>
        )}

        {/* warning / info */}
        {errMsg && (
          <div className="border border-rose-500/40 bg-rose-500/10 text-rose-400 rounded-lg p-2 mb-3 text-xs flex items-center gap-2">
            <AlertCircle size={14} />
            {errMsg}
          </div>
        )}

        {/* share channels grid */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {(['whatsapp', 'telegram', 'twitter', 'email', 'copy', 'qr'] as const).map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => handleShareChannel(ch)}
              disabled={!invite?.url}
              className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-mono uppercase tracking-widest transition disabled:opacity-40 ${
                recentChannel === ch
                  ? 'border-brand-green/60 bg-brand-green/10 text-brand-green'
                  : 'border-border text-text-secondary hover:bg-surface/50'
              }`}
            >
              {recentChannel === ch && ch === 'copy' ? <Check size={12} /> : null}
              {ch}
            </button>
          ))}
        </div>

        {/* secondary actions */}
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <button
            type="button"
            onClick={handleOpenJoinPage}
            disabled={!invite?.token}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface/50 disabled:opacity-40"
          >
            <LinkIcon size={12} />
            Open join page
          </button>
          {process.env.NODE_ENV === 'development' && (
            <button
              type="button"
              onClick={handleSelfTestRedeem}
              disabled={busyRedeem || !invite?.token}
              className="text-[10px] uppercase tracking-widest font-mono text-amber-400 hover:text-amber-300 disabled:opacity-40"
              title="Dev-only - forces redemption on your own invite"
            >
              {busyRedeem ? 'testing...' : 'self-test redeem'}
            </button>
          )}
        </div>

        {/* self-test result (dev only) */}
        {redeemResult && (
          <div className="mt-3 border border-text-muted/30 rounded-lg p-2 text-xs text-text-secondary font-mono">
            <div>inviterBonus: {redeemResult.inviterBonus}</div>
            <div>inviteeBonus: {redeemResult.inviteeBonus}</div>
            <div>groupId: {redeemResult.joinResult?.groupId}</div>
            <div>role: {redeemResult.joinResult?.role}</div>
            <div>stake: {redeemResult.joinResult?.stake}</div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full px-3 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary text-sm"
        >
          Done
        </button>
      </div>
    </div>
  );
}

export default GroupShareModal;
