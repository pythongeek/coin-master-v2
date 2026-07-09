'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN LIVE STATS — প্ল্যাটফর্মের সামগ্রিক Live Stats
 * ═══════════════════════════════════════════════════════════════
 *
 *  প্রতি ১০ সেকেন্ডে অটো-রিফ্রেশ হয়।
 *  এডমিন একনজরে পুরো প্ল্যাটফর্মের স্বাস্থ্য দেখতে পারবে।
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Users, Banknote, Landmark, Dices, CloudRain, type LucideIcon } from 'lucide-react';

import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface LiveStats {
  users:       { total: number; today: number };
  bets:        { total: number; totalVolume: number; today: number; todayVolume: number };
  houseProfit: number;
  activeRains: number;
}

export default function AdminLiveStats() {
  const [stats, setStats]     = useState<LiveStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchStats = useCallback(async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
    try {
      const res = await fetch(`${API}/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.success && json.stats) {
        const s = json.stats;
        setStats({
          users: { total: s.totalUsers ?? 0, today: 0 }, // backend /admin/stats has no daily user count
          bets: {
            total: s.totalBets ?? 0,
            totalVolume: s.totalVolume ?? 0,
            today: s.todayBets ?? 0,
            todayVolume: s.todayVolume ?? 0,
          },
          houseProfit: s.houseProfit ?? 0,
          activeRains: s.activeRainEvents ?? 0,
        });
        setLastUpdate(new Date());
      }
    } catch {
      // Silent fail
      if (!stats) setStats(null);
    }
    setLoading(false);
  }, [stats]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10000); // প্রতি ১০ সেকেন্ডে
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-surface animate-pulse" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const cards: { label: string; Icon: LucideIcon; color: string; value: string; sub: string; trend?: number }[] = [
    {
      label: 'Total Users', Icon: Users, color: 'blue',
      value: stats.users.total.toLocaleString(),
      sub: `+${stats.users.today} আজ`,
      trend: stats.users.today,
    },
    {
      label: 'Total Bet Volume', Icon: Banknote, color: 'green',
      value: `$${stats.bets.totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      sub: `আজ: $${stats.bets.todayVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      trend: stats.bets.todayVolume,
    },
    {
      label: 'House Profit', Icon: Landmark, color: 'gold',
      value: `$${stats.houseProfit.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      sub: 'সর্বমোট নেট আয়',
      trend: stats.houseProfit,
    },
    {
      label: "Today's Bets", Icon: Dices, color: 'purple',
      value: stats.bets.today.toLocaleString(),
      sub: `সর্বমোট: ${stats.bets.total.toLocaleString()}`,
      trend: stats.bets.today,
    },
  ];

  const colorClass: Record<string, string> = {
    blue:   'border-brand-info/30 text-brand-info',
    green:  'border-brand-green/30 text-brand-green',
    gold:   'border-brand-gold/30 text-brand-gold',
    purple: 'border-brand-maroon/30 text-brand-maroon',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="heading-display text-sm text-text-primary">Live Stats</h3>
        <div className="flex items-center gap-2 text-text-muted text-xs font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse" />
          আপডেট: {lastUpdate.toLocaleTimeString('bn-BD')}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className={`glass-card p-4 border ${colorClass[c.color]}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-text-muted text-xs font-mono">{c.label}</span>
              <c.Icon size={16} strokeWidth={2} />
            </div>
            <div className={`font-mono font-semibold text-xl ${colorClass[c.color].split(' ')[1]}`}>
              {c.value}
            </div>
            <div className="text-text-muted text-xs font-mono mt-1">{c.sub}</div>
            {c.trend !== undefined && c.trend !== 0 && (
              <div className="text-[10px] text-text-muted mt-1">Trend: {c.trend > 0 ? '+' : ''}{c.trend.toLocaleString()}</div>
            )}
          </div>
        ))}
      </div>

      {/* Active rain warning */}
      {stats.activeRains > 0 && (
        <div className="mt-3 flex items-center gap-2 px-4 py-2 rounded-lg border border-brand-gold/40 bg-brand-gold/5 text-brand-gold text-xs font-mono">
          <CloudRain size={14} />
          এই মুহূর্তে {stats.activeRains}টি Crypto Rain সক্রিয় আছে
        </div>
      )}
    </div>
  );
}
