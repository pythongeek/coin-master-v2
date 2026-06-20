'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  STATS CARDS — ইউজারের মূল পরিসংখ্যান কার্ড
 * ═══════════════════════════════════════════════════════════════
 */

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
  icon: string;
}

const COLOR_MAP: Record<CardProps['color'], string> = {
  green:  'border-neon-green/30 bg-neon-green/5  text-neon-green',
  blue:   'border-neon-blue/30  bg-neon-blue/5   text-neon-blue',
  purple: 'border-neon-purple/30 bg-neon-purple/5 text-neon-purple',
  gold:   'border-neon-gold/30  bg-neon-gold/5   text-neon-gold',
  red:    'border-neon-red/30   bg-neon-red/5    text-neon-red',
};

function StatCard({ label, value, sub, color, icon }: CardProps) {
  return (
    <div className={`rounded-xl border p-4 ${COLOR_MAP[color]}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-text-muted text-xs font-mono uppercase tracking-widest">{label}</span>
        <span className="text-xl">{icon}</span>
      </div>
      <div className={`font-mono font-bold text-2xl ${COLOR_MAP[color].split(' ')[2]}`}>
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
      label: 'ব্যালেন্স',
      value: `$${stats.balance.toFixed(2)}`,
      sub: 'বর্তমান ওয়ালেট',
      color: 'green',
      icon: '💰',
    },
    {
      label: 'মোট বেট',
      value: stats.totalBets.toLocaleString(),
      sub: `${stats.totalWins}জয় / ${stats.totalBets - stats.totalWins}হার`,
      color: 'blue',
      icon: '🎲',
    },
    {
      label: 'জয়ের হার',
      value: `${stats.winRate}%`,
      sub: stats.winRate >= 50 ? '📈 ভালো চলছে!' : '📉 সাবধান',
      color: stats.winRate >= 50 ? 'green' : 'red',
      icon: '📊',
    },
    {
      label: 'মোট বাজি',
      value: `$${stats.totalWagered.toFixed(2)}`,
      sub: 'সব বেটের সমষ্টি',
      color: 'purple',
      icon: '💸',
    },
    {
      label: 'নেট লাভ/লোকসান',
      value: `${stats.netPnl >= 0 ? '+' : ''}$${stats.netPnl.toFixed(2)}`,
      sub: stats.netPnl >= 0 ? 'মোট লাভ' : 'মোট লোকসান',
      color: stats.netPnl >= 0 ? 'green' : 'red',
      icon: stats.netPnl >= 0 ? '📈' : '📉',
    },
    {
      label: 'সর্বোচ্চ জয়',
      value: `$${stats.biggestWin.toFixed(2)}`,
      sub: 'একক বেটে সর্বোচ্চ',
      color: 'gold',
      icon: '🏆',
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
