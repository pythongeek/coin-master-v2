'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  USER DASHBOARD PAGE — ইউজারের সম্পূর্ণ ড্যাশবোর্ড
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { BarChart3, Gamepad2, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import StatsCards from '@/components/dashboard/StatsCards';
import ProfitChart from '@/components/dashboard/ProfitChart';
import BetHistory from '@/components/dashboard/BetHistory';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function DashboardPage() {
  const [stats,   setStats]   = useState(null);
  const [chart,   setChart]   = useState([]);
  const [history, setHistory] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [kycStatus, setKycStatus] = useState<'unverified' | 'pending' | 'verified' | 'rejected'>('unverified');
  const [loading, setLoading] = useState(true);

  // Demo userId — real app এ JWT থেকে আসবে
  const userId = typeof window !== 'undefined'
    ? JSON.parse(localStorage.getItem('cf_user') || '{}')?.userId || 'demo'
    : 'demo';

  const token = typeof window !== 'undefined'
    ? localStorage.getItem('cf_token') || ''
    : '';

  const headers = { Authorization: `Bearer ${token}` };

  async function loadAll(page = 1) {
    setLoading(true);
    try {
      const [statsRes, chartRes, histRes, kycRes] = await Promise.all([
        fetch(`${API}/api/dashboard/stats/${userId}`,    { headers }),
        fetch(`${API}/api/dashboard/chart/${userId}?days=30`, { headers }),
        fetch(`${API}/api/dashboard/history/${userId}?page=${page}&limit=15`, { headers }),
        fetch(`${API}/api/kyc/status`, { headers }),
      ]);

      const [s, c, h, k] = await Promise.all([
        statsRes.json(),
        chartRes.json(),
        histRes.json(),
        kycRes.json()
      ]);
      
      if (s.success) setStats(s.data);
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

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-5xl mx-auto">
      {/* হেডার */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-info/10 border border-brand-info/25
                          flex items-center justify-center text-brand-info">
            <BarChart3 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="heading-display text-xl text-text-primary">আমার ড্যাশবোর্ড</h1>
              {kycStatus === 'verified' && (
                <span className="flex items-center gap-1 text-[10px] font-mono text-brand-green bg-brand-green/10 border border-brand-green/20 px-2 py-0.5 rounded-full">
                  <ShieldCheck size={10} />
                  ভেরিফাইড
                </span>
              )}
            </div>
            <p className="text-text-muted text-xs font-mono mt-0.5">আপনার সম্পূর্ণ গেমিং পরিসংখ্যান</p>
          </div>
        </div>
        <Link href="/game" className="btn-brand flex items-center gap-1.5 text-sm py-2 px-4">
          <Gamepad2 size={15} />
          গেম খেলুন
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
                {kycStatus === 'unverified' && 'কেওয়াইসি (KYC) যাচাইকরণ প্রয়োজন'}
                {kycStatus === 'pending' && 'আপনার ভেরিফিকেশন প্রক্রিয়াধীন রয়েছে'}
                {kycStatus === 'rejected' && 'ভেরিফিকেশন প্রত্যাখ্যান করা হয়েছে'}
              </p>
              <p className="text-[11px] text-text-muted mt-0.5">
                {kycStatus === 'unverified' && 'নিরাপদ ক্রিপ্টো উইথড্রয়াল সক্ষম করতে আপনার পরিচয় যাচাই করুন।'}
                {kycStatus === 'pending' && 'আমাদের নিরাপত্তা টিম আপনার ডকুমেন্টস চেক করছে। এটিতে ২-৫ মিনিট সময় লাগতে পারে।'}
                {kycStatus === 'rejected' && 'আপনার ডকুমেন্টস পলিসি পূরণ করতে পারেনি। অনুগ্রহ করে সঠিক তথ্য দিয়ে আবার চেষ্টা করুন।'}
              </p>
            </div>
          </div>
          {kycStatus !== 'pending' && (
            <Link
              href="/kyc"
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-surface hover:bg-surface2 border border-border text-text-primary hover:text-brand-green transition-all self-start sm:self-center font-mono"
            >
              ভেরিফাই করুন
            </Link>
          )}
        </div>
      )}

      <div className="space-y-5">
        {/* স্ট্যাটস কার্ড */}
        <StatsCards stats={stats} loading={loading} />

        {/* P&L চার্ট */}
        <ProfitChart data={chart} loading={loading} />

        {/* বেট ইতিহাস */}
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
