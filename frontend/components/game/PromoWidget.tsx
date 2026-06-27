'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  PROMO WIDGET — প্রোমো কোড ও বোনাস অ্যাক্টিভেশন UI
 * ═══════════════════════════════════════════════════════════════
 *
 *  ইউজার এখানে প্রোমো কোড এন্টার করে ব্যালেন্স বা ডিপোজিট ম্যাচ বোনাস ক্লেইম করবে।
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { Gift, Sparkles, AlertCircle, Loader2, CheckCircle2, Award, ArrowUpRight } from 'lucide-react';
import { useGameStore } from '@/lib/store';

export default function PromoWidget() {
  const { user, token, updateBalance } = useGameStore();
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  
  const [activeMatch, setActiveMatch] = useState<{
    code: string;
    value: number;
    max_bonus_amount: number;
  } | null>(null);

  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  // ── সক্রিয় ডিপোজিট ম্যাচ লোড করো ──────────────────────────
  const fetchActivePromo = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/wallet/promo/active`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.success && data.activePromo) {
        setActiveMatch({
          code: data.activePromo.code,
          value: parseFloat(data.activePromo.value),
          max_bonus_amount: parseFloat(data.activePromo.max_bonus_amount),
        });
      } else {
        setActiveMatch(null);
      }
    } catch (err) {
      console.error('Active promo fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && token) {
      fetchActivePromo();
    }
  }, [expanded, token]);

  // ── প্রোমো কোড ক্লেইম করো ────────────────────────────────
  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !code.trim() || claiming) return;

    setClaiming(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`${API}/api/wallet/promo/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();

      if (data.success) {
        setSuccessMsg(data.message);
        setCode('');
        
        if (data.type === 'no_deposit') {
          updateBalance(data.newBalance);
        } else if (data.type === 'deposit_match') {
          fetchActivePromo();
        }
      } else {
        setError(data.error || 'প্রোমো কোড ক্লেইম ব্যর্থ হয়েছে।');
      }
    } catch (err) {
      console.error('Claim promo error:', err);
      setError('সার্ভার কানেকশন ব্যর্থ হয়েছে।');
    } finally {
      setClaiming(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="glass-card border border-border overflow-hidden">
      {/* হেডার */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-green/10 flex items-center justify-center text-brand-green">
            <Gift size={16} />
          </div>
          <div className="text-left">
            <div className="heading-display text-sm text-brand-green">PROMO CODES</div>
            <div className="text-text-muted text-xs font-mono">ফ্রি বোনাস ও ম্যাচ ডিপোজিট</div>
          </div>
        </div>
        <span className="text-text-muted">
          {expanded ? (
            <span className="text-xs font-mono">বন্ধ করুন</span>
          ) : (
            <span className="text-xs font-mono">খুলুন</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* প্রোমো ক্লেইম ফর্ম */}
          <form onSubmit={handleClaim} className="space-y-3">
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">
                প্রোমো কোড প্রবেশ করুন
              </label>
              <div className="flex gap-2">
                <input
                  className="input-cyber text-xs bg-[#090D16] border-border uppercase font-mono tracking-wider"
                  placeholder="e.g. WELCOME10"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  disabled={claiming}
                />
                <button
                  type="submit"
                  disabled={claiming || !code.trim()}
                  className="px-4 py-2.5 bg-brand-green text-void rounded-lg hover:bg-brand-green/85 transition-colors flex items-center justify-center gap-1.5 text-xs font-bold font-mono
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {claiming ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  প্রয়োগ
                </button>
              </div>
            </div>
          </form>

          {/* অ্যালার্ট নোটিফিকেশন */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-brand-red/10 border border-brand-red/20 rounded-lg text-brand-red text-xs font-mono">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          {successMsg && (
            <div className="flex items-center gap-2 p-3 bg-brand-green/10 border border-brand-green/20 rounded-lg text-brand-green text-xs font-mono">
              <CheckCircle2 size={14} className="shrink-0" />
              {successMsg}
            </div>
          )}

          {/* সক্রিয় ডিপোজিট ম্যাচ বোনাস ব্যানার */}
          {loading && !activeMatch ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="animate-spin text-brand-green" size={16} />
            </div>
          ) : (
            activeMatch && (
              <div className="relative overflow-hidden bg-gradient-to-r from-brand-green/15 to-void border border-brand-green/30 rounded-xl p-4 space-y-1">
                <div className="absolute top-0 right-0 p-2 opacity-15">
                  <Award size={64} className="text-brand-green" />
                </div>
                <div className="flex items-center gap-1.5 text-brand-green text-xs font-bold font-mono">
                  <Sparkles size={12} /> সক্রিয় বোনাস চালু আছে!
                </div>
                <div className="text-base font-display font-black text-white mt-1 font-mono tracking-wider">
                  {activeMatch.code}
                </div>
                <p className="text-xs text-text-secondary leading-relaxed font-mono">
                  পরবর্তী ডিপোজিটে পাবেন {(activeMatch.value * 100).toFixed(0)}% ম্যাচিং বোনাস, সর্বোচ্চ ${activeMatch.max_bonus_amount.toFixed(0)}।
                </p>
                <div className="text-[10px] text-brand-green/75 font-mono flex items-center gap-1 mt-2">
                  পরবর্তী ডিপোজিটে অটো যুক্ত হবে <ArrowUpRight size={10} />
                </div>
              </div>
            )
          )}

          {/* বিস্তারিত গাইডলাইন */}
          <div className="text-[11px] font-mono text-text-muted leading-relaxed bg-void/50 p-3 rounded-lg border border-border/50">
            <p className="font-bold text-text-secondary mb-1">
              💡 প্রোমো কোডের নিয়মাবলী:
            </p>
            <p className="mb-0.5">• <strong>WELCOME10:</strong> নতুন ইউজারদের জন্য $১০.০০ এর ইন্সট্যান্ট ফ্রি বোনাস ক্রেডিট।</p>
            <p>• <strong>MATCH100:</strong> পরবর্তী সফল ডিপোজিটে ১০০% ক্যাশব্যাক ম্যাচিং বোনাস (সর্বোচ্চ $৫০০.০০)।</p>
          </div>
        </div>
      )}
    </div>
  );
}
