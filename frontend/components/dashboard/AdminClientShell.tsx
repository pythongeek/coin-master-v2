'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN CLIENT SHELL — interactive admin UI
 *
 *  This component receives a server-validated admin user and renders
 *  the admin panel. It is a client component because it uses state,
 *  effects and toast hooks.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, Settings, Users, ShieldCheck, Gift, Wallet, FileText, Key, Activity, LogOut, AlertCircle, Trophy, Target, type LucideIcon } from 'lucide-react';
import AdminLiveStats from '@/components/dashboard/AdminLiveStats';
import AdminConfigPanel from '@/components/game/AdminConfig';
import AdminUserTable from '@/components/dashboard/AdminUserTable';
import AdminWithdrawalQueue from '@/components/dashboard/AdminWithdrawalQueue';
import AdminBonusPanel from '@/components/dashboard/AdminBonusPanel';
import AdminAuditLogViewer from '@/components/dashboard/AdminAuditLogViewer';
import AdminAccountSecurity from '@/components/dashboard/AdminAccountSecurity';
import AdminHealthDashboard from '@/components/dashboard/AdminHealthDashboard';
import AdminBannerControl from '@/components/dashboard/AdminBannerControl';
import SeedRotationPanel from '@/components/dashboard/SeedRotationPanel';
import AdminKycReviewPanel from '@/components/dashboard/AdminKycReviewPanel';
import AdminKycSettings from '@/components/dashboard/AdminKycSettings';
import AdminLeaderboardPanel from '@/components/dashboard/AdminLeaderboardPanel';
import AdminChallengesPanel from '@/components/dashboard/AdminChallengesPanel';
import { useToast } from '@/components/providers/ToastProvider';
import { clearToken } from '@/lib/socket';

const TABS: { id: 'live' | 'config' | 'users' | 'withdrawals' | 'bonuses' | 'leaderboard' | 'challenges' | 'audit' | 'health' | 'security' | 'kyc' | 'account'; label: string; Icon: LucideIcon }[] = [
  { id: 'live', label: 'Live Stats', Icon: BarChart3 },
  { id: 'config', label: 'Game Config', Icon: Settings },
  { id: 'users', label: 'Users', Icon: Users },
  { id: 'withdrawals', label: 'Withdrawals', Icon: Wallet },
  { id: 'bonuses', label: 'Bonuses', Icon: Gift },
  { id: 'leaderboard', label: 'Leaderboard', Icon: Trophy },
  { id: 'challenges', label: 'Challenges', Icon: Target },
  { id: 'kyc', label: 'KYC Review', Icon: ShieldCheck },
  { id: 'audit', label: 'Audit Logs', Icon: FileText },
  { id: 'health', label: 'Health', Icon: Activity },
  { id: 'security', label: 'Security', Icon: ShieldCheck },
  { id: 'account', label: 'Account', Icon: Key },
];

type TabId = typeof TABS[number]['id'];

interface AdminClientShellProps {
  user: {
    username: string;
    role: string;
    twoFactorEnabled: boolean;
  };
}

export default function AdminClientShell({ user }: AdminClientShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>('live');
  const router = useRouter();
  const { addToast } = useToast();

  const logout = () => {
    clearToken();
    addToast('Logged out', 'info');
    router.replace('/game');
  };

  const isSuperAdmin = user.role === 'super_admin';
  const needs2FA = !user.twoFactorEnabled;

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        <div className="w-11 h-11 rounded-xl bg-brand-maroon/10 border border-brand-maroon/25 flex items-center justify-center text-brand-maroon">
          <Settings size={20} />
        </div>
        <div>
          <h1 className="heading-display text-xl text-text-primary">Admin Panel</h1>
          <p className="text-text-muted text-xs font-mono">
            CryptoFlip · <span className="text-text-primary">{user.username}</span> · {user.role}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/game"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:border-brand-green/40 hover:text-brand-green text-xs font-mono"
            title="Open the game UI as this admin user"
          >
            Open Game UI
          </Link>
          <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse-soft" />
          <span className="text-text-muted text-xs font-mono">System Online</span>
          <button
            onClick={logout}
            className="ml-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:border-brand-red/40 hover:text-brand-red text-xs font-mono"
            title="Log out"
          >
            <LogOut size={12} /> Logout
          </button>
        </div>
      </div>

      {needs2FA && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg border border-brand-gold/40 bg-brand-gold/10 text-brand-gold text-xs font-mono">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">
            Your admin account does not have two-factor authentication enabled. Recommended for all admin users.
          </span>
          <button
            onClick={() => setActiveTab('account')}
            className="px-3 py-1 rounded border border-brand-gold/40 hover:bg-brand-gold/10"
          >
            Set up 2FA
          </button>
        </div>
      )}

      <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          if (tab.id === 'kyc' && !isSuperAdmin) return null;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-mono whitespace-nowrap transition-all duration-150 ${
                activeTab === tab.id
                  ? 'bg-brand-maroon text-white font-medium shadow-brand-maroon'
                  : 'border border-border text-text-secondary hover:border-brand-maroon/50'
              }`}
            >
              <tab.Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-5">
        {activeTab === 'live' && <AdminLiveStats />}
        {activeTab === 'config' && <AdminConfigPanel />}
        {activeTab === 'users' && <AdminUserTable />}
        {activeTab === 'withdrawals' && <AdminWithdrawalQueue />}
        {activeTab === 'bonuses' && <AdminBonusPanel />}
        {activeTab === 'leaderboard' && <AdminLeaderboardPanel />}
        {activeTab === 'challenges' && <AdminChallengesPanel />}
        {activeTab === 'kyc' && isSuperAdmin && (
          <>
            <AdminKycSettings />
            <div className="mt-5">
              <AdminKycReviewPanel />
            </div>
          </>
        )}
        {activeTab === 'audit' && <AdminAuditLogViewer />}
        {activeTab === 'health' && <AdminHealthDashboard />}
        {activeTab === 'security' && <>
          <SeedRotationPanel />
          <div className="mt-5">
            <AdminBannerControl />
          </div>
        </>}
        {activeTab === 'account' && <AdminAccountSecurity currentUser={user} />}
      </div>
    </main>
  );
}
