'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  USER DASHBOARD PAGE — ইউজারের সম্পূর্ণ ড্যাশবোর্ড
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { BarChart3, Gamepad2 } from 'lucide-react';
import StatsCards from '@/components/dashboard/StatsCards';
import ProfitChart from '@/components/dashboard/ProfitChart';
import BetHistory from '@/components/dashboard/BetHistory';
import { WalletButton } from '@/components/wallet/WalletButton';
import { WalletModal } from '@/components/wallet';
import { getWalletBalance, WalletApiError } from '@/lib/api/wallet';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function DashboardPage() {
  const [stats,   setStats]   = useState(null);
  const [chart,   setChart]   = useState([]);
  const [history, setHistory] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [balanceCoins, setBalanceCoins] = useState<number>(0);
  const [showWallet, setShowWallet] = useState(false);

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

  // ── Wallet balance (silent — don't fail dashboard load if wallet unreachable)
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const bal = await getWalletBalance(token);
        if (!cancelled) setBalanceCoins(bal.wallet.balanceCoins);
      } catch (e) {
        // Wallet API down or no wallet row yet — show 0 silently
        if (!cancelled && !(e instanceof WalletApiError && e.status === 404)) {
          // non-404 errors are real — but we don't want to fail the dashboard
          console.warn('[dashboard] wallet balance fetch failed:', e);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

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
            <h1 className="heading-display text-xl text-text-primary">আমার ড্যাশবোর্ড</h1>
            <p className="text-text-muted text-xs font-mono mt-0.5">আপনার সম্পূর্ণ গেমিং পরিসংখ্যান</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {token && (
            <WalletButton
              balance={balanceCoins}
              onClick={() => setShowWallet(true)}
            />
          )}
          <Link href="/game" className="btn-brand flex items-center gap-1.5 text-sm py-2 px-4">
            <Gamepad2 size={15} />
            গেম খেলুন
          </Link>
        </div>
      </div>

      {/* Wallet modal */}
      {showWallet && token && (
        <WalletModal
          open={showWallet}
          onClose={() => setShowWallet(false)}
          token={token}
          onBalanceChange={(newCoins) => setBalanceCoins(newCoins)}
        />
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
