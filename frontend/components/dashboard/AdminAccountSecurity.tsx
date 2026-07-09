'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN ACCOUNT SECURITY — password change + 2FA setup
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { Key, Shield, Eye, EyeOff, Check, AlertCircle, Loader2 } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

export default function AdminAccountSecurity({ currentUser }: { currentUser?: { username: string; role: string; twoFactorEnabled: boolean } }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [changing, setChanging] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [twoFaEnabled, setTwoFaEnabled] = useState<boolean>(currentUser?.twoFactorEnabled || false);
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauthUrl: string; qrDataUrl?: string } | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaMsg, setTwoFaMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetch2faStatus = async () => {
    try {
      const res = await fetch(`${API}/admin/2fa/status`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setTwoFaEnabled(data.enabled);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetch2faStatus();
  }, []);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'err', text: 'New passwords do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'err', text: 'Password must be at least 8 characters.' });
      return;
    }
    setChanging(true);
    setPasswordMsg(null);
    try {
      const res = await fetch(`${API}/admin/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (data.success) {
        setPasswordMsg({ type: 'ok', text: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setPasswordMsg({ type: 'err', text: data.error || 'Password change failed.' });
      }
    } catch {
      setPasswordMsg({ type: 'err', text: 'Network error.' });
    }
    setChanging(false);
  };

  const start2faSetup = async () => {
    setTwoFaLoading(true);
    setTwoFaMsg(null);
    try {
      const res = await fetch(`${API}/auth/2fa/setup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setTwoFaSetup({ secret: data.secret, otpauthUrl: data.otpauthUrl, qrDataUrl: data.qrDataUrl });
      } else {
        setTwoFaMsg({ type: 'err', text: data.error || '2FA setup failed.' });
      }
    } catch {
      setTwoFaMsg({ type: 'err', text: 'Network error.' });
    }
    setTwoFaLoading(false);
  };

  const verify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[0-9]{6}$/.test(twoFaCode)) {
      setTwoFaMsg({ type: 'err', text: 'Enter the 6-digit code from your authenticator app.' });
      return;
    }
    setTwoFaLoading(true);
    setTwoFaMsg(null);
    try {
      const res = await fetch(`${API}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: twoFaCode }),
      });
      const data = await res.json();
      if (data.success) {
        setTwoFaEnabled(true);
        setTwoFaSetup(null);
        setTwoFaCode('');
        setTwoFaMsg({ type: 'ok', text: '2FA enabled successfully.' });
      } else {
        setTwoFaMsg({ type: 'err', text: data.error || 'Verification failed.' });
      }
    } catch {
      setTwoFaMsg({ type: 'err', text: 'Network error.' });
    }
    setTwoFaLoading(false);
  };

  return (
    <div className="grid gap-5">
      {/* Password change */}
      <div className="glass-card overflow-hidden p-4">
        <div className="flex items-center gap-2 mb-4">
          <Key size={16} className="text-brand-maroon" />
          <h3 className="heading-display text-sm text-text-primary">Change Admin Password</h3>
        </div>

        <form onSubmit={changePassword} className="space-y-3 max-w-md">
          <div className="relative">
            <input
              type={showCurrent ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              className="input-cyber w-full pr-10 text-sm"
              required
            />
            <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
              {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="relative">
            <input
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (min 8 chars)"
              className="input-cyber w-full pr-10 text-sm"
              required
              minLength={8}
            />
            <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
              {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            className="input-cyber w-full text-sm"
            required
          />

          {passwordMsg && (
            <div className={`flex items-center gap-1.5 text-xs ${passwordMsg.type === 'ok' ? 'text-brand-green' : 'text-brand-red'}`}>
              {passwordMsg.type === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
              {passwordMsg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={changing}
            className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
          >
            {changing ? <Loader2 size={14} className="animate-spin inline mr-1" /> : null}
            Change Password
          </button>
        </form>
      </div>

      {/* 2FA setup */}
      <div className="glass-card overflow-hidden p-4">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-brand-green" />
          <h3 className="heading-display text-sm text-text-primary">Two-Factor Authentication</h3>
          <span className={`ml-auto text-[10px] px-2 py-0.5 rounded ${twoFaEnabled ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red'}`}>
            {twoFaEnabled ? 'Enabled' : 'Not Enabled'}
          </span>
        </div>

        {!twoFaEnabled && !twoFaSetup && (
          <button
            onClick={start2faSetup}
            disabled={twoFaLoading}
            className="btn-secondary text-sm px-4 py-2 disabled:opacity-50"
          >
            {twoFaLoading ? <Loader2 size={14} className="animate-spin inline mr-1" /> : null}
            Set Up 2FA
          </button>
        )}

        {twoFaSetup && (
          <form onSubmit={verify2fa} className="space-y-3 max-w-md">
            <p className="text-xs text-text-muted">Scan the QR code in your authenticator app, then enter the 6-digit code.</p>
            <div className="p-3 rounded bg-white inline-block">
              {twoFaSetup.qrDataUrl ? (
                <img
                  src={twoFaSetup.qrDataUrl}
                  alt="2FA QR code"
                  className="w-40 h-40"
                />
              ) : (
                <p className="text-xs text-text-muted">QR unavailable — use the secret below.</p>
              )}
            </div>
            <div className="text-[10px] text-text-muted font-mono break-all">Secret: {twoFaSetup.secret}</div>
            <input
              type="text"
              inputMode="numeric"
              value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit code"
              className="input-cyber w-full text-sm"
              maxLength={6}
            />
            {twoFaMsg && (
              <div className={`flex items-center gap-1.5 text-xs ${twoFaMsg.type === 'ok' ? 'text-brand-green' : 'text-brand-red'}`}>
                {twoFaMsg.type === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
                {twoFaMsg.text}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button type="submit" disabled={twoFaLoading} className="btn-primary text-sm px-4 py-2 disabled:opacity-50">
                {twoFaLoading ? <Loader2 size={14} className="animate-spin inline mr-1" /> : null}
                Verify & Enable
              </button>
              <button type="button" onClick={() => setTwoFaSetup(null)} className="text-xs text-text-muted hover:text-text-primary">Cancel</button>
            </div>
          </form>
        )}

        {twoFaEnabled && (
          <p className="text-xs text-text-secondary">2FA is active. Admins cannot disable 2FA through the UI for security reasons.</p>
        )}
      </div>
    </div>
  );
}
