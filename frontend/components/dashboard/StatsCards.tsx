'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  STATS CARDS — ইউজারের মূল Stats কার্ড
 * ═══════════════════════════════════════════════════════════════
 */
import { Wallet, Dices, BarChart3, Coins, TrendingUp, TrendingDown, Trophy, type LucideIcon } from 'lucide-react';

interface Stats {
  balance:      number;
  totalBets:    number;
  totalWins:    number;
  winRate:      number;
  totalWagered: number;
  netPnl:       number;
  biggestWin:   number;
}

interface CardProps {
  label: string;
  value: string;
  sub?: string;
  color: 'green' | 'blue' | 'purple' | 'gold' | 'red';
  Icon: LucideIcon;
}

const COLOR_MAP: Record<CardProps['color'], string> = {
  green:  'border-brand-green/25 bg-brand-green/[0.06]  text-brand-green',
  blue:   'border-brand-info/25  bg-brand-info/[0.06]   text-brand-info',
  purple: 'border-brand-maroon/25 bg-brand-maroon/[0.06] text-brand-maroon',
  gold:   'border-brand-gold/25  bg-brand-gold/[0.06]   text-brand-gold',
  red:    'border-brand-red/25   bg-brand-red/[0.06]    text-brand-red',
};

function StatCard({ label, value, sub, color, Icon }: CardProps) {
  return (
    <div className={`glass-card rounded-xl border p-4 ${COLOR_MAP[color]}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-text-muted text-xs font-mono uppercase tracking-widest">{label}</span>
        <Icon size={18} strokeWidth={2} />
      </div>
      <div className={`font-mono font-semibold text-2xl ${COLOR_MAP[color].split(' ')[2]}`}>
        {value}
      </div>
      {sub && <div className="text-text-muted text-xs font-mono mt-1">{sub}</div>}
    </div>
  );
}

export default function StatsCards({ stats, loading }: { stats: Stats | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface/50 p-4 animate-pulse h-24" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const cards: CardProps[] = [
    {
      label: 'Balance',
      value: `$${stats.balance.toFixed(2)}`,
      sub: 'বর্তমান Wallet',
      color: 'green',
      Icon: Wallet,
    },
    {
      label: 'Total Bets',
      value: stats.totalBets.toLocaleString(),
      sub: `${stats.totalWins}জয় / ${stats.totalBets - stats.totalWins}হার`,
      color: 'blue',
      Icon: Dices,
    },
    {
      label: 'Win Rate',
      value: `${stats.winRate}%`,
      sub: stats.winRate >= 50 ? 'ভালো চলছে' : 'সাবধান',
      color: stats.winRate >= 50 ? 'green' : 'red',
      Icon: BarChart3,
    },
    {
      label: 'Total Wagered',
      value: `$${stats.totalWagered.toFixed(2)}`,
      sub: 'সব Betের সমষ্টি',
      color: 'purple',
      Icon: Coins,
    },
    {
      label: 'Net P/L',
      value: `${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(2)}`,
      sub: stats.netPnl >= 0 ? 'মোট লাভ' : 'মোট লোকসান',
      color: stats.netPnl >= 0 ? 'green' : 'red',
      Icon: stats.netPnl >= 0 ? TrendingUp : TrendingDown,
    },
    {
      label: 'Biggest Win',
      value: `$${stats.biggestWin.toFixed(2)}`,
      sub: 'একক Betে সর্বোচ্চ',
      color: 'gold',
      Icon: Trophy,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {cards.map((card) => (
        <StatCard key={card.label} {...card} />
      ))}
    </div>
  );
}
