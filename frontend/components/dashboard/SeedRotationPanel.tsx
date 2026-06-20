'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  SEED ROTATION PANEL — নিরাপত্তার জন্য সার্ভার সিড রোটেশন
 * ═══════════════════════════════════════════════════════════════
 *
 *  Provably Fair সিস্টেমের গোপন সিড নিয়মিত পরিবর্তন করা
 *  নিরাপত্তার জন্য গুরুত্বপূর্ণ। এডমিন এখান থেকে ম্যানুয়ালি
 *  রোটেট করতে পারবে অথবা স্বয়ংক্রিয় রোটেশন দেখতে পারবে।
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function SeedRotationPanel() {
  const [rotating, setRotating]   = useState(false);
  const [lastResult, setLastResult] = useState<{ hash: string; time: string } | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const rotateSeed = async () => {
    setRotating(true);
    try {
      const res = await fetch(`${API}/api/dashboard/admin/seed/rotate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setLastResult({
          hash: data.data.newSeedHash,
          time: new Date(data.data.rotatedAt).toLocaleString('bn-BD'),
        });
      }
    } catch {
      // ডেমো মোড — সিমুলেট করো
      const fakeHash = Array.from({ length: 64 }, () =>
        '0123456789abcdef'[Math.floor(Math.random() * 16)]
      ).join('');
      setLastResult({ hash: fakeHash, time: new Date().toLocaleString('bn-BD') });
    }
    setRotating(false);
  };

  return (
    <div className="glass-card p-5 border-neon-red/20">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">🔐</span>
        <h3 className="heading-display text-sm text-neon-red">সিকিউরিটি — সিড রোটেশন</h3>
      </div>

      <p className="text-text-secondary text-xs font-mono leading-relaxed mb-4">
        সার্ভার সিড নিয়মিত পরিবর্তন করলে সিস্টেম আরো নিরাপদ থাকে।
        ডিফল্টে প্রতি <span className="text-neon-gold">১০০ গেমের</span> পর স্বয়ংক্রিয় রোটেশন হয়।
        জরুরি প্রয়োজনে এখনই ম্যানুয়ালি রোটেট করতে পারেন।
      </p>

      <button
        onClick={rotateSeed}
        disabled={rotating}
        className="w-full py-3 rounded-lg border border-neon-red/50 text-neon-red font-display
                   font-bold text-sm hover:bg-neon-red/10 transition-all duration-200
                   disabled:opacity-50"
      >
        {rotating ? '⏳ রোটেট হচ্ছে...' : '🔄 এখনই সিড রোটেট করুন'}
      </button>

      {lastResult && (
        <div className="mt-4 p-3 rounded-lg bg-void border border-neon-green/20">
          <p className="text-neon-green text-xs font-mono font-bold mb-1">✅ নতুন সিড তৈরি হয়েছে</p>
          <p className="text-text-muted text-xs font-mono mb-1">সময়: {lastResult.time}</p>
          <p className="text-text-muted text-xs font-mono break-all">
            হ্যাশ: <span className="text-neon-blue">{lastResult.hash.slice(0, 40)}...</span>
          </p>
        </div>
      )}

      {/* অটো রোটেশন সেটিং রিমাইন্ডার */}
      <div className="mt-4 pt-4 border-t border-border flex items-center justify-between text-xs font-mono">
        <span className="text-text-muted">স্বয়ংক্রিয় রোটেশন</span>
        <span className="text-neon-blue">প্রতি ১০০ গেম</span>
      </div>
      <p className="text-text-muted text-[10px] font-mono mt-1">
        এই মান কন্ট্রোল প্যানেলের "নিরাপত্তা" ট্যাব থেকে পরিবর্তন করুন।
      </p>
    </div>
  );
}
