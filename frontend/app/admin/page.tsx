'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN PANEL PAGE — সুপার এডমিন কন্ট্রোল রুম
 * ═══════════════════════════════════════════════════════════════
 *
 *  ৪টি ট্যাব:
 *  ① লাইভ স্ট্যাটস  → প্ল্যাটফর্মের সামগ্রিক অবস্থা
 *  ② কনফিগ         → হাউজ এজ, রেইন, স্কোয়াড সেটিং
 *  ③ ইউজার         → ইউজার ম্যানেজমেন্ট
 *  ④ সিকিউরিটি     → সিড রোটেশন
 *
 *  SECURITY: This page is protected client-side. Non-admin or
 *  unauthenticated visitors are redirected to /game.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BarChart3, Settings, Users, ShieldCheck, type LucideIcon } from 'lucide-react';
import AdminLiveStats from '@/components/dashboard/AdminLiveStats';
import AdminConfigPanel from '@/components/game/AdminConfig';
import AdminUserTable from '@/components/dashboard/AdminUserTable';
import SeedRotationPanel from '@/components/dashboard/SeedRotationPanel';

const TABS: { id: 'live' | 'config' | 'users' | 'security'; label: string; Icon: LucideIcon }[] = [
  { id: 'live',     label: 'লাইভ স্ট্যাটস', Icon: BarChart3 },
  { id: 'config',   label: 'গেম কনফিগ',     Icon: Settings },
  { id: 'users',    label: 'ইউজার',         Icon: Users },
  { id: 'security', label: 'সিকিউরিটি',     Icon: ShieldCheck },
];

type TabId = typeof TABS[number]['id'];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabId>('live');
  const [allowed, setAllowed] = useState(false);
  const router = useRouter();

  useEffect(() => {
    try {
      const raw = localStorage.getItem('cf_user');
      const user = raw ? JSON.parse(raw) : null;
      if (!user?.isAdmin) {
        router.replace('/game');
        return;
      }
      setAllowed(true);
    } catch {
      router.replace('/game');
    }
  }, [router]);

  if (!allowed) {
    return (
      <main className="min-h-screen flex items-center justify-center text-text-muted">
        <p>এডমিন অ্যাক্সেস যাচাই হচ্ছে...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-5xl mx-auto">
      {/* হেডার */}
      <div className="flex items-center gap-4 mb-6">
        <div className="w-11 h-11 rounded-xl bg-brand-maroon/10 border border-brand-maroon/25
                        flex items-center justify-center text-brand-maroon">
          <Settings size={20} />
        </div>
        <div>
          <h1 className="heading-display text-xl text-text-primary">Admin Panel</h1>
          <p className="text-text-muted text-xs font-mono">CryptoFlip — সুপার এডমিন কন্ট্রোল</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse-soft" />
          <span className="text-text-muted text-xs font-mono">সিস্টেম চালু আছে</span>
        </div>
      </div>

      {/* ট্যাব নেভিগেশন */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-mono whitespace-nowrap
                        transition-all duration-150 ${
              activeTab === tab.id
                ? 'bg-brand-maroon text-white font-medium shadow-brand-maroon'
                : 'border border-border text-text-secondary hover:border-brand-maroon/50'
            }`}
          >
            <tab.Icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ট্যাব কন্টেন্ট */}
      <div className="space-y-5">
        {activeTab === 'live'     && <AdminLiveStats />}
        {activeTab === 'config'   && <AdminConfigPanel />}
        {activeTab === 'users'    && <AdminUserTable />}
        {activeTab === 'security' && <SeedRotationPanel />}
      </div>
    </main>
  );
}
