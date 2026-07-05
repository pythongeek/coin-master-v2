'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN PANEL PAGE — Super Admin Control Room
 *
 *  Server-side gate: /api/auth/me must return { role: 'super_admin' }
 *  or 'support'/'finance'/'auditor'. localStorage is used only as
 *  a UI hint; the actual access check is server-authoritative.
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BarChart3, Settings, Users, ShieldCheck, Gift, Wallet, FileText, Key, Activity, LogOut, AlertCircle, Trophy, type LucideIcon } from 'lucide-react';
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
import AdminLeaderboardPanel from '@/components/dashboard/AdminLeaderboardPanel';
import { useToast } from '@/components/providers/ToastProvider';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const TABS: { id: 'live' | 'config' | 'users' | 'withdrawals' | 'bonuses' | 'leaderboard' | 'audit' | 'health' | 'security' | 'kyc' | 'account'; label: string; Icon: LucideIcon }[] = [
  { id: 'live',     label: 'Live Stats', Icon: BarChart3 },
  { id: 'config',   label: 'Game Config', Icon: Settings },
  { id: 'users',    label: 'Users',      Icon: Users },
  { id: 'withdrawals', label: 'Withdrawals', Icon: Wallet },
  { id: 'bonuses',  label: 'Bonuses',    Icon: Gift },
  { id: 'leaderboard', label: 'Leaderboard', Icon: Trophy },
  { id: 'kyc',      label: 'KYC Review', Icon: ShieldCheck },
  { id: 'audit',    label: 'Audit Logs', Icon: FileText },
  { id: 'health',   label: 'Health',     Icon: Activity },
  { id: 'security', label: 'Security',   Icon: ShieldCheck },
  { id: 'account',  label: 'Account',    Icon: Key },
];

type TabId = typeof TABS[number]['id'];

const ADMIN_ROLES = ['super_admin', 'admin', 'support', 'finance', 'auditor'];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabId>('live');
  const [status, setStatus] = useState<'loading' | 'denied' | 'no-token' | 'allowed'>('loading');
  const [deniedReason, setDeniedReason] = useState<string>('');
  const [user, setUser] = useState<{ username: string; role: string; twoFactorEnabled: boolean } | null>(null);
  const router = useRouter();
  const { addToast } = useToast();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
    if (!token) {
      setStatus('no-token');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.success) {
          // Token invalid — clear and redirect to login
          localStorage.removeItem('cf_token');
          localStorage.removeItem('cf_user');
          setStatus('no-token');
          return;
        }
        const rawRole = data.data?.role;
        const role =
          rawRole === 'super_admin' || rawRole === 'admin'
            ? rawRole
            : data.data?.isAdmin
            ? 'admin'
            : rawRole || 'user';
        if (!ADMIN_ROLES.includes(role)) {
          setDeniedReason(
            `Logged in as ${data.data?.username || 'unknown'} with role '${role}'. Only admin accounts may access this panel.`
          );
          setStatus('denied');
          return;
        }
        setUser({
          username: data.data.username,
          role,
          twoFactorEnabled: !!data.data.two_factor_enabled,
        });
        setStatus('allowed');
        // Cache user for UI consumers
        try {
          localStorage.setItem('cf_user', JSON.stringify({
            ...data.data,
            isAdmin: true,
            role,
          }));
        } catch { /* ignore */ }
      } catch {
        if (!cancelled) setStatus('denied');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const logout = () => {
    localStorage.removeItem('cf_token');
    localStorage.removeItem('cf_user');
    addToast('Logged out', 'info');
    router.replace('/game');
  };

  if (status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center text-text-muted">
        <p>Checking admin access…</p>
      </main>
    );
  }

  if (status === 'no-token') {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 text-center">
          <LogOut size={32} className="mx-auto text-text-muted mb-3" />
          <h2 className="heading-display text-lg text-text-primary mb-2">Admin login required</h2>
          <p className="text-text-muted text-sm font-mono mb-4">
            You need to be signed in as an admin to view this panel.
          </p>
          <button
            onClick={() => router.push('/game?login=admin')}
            className="btn-brand py-2 px-5 rounded-lg font-mono text-sm"
          >
            Go to login
          </button>
        </div>
      </main>
    );
  }

  if (status === 'denied') {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card max-w-md w-full p-6 text-center">
          <AlertCircle size={32} className="mx-auto text-brand-red mb-3" />
          <h2 className="heading-display text-lg text-text-primary mb-2">Access denied</h2>
          <p className="text-text-muted text-sm font-mono mb-4">
            {deniedReason || 'Your account does not have admin privileges.'}
          </p>
          <button
            onClick={() => router.replace('/game')}
            className="btn-brand py-2 px-5 rounded-lg font-mono text-sm"
          >
            Back to game
          </button>
        </div>
      </main>
    );
  }

  // status === 'allowed'
  const isSuperAdmin = user?.role === 'super_admin';
  const needs2FA = user && !user.twoFactorEnabled;

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        <div className="w-11 h-11 rounded-xl bg-brand-maroon/10 border border-brand-maroon/25
                        flex items-center justify-center text-brand-maroon">
          <Settings size={20} />
        </div>
        <div>
          <h1 className="heading-display text-xl text-text-primary">Admin Panel</h1>
          <p className="text-text-muted text-xs font-mono">
            CryptoFlip · <span className="text-text-primary">{user?.username}</span> · {user?.role}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
          // Hide KYC review until panel is wired
          if (tab.id === 'kyc' && !isSuperAdmin) return null;
          return (
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
          );
        })}
      </div>

      <div className="space-y-5">
        {activeTab === 'live'     && <AdminLiveStats />}
        {activeTab === 'config'   && <AdminConfigPanel />}
        {activeTab === 'users'    && <AdminUserTable />}
        {activeTab === 'withdrawals' && <AdminWithdrawalQueue />}
        {activeTab === 'bonuses'  && <AdminBonusPanel />}
        {activeTab === 'leaderboard' && <AdminLeaderboardPanel />}
        {activeTab === 'kyc'      && isSuperAdmin && <AdminKycReviewPanel />}
        {activeTab === 'audit'    && <AdminAuditLogViewer />}
        {activeTab === 'health'   && <AdminHealthDashboard />}
        {activeTab === 'security' && <>
          <SeedRotationPanel />
          <div className="mt-5">
            <AdminBannerControl />
          </div>
        </>}
        {activeTab === 'account'  && user && <AdminAccountSecurity currentUser={user} />}
      </div>
    </main>
  );
}
