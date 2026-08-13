'use client';
/**
 * ===============================================================
 *  USER DASHBOARD PAGE \u2014 Complete player dashboard
 * ===============================================================
 *
 *  PR-1B: auth rides on the httpOnly cf_token cookie. No need to
 *  pass userId in the URL or decode the JWT client-side. The
 *  backend authMiddleware derives user identity from the cookie.
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
import RecentQrDeposits from '@/components/dashboard/RecentQrDeposits';
import { useTranslation } from '@/hooks/useTranslation';
import { apiGet } from '@/lib/api';

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats,   setStats]   = useState<any>(null);
  const [chart,   setChart]   = useState([]);
  const [history, setHistory] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [kycStatus, setKycStatus] = useState<'unverified' | 'pending' | 'verified' | 'rejected'>('unverified');
  const [loading, setLoading] = useState(true);

  // PR-1B: apiGet() attaches the httpOnly cookie via credentials:'include'.
  // The backend derives userId from the cookie \u2014 no need to pass it
  // in the URL.
  async function loadAll(page = 1) {
    setLoading(true);
    try {
      const [statsRes, chartRes, histRes, kycRes, wheelRes] = await Promise.all([
        apiGet('/api/dashboard/stats'),
        apiGet('/api/dashboard/chart?days=30'),
        apiGet(`/api/dashboard/history?page=${page}&limit=15`),
        apiGet('/api/kyc/status'),
        apiGet('/api/dashboard/wheel'),
      ]);

      const [s, c, h, k, w] = await Promise.all([
        statsRes.json(),
        chartRes.json(),
        histRes.json(),
        kycRes.json(),
        wheelRes.json(),
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
      // API not connected \u2014 demo mode
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

        {/* Daily wheel \u2014 PR-1B: removed token prop (cookie auth now) */}
        <DailyWheelCard wheel={stats?.wheel} onSpin={loadStats} />

        {/* Rakeback \u2014 PR-1B: removed token prop */}
        <RakebackCard onClaim={loadStats} />

        {/* Daily Challenges \u2014 PR-1B: removed token prop */}
        <ChallengesCard onClaim={loadStats} />

        {/* Leaderboard \u2014 PR-1B: removed token prop */}
        <LeaderboardCard />

        {/* Achievements */}
        <AchievementsGrid achievements={stats?.achievements} />

        {/* Stats cards */}
        <StatsCards stats={stats} loading={loading} />

        {/* Quick wallet actions */}
        <div className="grid grid-cols-2 gap-3">
          <Link href="/wallet/deposit" className="glass-card p-4 rounded-xl hover:bg-bg-elevated/30 transition flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-green/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-brand-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </div>
            <div>
              <div className="text-text-primary font-mono text-sm font-bold">Deposit</div>
              <div className="text-text-muted text-[10px] font-mono">Top up via QR</div>
            </div>
          </Link>
          <Link href="/wallet/withdraw" className="glass-card p-4 rounded-xl hover:bg-bg-elevated/30 transition flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
            </div>
            <div>
              <div className="text-text-primary font-mono text-sm font-bold">Withdraw</div>
              <div className="text-text-muted text-[10px] font-mono">Send to external wallet</div>
            </div>
          </Link>
        </div>

        <RecentQrDeposits />

        {/* Transaction history link */}
        <Link href="/wallet/transactions" className="glass-card p-4 rounded-xl hover:bg-bg-elevated/30 transition flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
          </div>
          <div className="flex-1">
            <div className="text-text-primary font-mono text-sm font-bold">Transaction history</div>
            <div className="text-text-muted text-[10px] font-mono">All deposits, withdrawals, bets</div>
          </div>
          <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        </Link>

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
