'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  AFFILIATE PANEL — রেফারেল ও অ্যাফিলিয়েট ম্যানেজমেন্ট UI
 * ═══════════════════════════════════════════════════════════════
 *
 *  ইউজার এখানে তার রেফারেল লিংক পাবে এবং রেফারেল কমিশন ক্লেইম করতে পারবে।
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { Users, Share2, Copy, Trophy, Percent, Loader2, CheckCircle2, Wallet, ChevronDown, ChevronUp } from 'lucide-react';
import { useGameStore } from '@/lib/store';

export default function AffiliatePanel() {
  const { user, token, updateBalance } = useGameStore();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [stats, setStats] = useState({
    referralCode: '',
    pendingBalance: 0,
    totalEarned: 0,
    referralsCount: 0,
    referralsWagered: 0,
  });

  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  const referralLink = stats.referralCode 
    ? `${window.location.origin}/register?ref=${stats.referralCode}` 
    : '';

  // ── ডাটা লোড করো ──────────────────────────────────────────
  const fetchAffiliateData = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/wallet/affiliate`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.success) {
        setStats({
          referralCode: data.referralCode || '',
          pendingBalance: data.pendingBalance || 0,
          totalEarned: data.totalEarned || 0,
          referralsCount: data.referralsCount || 0,
          referralsWagered: data.referralsWagered || 0,
        });
      }
    } catch (err) {
      console.error('Affiliate fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && token) {
      fetchAffiliateData();
    }
  }, [expanded, token]);

  // ── লিংক কপি করো ──────────────────────────────────────────
  const handleCopy = () => {
    if (!referralLink) return;
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── কমিশন ক্লেইম করো ──────────────────────────────────────
  const handleClaim = async () => {
    if (!token || stats.pendingBalance <= 0 || claiming) return;
    setClaiming(true);
    try {
      const res = await fetch(`${API}/api/wallet/affiliate/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.success) {
        updateBalance(data.newBalance);
        setStats(prev => ({
          ...prev,
          pendingBalance: 0,
        }));
        // রিয়েল-টাইমে ডাটা রি-লোডিং
        fetchAffiliateData();
      } else {
        alert(data.error || 'ক্লেইম ব্যর্থ হয়েছে।');
      }
    } catch (err) {
      console.error('Claim error:', err);
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
          <div className="w-8 h-8 rounded-lg bg-brand-gold/10 flex items-center justify-center text-brand-gold">
            <Users size={16} />
          </div>
          <div className="text-left">
            <div className="heading-display text-sm text-brand-gold">AFFILIATES</div>
            <div className="text-text-muted text-xs font-mono">রেফারেল প্রোগ্রাম ও কমিশন</div>
          </div>
        </div>
        <span className="text-text-muted">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {loading && !stats.referralCode ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="animate-spin text-brand-gold" size={24} />
            </div>
          ) : (
            <>
              {/* লিংক শেয়ারিং কার্ড */}
              <div className="bg-void rounded-lg p-3.5 border border-brand-gold/20 space-y-2.5">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-text-secondary font-mono flex items-center gap-1.5">
                    <Share2 size={12} className="text-brand-gold" /> আপনার রেফারেল লিংক:
                  </span>
                  <span className="text-[10px] text-brand-gold font-mono px-2 py-0.5 bg-brand-gold/10 rounded">
                    ১০% লাইফটাইম কমিশন
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    className="input-cyber text-xs bg-[#090D16] border-border text-text-secondary"
                    readOnly
                    value={referralLink}
                  />
                  <button
                    onClick={handleCopy}
                    className="px-3.5 py-2.5 bg-brand-gold text-void rounded-lg hover:bg-brand-gold/85 transition-colors flex items-center justify-center gap-1.5 text-xs font-bold font-mono"
                  >
                    {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                    {copied ? 'কপিড!' : 'কপি'}
                  </button>
                </div>
              </div>

              {/* স্ট্যাটিস্টিকস গ্রিড */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-void border border-border p-3 rounded-lg text-center">
                  <div className="text-[10px] font-mono text-text-muted mb-1">মোট রেফারেল</div>
                  <div className="text-lg font-display font-bold text-white flex items-center justify-center gap-1">
                    <Users size={14} className="text-brand-gold/70" />
                    {stats.referralsCount}
                  </div>
                </div>
                <div className="bg-void border border-border p-3 rounded-lg text-center">
                  <div className="text-[10px] font-mono text-text-muted mb-1">রেফারেলদের মোট বাজি</div>
                  <div className="text-lg font-display font-bold text-white">
                    ${stats.referralsWagered.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* ক্লেইমেবল কার্ড */}
              <div className="glass-card bg-[#111A24] border border-border p-4 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs text-text-muted font-mono">ক্লেইমযোগ্য ব্যালেন্স</div>
                  <div className="text-2xl font-mono font-black text-brand-green mt-1">
                    ${stats.pendingBalance.toFixed(4)}
                  </div>
                  <div className="text-[10px] text-text-muted font-mono mt-0.5">
                    মোট উপার্জিত: ${stats.totalEarned.toFixed(2)}
                  </div>
                </div>
                <button
                  onClick={handleClaim}
                  disabled={stats.pendingBalance <= 0 || claiming}
                  className="px-5 py-3 rounded-xl font-display font-black text-sm transition-all duration-150
                             bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5
                             disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0 flex items-center gap-2"
                >
                  {claiming ? <Loader2 size={15} className="animate-spin" /> : <Wallet size={15} />}
                  ক্লেইম করুন
                </button>
              </div>

              {/* বিস্তারিত ব্যাখ্যা */}
              <div className="text-[11px] font-mono text-text-muted leading-relaxed bg-void/50 p-3 rounded-lg border border-border/50">
                <p className="flex items-center gap-1.5 font-bold text-text-secondary mb-1">
                  <Percent size={12} className="text-brand-gold" /> রেফারেল বোনাস কীভাবে কাজ করে?
                </p>
                <p>১. আপনার লিংকের মাধ্যমে বন্ধুরা সাইনআপ করলে তারা $১০.০০ বোনাস পাবে।</p>
                <p>২. তাদের প্রতি বাজির হাউজ কমিশনের (২% হাউজ এজ) এর ১০% অংশ আপনার অ্যাফিলিয়েট একাউন্টে জমা হবে।</p>
                <p>৩. যেকোনো সময় আপনি সেই কমিশন ক্লেইম করে গেমের মেইন ব্যালেন্সে ট্রান্সফার করতে পারবেন।</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
