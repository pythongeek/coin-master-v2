'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN USER MANAGEMENT — ইউজার ম্যানেজমেন্ট টেবিল
 * ═══════════════════════════════════════════════════════════════
 *
 *  এডমিন এখান থেকে:
 *  ① ইউজার খুঁজে বের করতে পারবে
 *  ② ইউজার ফ্রিজ/আনফ্রিজ করতে পারবে (সাসপেন্ড)
 *  ③ ব্যালেন্স ম্যানুয়ালি এডিট করতে পারবে (রিফান্ড/বোনাসের জন্য)
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Search, Check, X, Pencil, Lock, Unlock } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface UserRow {
  id:             string;
  username:       string;
  email:          string | null;
  wallet_address: string | null;
  balance:        number;
  is_active:      boolean;
  is_admin:       boolean;
  total_bets:     number;
  net_pnl:        number;
  created_at:     string;
}

// ডেমো ডেটা — ব্যাকএন্ড কানেক্ট না থাকলে দেখাবে
const DEMO_USERS: UserRow[] = [
  { id: '1', username: 'rakib_99',    email: 'rakib@example.com', wallet_address: null, balance: 142.50, is_active: true,  is_admin: false, total_bets: 312, net_pnl: 42.50,  created_at: '2026-05-12' },
  { id: '2', username: 'player_a3f2', email: null, wallet_address: '0xA3f2...8B1c', balance: 8.20,   is_active: true,  is_admin: false, total_bets: 88,  net_pnl: -91.80, created_at: '2026-06-01' },
  { id: '3', username: 'sumaiya_k',   email: 'sumaiya@example.com', wallet_address: null, balance: 0.00, is_active: false, is_admin: false, total_bets: 1204,net_pnl: -340.10, created_at: '2026-03-22' },
  { id: '4', username: 'admin_main',  email: 'admin@cryptoflip.com', wallet_address: null, balance: 1000.00, is_active: true, is_admin: true, total_bets: 0, net_pnl: 0, created_at: '2026-01-01' },
];

export default function AdminUserTable() {
  const [users, setUsers]     = useState<UserRow[]>([]);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBalance, setEditBalance] = useState('');

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchUsers = useCallback(async (q = '') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/dashboard/admin/users?search=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setUsers(data.data || []);
      } else {
        setError(data.error || 'ইউজার লোড করতে ব্যর্থ');
      }
    } catch (e) {
      setError('ব্যাকএন্ডের সাথে সংযোগ স্থাপন করা যায়নি');
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => fetchUsers(search), 400); // ডিবাউন্স
    return () => clearTimeout(timer);
  }, [search, fetchUsers]);

  // ── ইউজার ফ্রিজ/আনফ্রিজ ──────────────────────────────────────
  const toggleActive = async (user: UserRow) => {
    const newStatus = !user.is_active;
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: newStatus } : u));

    try {
      await fetch(`${API}/api/dashboard/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: newStatus }),
      });
    } catch { /* demo mode */ }
  };

  // ── ব্যালেন্স এডিট সেভ করো ───────────────────────────────────
  const saveBalance = async (userId: string) => {
    const newBalance = parseFloat(editBalance);
    if (isNaN(newBalance) || newBalance < 0) return;

    setUsers(prev => prev.map(u => u.id === userId ? { ...u, balance: newBalance } : u));
    setEditingId(null);

    try {
      await fetch(`${API}/api/dashboard/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ balance: newBalance }),
      });
    } catch { /* demo mode */ }
  };

  return (
    <div className="glass-card overflow-hidden">
      {/* হেডার ও সার্চ */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <h3 className="heading-display text-sm text-text-primary">ইউজার ম্যানেজমেন্ট</h3>
        <div className="relative max-w-xs w-full">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="ইউজারনেম বা ইমেইল খুঁজুন..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-cyber text-xs py-1.5 pl-8"
          />
        </div>
      </div>

      {/* টেবিল */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              {['ইউজার', 'যোগাযোগ', 'ব্যালেন্স', 'বেট', 'P&L', 'স্ট্যাটাস', 'অ্যাকশন'].map(h => (
                <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">লোড হচ্ছে...</td></tr>
            ) : error ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-brand-red">{error}</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">কোনো ইউজার পাওয়া যায়নি।</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-b border-border/50 hover:bg-white/2">
                  {/* ইউজার */}
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-text-primary">{u.username}</span>
                      {u.is_admin && (
                        <span className="px-1.5 py-0.5 rounded bg-brand-maroon/20 text-brand-maroon text-[10px]">ADMIN</span>
                      )}
                    </div>
                  </td>

                  {/* যোগাযোগ */}
                  <td className="px-4 py-2.5 text-text-muted">
                    {u.email || (u.wallet_address ? `${u.wallet_address.slice(0,6)}...${u.wallet_address.slice(-4)}` : '—')}
                  </td>

                  {/* ব্যালেন্স — এডিটেবল */}
                  <td className="px-4 py-2.5">
                    {editingId === u.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          value={editBalance}
                          onChange={(e) => setEditBalance(e.target.value)}
                          className="w-20 px-2 py-1 bg-void border border-brand-green/50 rounded text-brand-green"
                          autoFocus
                        />
                        <button onClick={() => saveBalance(u.id)} className="text-brand-green"><Check size={13} /></button>
                        <button onClick={() => setEditingId(null)} className="text-brand-red"><X size={13} /></button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingId(u.id); setEditBalance(String(u.balance)); }}
                        className="flex items-center gap-1.5 text-brand-green hover:underline"
                        title="ব্যালেন্স এডিট করুন"
                      >
                        ${u.balance.toFixed(2)} <Pencil size={11} className="text-text-muted" />
                      </button>
                    )}
                  </td>

                  {/* বেট সংখ্যা */}
                  <td className="px-4 py-2.5 text-text-secondary">{u.total_bets}</td>

                  {/* P&L */}
                  <td className={`px-4 py-2.5 font-semibold ${u.net_pnl >= 0 ? 'text-brand-green' : 'text-brand-red'}`}>
                    {u.net_pnl >= 0 ? '+' : ''}{u.net_pnl.toFixed(2)}
                  </td>

                  {/* স্ট্যাটাস */}
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                      u.is_active
                        ? 'bg-brand-green/15 text-brand-green'
                        : 'bg-brand-red/15 text-brand-red'
                    }`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      {u.is_active ? 'সক্রিয়' : 'ফ্রিজড'}
                    </span>
                  </td>

                  {/* অ্যাকশন */}
                  <td className="px-4 py-2.5">
                    {!u.is_admin && (
                      <button
                        onClick={() => toggleActive(u)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] border transition-all ${
                          u.is_active
                            ? 'border-brand-red/35 text-brand-red hover:bg-brand-red/10'
                            : 'border-brand-green/35 text-brand-green hover:bg-brand-green/10'
                        }`}
                      >
                        {u.is_active ? <Lock size={11} /> : <Unlock size={11} />}
                        {u.is_active ? 'ফ্রিজ করুন' : 'আনফ্রিজ করুন'}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
