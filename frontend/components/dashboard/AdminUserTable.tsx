'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN USER MANAGEMENT — User Management টেবিল
 * ═══════════════════════════════════════════════════════════════
 *
 *  এডমিন এখান থেকে:
 *  ① ইউজার খুঁজে বের করতে পারবে
 *  ② ইউজার ফ্রিজ/আনফ্রিজ করতে পারবে (সাসপেন্ড)
 *  ③ ব্যালেন্স ম্যানুয়ালি এডিট করতে পারবে (রিফান্ড/বোনাসের জন্য)
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Search, Check, X, Pencil, Lock, Unlock, ChevronLeft, ChevronRight } from 'lucide-react';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

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

export default function AdminUserTable() {
  const [users, setUsers]     = useState<UserRow[]>([]);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [page, setPage]       = useState(1);
  const [limit, setLimit]     = useState(20);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal]     = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBalance, setEditBalance] = useState('');

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchUsers = useCallback(async (q = '', p = 1, l = 20) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/dashboard/admin/users?search=${encodeURIComponent(q)}&page=${p}&limit=${l}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setUsers((data.data || []).map((u: any) => ({
          id: u.id,
          username: u.username,
          email: u.email ?? null,
          wallet_address: u.wallet_address ?? null,
          balance: parseFloat(u.balance || '0'),
          is_active: u.is_active,
          is_admin: u.is_admin,
          total_bets: parseInt(u.total_bets || '0', 10),
          net_pnl: parseFloat(u.net_pnl || '0'),
          created_at: u.created_at,
        })));
        setTotal(data.pagination?.total || 0);
        setTotalPages(data.pagination?.totalPages || 1);
      } else {
        setError(data.error || 'Failed to load users');
      }
    } catch (e) {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); fetchUsers(search, 1, limit); }, 400);
    return () => clearTimeout(timer);
  }, [search, limit, fetchUsers]);

  useEffect(() => {
    fetchUsers(search, page, limit);
  }, [page, fetchUsers]);

  // ── ইউজার ফ্রিজ/আনফ্রিজ ──────────────────────────────────────
  const toggleActive = async (user: UserRow) => {
    if (user.is_admin) return;
    const newStatus = !user.is_active;
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: newStatus } : u));
    try {
      const res = await fetch(`${API}/dashboard/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: newStatus }),
      });
      const data = await res.json();
      if (!data.success) {
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: !newStatus } : u));
        setError(data.error || 'Update failed');
      }
    } catch {
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: !newStatus } : u));
      setError('Network error');
    }
  };

  // ── ব্যালেন্স এডিট সেভ করো ───────────────────────────────────
  const saveBalance = async (userId: string) => {
    const newBalance = parseFloat(editBalance);
    if (isNaN(newBalance) || newBalance < 0) return;

    const prevBalance = users.find(u => u.id === userId)?.balance ?? 0;
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, balance: newBalance } : u));
    setEditingId(null);

    try {
      const res = await fetch(`${API}/dashboard/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ balance: newBalance }),
      });
      const data = await res.json();
      if (!data.success) {
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, balance: prevBalance } : u));
        setError(data.error || 'Balance update failed');
      }
    } catch {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, balance: prevBalance } : u));
      setError('Network error');
    }
  };

  return (
    <div className="glass-card overflow-hidden">
      {/* হেডার ও সার্চ */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <h3 className="heading-display text-sm text-text-primary">User Management</h3>
        <div className="relative max-w-xs w-full">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search username or email..."
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
              {['User', 'Contact', 'Balance', 'Bets', 'P&L', 'Status', 'Actions'].map(h => (
                <th key={h} className="px-4 py-2 font-mono font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">Loading...</td></tr>
            ) : error ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-brand-red">{error}</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">No users found.</td></tr>
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
                        title="Edit balance"
                      >
                        ${u.balance.toFixed(2)} <Pencil size={11} className="text-text-muted" />
                      </button>
                    )}
                  </td>

                  {/* Number of bets */}
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
                      {u.is_active ? 'Active' : 'Frozen'}
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
                        {u.is_active ? 'Freeze' : 'Unfreeze'}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-3">
        <div className="text-xs text-text-muted">
          Showing {users.length} of {total} users
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2 py-1 rounded border border-border text-text-secondary disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs text-text-muted">Page {page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-2 py-1 rounded border border-border text-text-secondary disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value))}
            className="ml-2 px-2 py-1 rounded border border-border text-xs bg-void text-text-secondary"
          >
            {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
