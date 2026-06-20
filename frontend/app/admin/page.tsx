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
 * ═══════════════════════════════════════════════════════════════
 */
import { useState } from 'react';
import AdminLiveStats from '@/components/dashboard/AdminLiveStats';
import AdminConfigPanel from '@/components/game/AdminConfig';
import AdminUserTable from '@/components/dashboard/AdminUserTable';
import SeedRotationPanel from '@/components/dashboard/SeedRotationPanel';

const TABS = [
  { id: 'live',     label: 'লাইভ স্ট্যাটস', icon: '📊' },
  { id: 'config',   label: 'গেম কনফিগ',     icon: '⚙️' },
  { id: 'users',    label: 'ইউজার',         icon: '👥' },
  { id: 'security', label: 'সিকিউরিটি',     icon: '🔐' },
] as const;

type TabId = typeof TABS[number]['id'];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabId>('live');

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-5xl mx-auto">
      {/* হেডার */}
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-xl bg-neon-purple/20 border border-neon-purple/40
                        flex items-center justify-center text-2xl">⚙️</div>
        <div>
          <h1 className="heading-display text-2xl text-neon-purple">ADMIN PANEL</h1>
          <p className="text-text-muted text-xs font-mono">CryptoFlip — সুপার এডমিন কন্ট্রোল</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse" />
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
                        transition-all duration-200 ${
              activeTab === tab.id
                ? 'bg-neon-purple text-void font-bold shadow-neon-purple'
                : 'border border-border text-text-secondary hover:border-neon-purple/50'
            }`}
          >
            <span>{tab.icon}</span>
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
