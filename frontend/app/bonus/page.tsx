'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  USER BONUS PAGE — Active bonuses, progress & opt-in campaigns
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useCallback } from 'react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import { Gift, Clock, ArrowRight, TrendingUp, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

interface Claim {
  id: string;
  bonus_type: string;
  amount_coins: number;
  wagering_required: number;
  wagering_completed: number;
  status: 'active' | 'completed' | 'expired' | 'forfeited';
  expires_at: string;
}

interface StatusSummary {
  totalActive: number;
  totalCompleted: number;
  totalExpired: number;
  bonusBalanceCoins: number;
  withdrawableBalanceCoins: number;
  wageringRequiredCoins: number;
  wageringCompletedCoins: number;
  wageringPercentComplete: number;
  totalBonusClaimedCoins: number;
  totalDepositedCoins: number;
  canWithdrawNow: boolean;
  blockedReasons: string[];
  activeClaims: Claim[];
}

interface Campaign {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  bonus_type: string;
  amount_coins: number | null;
  percent: number | null;
  max_amount_coins: number | null;
  wagering_multiplier: number;
  requires_opt_in: boolean;
  expires_after_hours: number;
}

const TYPE_LABELS: Record<string, string> = {
  welcome: 'Welcome Bonus',
  deposit_match: 'Deposit Match',
  cashback: 'Cashback',
  free_spin: 'Free Spins',
  reload: 'Reload',
  vip_tier: 'VIP Reward',
  tournament: 'Tournament Prize',
  loss_back: 'Loss Back',
  manual: 'Reward',
  affiliate_reward: 'Affiliate Reward',
  rain: 'Rain Bonus',
};

export default function BonusPage() {
  const { token } = useGameStore();
  const { t } = useTranslation();
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [history, setHistory] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const fetchAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [me, camps, hist] = await Promise.all([
        api.get('/api/bonus/me', token),
        api.get('/api/bonus/campaigns', token),
        api.get('/api/bonus/me/history', token),
      ]);
      if (me.success) setStatus(me.status as StatusSummary);
      if (camps.success) setCampaigns(camps.campaigns as Campaign[]);
      if (hist.success) setHistory(hist.history as Claim[]);
    } catch (err) {
      setNotice({ message: 'Failed to load bonuses', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const claimCampaign = async (id: string) => {
    if (!token || claiming) return;
    setClaiming(id);
    setNotice(null);
    try {
      const data = await api.post(`/api/bonus/${id}/claim`, token, {});
      if (data.success) {
        setNotice({ message: 'Bonus claimed!', type: 'success' });
        await fetchAll();
      } else {
        setNotice({ message: data.error || 'Claim failed', type: 'error' });
      }
    } catch (err) {
      setNotice({ message: 'Network error', type: 'error' });
    } finally {
      setClaiming(null);
    }
  };

  const active = status?.activeClaims ?? [];
  const available = campaigns.filter((c) => c.requires_opt_in);

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-11 h-11 rounded-xl bg-brand-green/10 border border-brand-green/25 flex items-center justify-center text-brand-green">
          <Gift size={20} />
        </div>
        <div>
          <h1 className="heading-display text-xl text-text-primary">My Bonuses</h1>
          <p className="text-text-muted text-xs font-mono">Track rewards & wagering progress</p>
        </div>
      </div>

      {notice && (
        <div className={`mb-4 p-3 rounded-xl text-xs font-mono border flex items-center gap-2 ${notice.type === 'success' ? 'bg-brand-green/10 text-brand-green border-brand-green/20' : 'bg-brand-red/10 text-brand-red border-brand-red/20'}`}>
          {notice.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {notice.message}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-brand-gold" size={28} />
        </div>
      )}

      {!loading && status && (
        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <div className="bg-surface border border-border rounded-xl p-4">
            <div className="text-text-muted text-xs font-mono flex items-center gap-1 mb-1">
              <TrendingUp size={12} /> Bonus Balance
            </div>
            <div className="text-2xl font-bold text-text-primary">
              ${status.bonusBalanceCoins.toFixed(2)}
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4">
            <div className="text-text-muted text-xs font-mono flex items-center gap-1 mb-1">
              <CheckCircle2 size={12} /> Wagering Progress
            </div>
            <div className="text-2xl font-bold text-text-primary">
              {status.wageringPercentComplete.toFixed(0)}%
            </div>
            <div className="text-xs text-text-muted font-mono">
              ${status.wageringCompletedCoins.toFixed(2)} / ${status.wageringRequiredCoins.toFixed(2)}
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4">
            <div className="text-text-muted text-xs font-mono flex items-center gap-1 mb-1">
              <Clock size={12} /> Active / Total
            </div>
            <div className="text-2xl font-bold text-text-primary">
              {status.totalActive} / {active.length + status.totalCompleted + status.totalExpired}
            </div>
          </div>
        </div>
      )}

      {!loading && status?.blockedReasons && status.blockedReasons.length > 0 && (
        <div className="bg-brand-red/10 border border-brand-red/20 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 text-brand-red text-sm font-bold font-mono mb-2">
            <AlertCircle size={14} /> Withdrawal Blocked
          </div>
          <ul className="list-disc list-inside text-xs text-text-secondary font-mono">
            {status.blockedReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Active bonuses */}
      <section className="mb-8">
        <h2 className="heading-display text-lg text-text-primary mb-3">Active Bonuses</h2>
        {active.length === 0 ? (
          <div className="text-text-muted text-sm font-mono bg-surface border border-border rounded-xl p-4">
            No active bonuses. Opt into a campaign below or enter a promo code in the game.
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((c) => (
              <div key={c.id} className="bg-surface border border-border rounded-xl p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-xs font-mono text-brand-gold">{TYPE_LABELS[c.bonus_type] || c.bonus_type}</div>
                    <div className="text-text-primary font-semibold">${c.amount_coins.toFixed(2)}</div>
                  </div>
                  <div className="text-right text-xs font-mono text-text-muted">
                    <div className="flex items-center gap-1">
                      <Clock size={12} /> Expires {new Date(c.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="w-full bg-void rounded-full h-2 mb-1">
                  <div
                    className="bg-brand-green h-2 rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, status ? (c.wagering_completed / c.wagering_required) * 100 : 0)}%`,
                    }}
                  />
                </div>
                <div className="text-xs font-mono text-text-muted">
                  Wagered ${c.wagering_completed.toFixed(2)} / ${c.wagering_required.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Available campaigns */}
      <section className="mb-8">
        <h2 className="heading-display text-lg text-text-primary mb-3">Available Campaigns</h2>
        {available.length === 0 ? (
          <div className="text-text-muted text-sm font-mono bg-surface border border-border rounded-xl p-4">
            No opt-in campaigns right now. Check back soon!
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {available.map((c) => (
              <div key={c.id} className="bg-surface border border-border rounded-xl p-4 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-mono text-brand-gold">{TYPE_LABELS[c.bonus_type] || c.bonus_type}</div>
                  <div className="text-text-primary font-semibold">{c.name}</div>
                  <p className="text-text-muted text-xs mt-1 line-clamp-2">{c.description || 'No description'}</p>
                  <div className="text-xs font-mono text-text-secondary mt-2">
                    {c.amount_coins ? `$${c.amount_coins.toFixed(2)}` : c.percent ? `${c.percent}%` : 'Bonus'} — wager {c.wagering_multiplier}x
                  </div>
                </div>
                <button
                  onClick={() => claimCampaign(c.id)}
                  disabled={claiming === c.id}
                  className="mt-3 w-full py-2 bg-brand-maroon text-white rounded-lg text-xs font-mono hover:bg-brand-maroon/90 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {claiming === c.id ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                  Claim Bonus
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* History */}
      <section>
        <h2 className="heading-display text-lg text-text-primary mb-3">Bonus History</h2>
        {history.length === 0 ? (
          <div className="text-text-muted text-sm font-mono bg-surface border border-border rounded-xl p-4">
            No bonus history yet.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between p-3 border-b border-border last:border-0 text-sm">
                <div>
                  <div className="text-text-primary font-medium">{TYPE_LABELS[h.bonus_type] || h.bonus_type}</div>
                  <div className={`text-xs font-mono capitalize ${h.status === 'active' ? 'text-brand-green' : h.status === 'expired' ? 'text-brand-red' : 'text-text-muted'}`}>
                    {h.status}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-text-primary font-mono">${h.amount_coins.toFixed(2)}</div>
                  <div className="text-xs text-text-muted font-mono">{new Date(h.expires_at).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
