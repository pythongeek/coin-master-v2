'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  BET HISTORY TABLE — বেট ইতিহাসের সম্পূর্ণ তালিকা
 * ═══════════════════════════════════════════════════════════════
 */

interface Bet {
  id:         string;
  choice:     'heads' | 'tails';
  amount:     number;
  result:     'heads' | 'tails';
  won:        boolean;
  payout:     number;
  house_edge: number;
  flip_hash:  string;
  created_at: string;
}

interface Props {
  history:    Bet[];
  loading:    boolean;
  page:       number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export default function BetHistory({ history, loading, page, totalPages, onPageChange }: Props) {
  if (loading) {
    return (
      <div className="glass-card p-4">
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-surface animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card overflow-hidden">
      {/* হেডার */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="heading-display text-sm">বেট ইতিহাস</h3>
        <span className="text-text-muted text-xs font-mono">{history.length} রেকর্ড</span>
      </div>

      {/* টেবিল */}
      {history.length === 0 ? (
        <div className="p-8 text-center text-text-muted font-mono text-sm">
          এখনো কোনো বেট নেই।
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border text-text-muted text-left">
                {['সময়', 'পছন্দ', 'ফলাফল', 'বেট', 'পেআউট', 'হাউজ', 'যাচাই'].map(h => (
                  <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((bet) => (
                <tr
                  key={bet.id}
                  className={`border-b border-border/50 transition-colors hover:bg-white/2 ${
                    bet.won ? 'bg-neon-green/2' : ''
                  }`}
                >
                  {/* সময় */}
                  <td className="px-4 py-2.5 text-text-muted">
                    {new Date(bet.created_at).toLocaleString('bn-BD', {
                      month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </td>

                  {/* পছন্দ */}
                  <td className="px-4 py-2.5">
                    <span className={bet.choice === 'heads' ? 'text-neon-green' : 'text-neon-blue'}>
                      {bet.choice === 'heads' ? '👑 H' : '🦅 T'}
                    </span>
                  </td>

                  {/* ফলাফল */}
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      bet.won
                        ? 'bg-neon-green/15 text-neon-green'
                        : 'bg-neon-red/15 text-neon-red'
                    }`}>
                      {bet.won ? '✓ জয়' : '✗ হার'}
                    </span>
                  </td>

                  {/* বেট */}
                  <td className="px-4 py-2.5 text-text-secondary">
                    ${parseFloat(String(bet.amount)).toFixed(2)}
                  </td>

                  {/* পেআউট */}
                  <td className={`px-4 py-2.5 font-bold ${
                    bet.won ? 'text-neon-green' : 'text-neon-red'
                  }`}>
                    {bet.won
                      ? `+$${parseFloat(String(bet.payout)).toFixed(2)}`
                      : `-$${parseFloat(String(bet.amount)).toFixed(2)}`
                    }
                  </td>

                  {/* হাউজ এজ */}
                  <td className="px-4 py-2.5 text-text-muted">
                    {parseFloat(String(bet.house_edge)).toFixed(1)}%
                  </td>

                  {/* Provably Fair যাচাই */}
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => {
                        const url = `/game?verify=true&hash=${bet.flip_hash}`;
                        window.open(url, '_blank');
                      }}
                      className="text-neon-blue hover:underline text-xs"
                      title="Provably Fair যাচাই করুন"
                    >
                      🔐 যাচাই
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* পেজিনেশন */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 p-3 border-t border-border">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="px-3 py-1 rounded border border-border text-text-muted text-xs
                       hover:border-neon-green/50 disabled:opacity-30 transition-all"
          >
            ← আগে
          </button>
          <span className="text-text-muted text-xs font-mono">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1 rounded border border-border text-text-muted text-xs
                       hover:border-neon-green/50 disabled:opacity-30 transition-all"
          >
            পরে →
          </button>
        </div>
      )}
    </div>
  );
}
