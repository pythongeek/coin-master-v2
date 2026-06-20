'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  USER DASHBOARD PAGE — ইউজারের সম্পূর্ণ ড্যাশবোর্ড
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import StatsCards from '@/components/dashboard/StatsCards';
import ProfitChart from '@/components/dashboard/ProfitChart';
import BetHistory from '@/components/dashboard/BetHistory';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function DashboardPage() {
  const [stats,   setStats]   = useState(null);
  const [chart,   setChart]   = useState([]);
  const [history, setHistory] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
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
      const [statsRes, chartRes, histRes] = await Promise.all([
        fetch(`${API}/api/dashboard/stats/${userId}`,    { headers }),
        fetch(`${API}/api/dashboard/chart/${userId}?days=30`, { headers }),
        fetch(`${API}/api/dashboard/history/${userId}?page=${page}&limit=15`, { headers }),
      ]);

      const [s, c, h] = await Promise.all([statsRes.json(), chartRes.json(), histRes.json()]);
      if (s.success) setStats(s.data);
      if (c.success) setChart(c.data);
      if (h.success) {
        setHistory(h.data);
        setPagination({ page, totalPages: h.pagination.totalPages });
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
        <div>
          <h1 className="heading-display text-2xl text-neon-blue">আমার ড্যাশবোর্ড</h1>
          <p className="text-text-muted text-xs font-mono mt-0.5">আপনার সম্পূর্ণ গেমিং পরিসংখ্যান</p>
        </div>
        <Link href="/game" className="btn-neon text-sm py-2 px-4">🎮 গেম খেলুন</Link>
      </div>

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
