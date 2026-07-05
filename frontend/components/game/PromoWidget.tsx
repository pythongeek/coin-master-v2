'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  PROMO WIDGET — Promo Codes + Admin Campaign Bonuses
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { Gift, Sparkles, AlertCircle, Loader2, CheckCircle2, Award } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { trackEvent } from '@/utils/analytics';
import { useTranslation } from '@/hooks/useTranslation';
import { api } from '@/lib/api';

interface Campaign {
  id: string;
  code: string | null;
  name: string;
  bonus_type: string;
  amount_coins: number | null;
  percent: number | null;
  max_amount_coins: number | null;
  wagering_multiplier: number;
  requires_opt_in: boolean;
  badge_color: string | null;
}

interface ActivePromo {
  code: string;
  value: number;
  max_bonus_amount: number;
}

export default function PromoWidget() {
  const { user, token, updateBalance } = useGameStore();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimingCampaign, setClaimingCampaign] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeMatch, setActiveMatch] = useState<ActivePromo | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const fetchPromo = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [promoRes, campRes] = await Promise.all([
        fetch(`${API}/wallet/promo/active`, { headers: { Authorization: `Bearer ${token}` } }),
        api.get('/api/bonus/campaigns', token),
      ]);
      const promoData = await promoRes.json();
      if (promoData.success && promoData.activePromo) {
        setActiveMatch({
          code: promoData.activePromo.code,
          value: parseFloat(promoData.activePromo.value),
          max_bonus_amount: parseFloat(promoData.activePromo.max_bonus_amount),
        });
      } else {
        setActiveMatch(null);
      }
      if (campRes.success) setCampaigns(campRes.campaigns || []);
    } catch (err) {
      console.error('Promo fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && token) {
      fetchPromo();
    }
  }, [expanded, token]);

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !code.trim() || claiming) return;
    setClaiming(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`${API}/wallet/promo/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMsg(data.message);
        setCode('');
        trackEvent('promo_claim_success', { code, type: data.type });
        if (data.type === 'no_deposit') updateBalance(data.newBalance);
        else fetchPromo();
      } else {
        setError(data.error || t('promoClaimFailed'));
        trackEvent('promo_claim_failed', { code, error: data.error || 'API Error' });
      }
    } catch (err) {
      setError(t('serverError'));
    } finally {
      setClaiming(false);
    }
  };

  const claimCampaign = async (id: string) => {
    if (!token || claimingCampaign) return;
    setClaimingCampaign(id);
    setError(null);
    setSuccessMsg(null);
    try {
      const data = await api.post(`/api/bonus/${id}/claim`, token, {});
      if (data.success) {
        setSuccessMsg(`Bonus claimed: ${data.claim?.amountCoins ?? 0} coins`);
        trackEvent('campaign_claim_success', { campaignId: id });
        await fetchPromo();
      } else {
        setError(data.error || 'Claim failed');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setClaimingCampaign(null);
    }
  };

  if (!user) return null;

  const visibleCampaigns = campaigns.filter((c) => c.requires_opt_in);

  return (
    <div className="glass-card border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-green/10 flex items-center justify-center text-brand-green">
            <Gift size={16} />
          </div>
          <div className="text-left">
            <div className="heading-display text-sm text-brand-green">{t('promoTitle')}</div>
            <div className="text-text-muted text-xs font-mono">{t('promoSubtitle')}</div>
          </div>
        </div>
      </div>
      <div className="p-4 space-y-4">
          <form onSubmit={handleClaim} className="space-y-3">
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">{t('enterCode')}</label>
              <div className="flex gap-2">
                <input
                  className="input-cyber text-xs bg-[#090D16] border-border uppercase font-mono tracking-wider"
                  placeholder="e.g. WELCOME10"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={claiming}
                />
                <button
                  type="submit"
                  disabled={claiming || !code.trim()}
                  className="px-4 py-2.5 bg-brand-green text-void rounded-lg hover:bg-brand-green/85 transition-colors flex items-center justify-center gap-1.5 text-xs font-bold font-mono disabled:opacity-40"
                >
                  {claiming ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {claiming ? t('claiming') : t('claimBtn')}
                </button>
              </div>
            </div>
          </form>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-brand-red/10 border border-brand-red/20 rounded-lg text-brand-red text-xs font-mono">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          {successMsg && (
            <div className="flex items-center gap-2 p-3 bg-brand-green/10 border border-brand-green/20 rounded-lg text-brand-green text-xs font-mono">
              <CheckCircle2 size={14} className="shrink-0" />
              {successMsg}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="animate-spin text-brand-green" size={16} />
            </div>
          )}

          {activeMatch && (
            <div className="relative overflow-hidden bg-gradient-to-r from-brand-green/15 to-void border border-brand-green/30 rounded-xl p-4 space-y-1">
              <div className="absolute top-0 right-0 p-2 opacity-15">
                <Award size={64} className="text-brand-green" />
              </div>
              <div className="flex items-center gap-1.5 text-brand-green text-xs font-bold font-mono">
                <Sparkles size={12} /> {t('activePromo')}
              </div>
              <div className="text-base font-display font-black text-white mt-1 font-mono tracking-wider">{activeMatch.code}</div>
              <p className="text-xs text-text-secondary leading-relaxed font-mono">
                {t('multiplier')}: {(activeMatch.value * 100).toFixed(0)}% | {t('maxBonus')}: ${activeMatch.max_bonus_amount.toFixed(0)}
              </p>
            </div>
          )}

          {visibleCampaigns.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-mono text-text-secondary font-bold">Available Bonuses</div>
              {visibleCampaigns.map((c) => (
                <div key={c.id} className="bg-void/50 border border-border/50 rounded-lg p-3 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="text-sm text-text-primary font-semibold">{c.name}</div>
                    <div className="text-xs font-mono text-text-muted">
                      {c.amount_coins ? `$${c.amount_coins.toFixed(2)}` : c.percent ? `${c.percent}%` : 'Bonus'} — wager {c.wagering_multiplier}x
                    </div>
                  </div>
                  <button
                    onClick={() => claimCampaign(c.id)}
                    disabled={claimingCampaign === c.id}
                    className="px-3 py-1.5 bg-brand-maroon text-white rounded-lg text-xs font-mono hover:bg-brand-maroon/90 disabled:opacity-40"
                  >
                    {claimingCampaign === c.id ? <Loader2 size={12} className="animate-spin" /> : 'Claim'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="text-[11px] font-mono text-text-muted leading-relaxed bg-void/50 p-3 rounded-lg border border-border/50">
            <p className="font-bold text-text-secondary mb-1">💡 {t('promoSubtitle')}</p>
            <p className="mb-0.5">• <strong>WELCOME10:</strong> $10.00 FREE</p>
            <p>• <strong>MATCH100:</strong> 100% Match Bonus</p>
          </div>
        </div>
    </div>
  );
}
