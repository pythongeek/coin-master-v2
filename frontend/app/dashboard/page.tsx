'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  USER DASHBOARD PAGE — Complete player dashboard
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { BarChart3, Gamepad2, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import StatsCards from '@/components/dashboard/StatsCards';
import ProfitChart from '@/components/dashboard/ProfitChart';
import BetHistory from '@/components/dashboard/BetHistory';
import { VipProgressCard } from '@/components/dashboard/VipProgressCard';
import { AchievementsGrid } from '@/components/dashboard/AchievementsGrid';
import { DailyWheelCard } from '@/components/dashboard/DailyWheelCard';
import { LeaderboardCard } from '@/components/dashboard/LeaderboardCard';
import { RakebackCard } from '@/components/dashboard/RakebackCard';
import { ChallengesCard } from '@/components/dashboard/ChallengesCard';
import { useTranslation } from '@/hooks/useTranslation';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats,   setStats]   = useState<any>(null);
  const [chart,   setChart]   = useState([]);
  const [history, setHistory] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [kycStatus, setKycStatus] = useState<'unverified' | 'pending' | 'verified' | 'rejected'>('unverified');
  const [loading, setLoading] = useState(true);

  const token = typeof window !== 'undefined'
    ? localStorage.getItem('cf_token') || ''
    : '';

  const headers = { Authorization: `Bearer ${token}` };

  // Decode the JWT to get the real userId. Falls back to demo only if
  // no token is present (unauthenticated). Never trust localStorage for
  // admin flags — the backend validates every request.
  function decodeUserId(jwt: string): string {
    if (!jwt) return 'demo';
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1]));
      return payload.userId || payload.sub || 'demo';
    } catch {
      return 'demo';
    }
  }
  const userId = decodeUserId(token);

  async function loadAll(page = 1) {
    setLoading(true);
    try {
      const [statsRes, chartRes, histRes, kycRes, wheelRes] = await Promise.all([
        fetch(`${API}/dashboard/stats/${userId}`,    { headers }),
        fetch(`${API}/dashboard/chart/${userId}?days=30`, { headers }),
        fetch(`${API}/dashboard/history/${userId}?page=${page}&limit=15`, { headers }),
        fetch(`${API}/kyc/status`, { headers }),
        fetch(`${API}/dashboard/wheel`, { headers }),
      ]);

      const [s, c, h, k, w] = await Promise.all([
        statsRes.json(),
        chartRes.json(),
        histRes.json(),
        kycRes.json(),
        wheelRes.json()
      ]);

      if (s.success) {
        const data = s.data;
        if (w.success) data.wheel = w.data;
        setStats(data);
      }
      if (c.success) setChart(c.data);
      if (h.success) {
        setHistory(h.data);
        setPagination({ page, totalPages: h.pagination.totalPages });
      }
      if (k.success) {
        setKycStatus(k.kycStatus);
      }
    } catch {
      // API not connected — demo mode
    }
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  const loadStats = () => loadAll(pagination.page);

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-info/10 border border-brand-info/25
                          flex items-center justify-center text-brand-info">
            <BarChart3 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="heading-display text-xl text-text-primary">My Dashboard</h1>
              {kycStatus === 'verified' && (
                <span className="flex items-center gap-1 text-[10px] font-mono text-brand-green bg-brand-green/10 border border-brand-green/20 px-2 py-0.5 rounded-full">
                  <ShieldCheck size={10} />
                  Verified
                </span>
              )}
            </div>
            <p className="text-text-muted text-xs font-mono mt-0.5">Your complete gaming statistics</p>
          </div>
        </div>
        <Link href="/game" className="btn-brand flex items-center gap-1.5 text-sm py-2 px-4">
          <Gamepad2 size={15} />
          Play Now
        </Link>
      </div>

      {/* KYC Alert Banners */}
      {!loading && kycStatus !== 'verified' && (
        <div className={`mb-6 p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
          kycStatus === 'unverified'
            ? 'border-brand-gold/30 bg-brand-gold/5 text-brand-gold'
            : kycStatus === 'pending'
            ? 'border-brand-info/30 bg-brand-info/5 text-brand-info'
            : 'border-brand-red/30 bg-brand-red/5 text-brand-red'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              kycStatus === 'unverified'
                ? 'bg-brand-gold/10'
                : kycStatus === 'pending'
                ? 'bg-brand-info/10 animate-pulse'
                : 'bg-brand-red/10'
            }`}>
              {kycStatus === 'pending' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <AlertTriangle size={16} />
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-text-primary">
                {kycStatus === 'unverified' && 'KYC verification required'}
                {kycStatus === 'pending' && 'Your verification is in progress'}
                {kycStatus === 'rejected' && 'Verification was rejected'}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">
                {kycStatus === 'unverified' && 'Verify your identity to enable secure crypto withdrawals.'}
                {kycStatus === 'pending' && 'Our security team is reviewing your documents. This usually takes 2-5 minutes.'}
                {kycStatus === 'rejected' && 'Your documents did not meet policy requirements. Please try again with correct info.'}
              </p>
            </div>
          </div>
          {kycStatus !== 'pending' && (
            <Link
              href="/kyc"
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-surface hover:bg-surface2 border border-border text-text-primary hover:text-brand-green transition-all self-start sm:self-center font-mono"
            >
              Verify Now
            </Link>
          )}
        </div>
      )}

      <div className="space-y-5">
        {/* VIP progress */}
        <VipProgressCard vip={stats?.vip} totalWagered={stats?.totalWagered || 0} />

        {/* Daily wheel */}
        <DailyWheelCard wheel={stats?.wheel} token={token} onSpin={loadStats} />

        {/* Rakeback */}
        <RakebackCard token={token} onClaim={loadStats} />

        {/* Daily Challenges */}
        <ChallengesCard token={token} onClaim={loadStats} />

        {/* Leaderboard */}
        <LeaderboardCard token={token} />

        {/* Achievements */}
        <AchievementsGrid achievements={stats?.achievements} />

        {/* Stats cards */}
        <StatsCards stats={stats} loading={loading} />

        {/* P&L chart */}
        <ProfitChart data={chart} loading={loading} />

        {/* Bet history */}
        <BetHistory
          history={history}
          loading={loading}
          page={pagination.page}
          totalPages={pagination.totalPages}
          onPageChange={(p) => loadAll(p)}
        />
      </div>
    </main>
  );
}
