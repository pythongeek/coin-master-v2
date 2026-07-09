'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN KYC SETTINGS — Configure MiniMax API key and KYC thresholds
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { Key, Shield, Loader2, Check, AlertCircle, Save, Eye, EyeOff } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface KycSettings {
  provider: string;
  minimaxApiKeySet: boolean;
  minimaxModel: string;
  minimaxBaseUrl: string;
  requiredForWithdrawal: boolean;
  requiredForBetAbove: number;
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  maxFileSizeBytes: number;
  allowedExtensions: string[];
}

export default function AdminKycSettings() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const [settings, setSettings] = useState<KycSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [keyMsg, setKeyMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API}/kyc/admin/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.settings);
      } else {
        setMsg({ type: 'err', text: data.error || 'Failed to load settings' });
      }
    } catch {
      setMsg({ type: 'err', text: 'Network error' });
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`${API}/kyc/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          provider: settings.provider,
          minimaxModel: settings.minimaxModel,
          minimaxBaseUrl: settings.minimaxBaseUrl,
          requiredForWithdrawal: settings.requiredForWithdrawal,
          requiredForBetAbove: settings.requiredForBetAbove,
          autoApproveThreshold: settings.autoApproveThreshold,
          autoRejectThreshold: settings.autoRejectThreshold,
          maxFileSizeBytes: settings.maxFileSizeBytes,
          allowedExtensions: settings.allowedExtensions,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'ok', text: 'Settings saved.' });
      } else {
        setMsg({ type: 'err', text: data.error || 'Failed to save' });
      }
    } catch {
      setMsg({ type: 'err', text: 'Network error' });
    }
    setSaving(false);
  };

  const saveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey || apiKey.length < 20) {
      setKeyMsg({ type: 'err', text: 'Enter a valid MiniMax API key.' });
      return;
    }
    setKeySaving(true);
    setKeyMsg(null);
    try {
      const res = await fetch(`${API}/kyc/admin/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (data.success) {
        setKeyMsg({ type: 'ok', text: data.message || 'API key saved.' });
        setApiKey('');
        fetchSettings();
      } else {
        setKeyMsg({ type: 'err', text: data.error || 'Failed to save API key' });
      }
    } catch {
      setKeyMsg({ type: 'err', text: 'Network error' });
    }
    setKeySaving(false);
  };

  if (!settings) {
    return (
      <div className="glass-card p-6 flex items-center gap-2 text-text-muted text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading KYC settings…
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="glass-card overflow-hidden p-4">
        <div className="flex items-center gap-2 mb-4">
          <Key size={16} className="text-brand-maroon" />
          <h3 className="heading-display text-sm text-text-primary">MiniMax API Key</h3>
          <span className={`ml-auto text-[10px] px-2 py-0.5 rounded ${settings.minimaxApiKeySet ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red'}`}>
            {settings.minimaxApiKeySet ? 'Set' : 'Not Set'}
          </span>
        </div>

        <form onSubmit={saveApiKey} className="space-y-3 max-w-xl">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.minimaxApiKeySet ? 'Enter new key to rotate' : 'Paste MiniMax API key'}
              className="input-cyber w-full pr-10 text-sm font-mono"
            />
            <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-text-muted">The key is encrypted in the database and never returned to the UI.</p>
          {keyMsg && (
            <div className={`flex items-center gap-1.5 text-xs ${keyMsg.type === 'ok' ? 'text-brand-green' : 'text-brand-red'}`}>
              {keyMsg.type === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
              {keyMsg.text}
            </div>
          )}
          <button type="submit" disabled={keySaving} className="btn-primary text-sm px-4 py-2 disabled:opacity-50">
            {keySaving ? <Loader2 size={14} className="animate-spin inline mr-1" /> : null}
            Save API Key
          </button>
        </form>
      </div>

      <div className="glass-card overflow-hidden p-4">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-brand-info" />
          <h3 className="heading-display text-sm text-text-primary">KYC Policy</h3>
        </div>

        <form onSubmit={saveSettings} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">Provider</span>
            <select
              value={settings.provider}
              onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
              className="input-cyber w-full"
            >
              <option value="minimax">MiniMax M3 Vision</option>
              <option value="manual">Manual Review Only</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">MiniMax Model</span>
            <input
              type="text"
              value={settings.minimaxModel}
              onChange={(e) => setSettings({ ...settings, minimaxModel: e.target.value })}
              className="input-cyber w-full"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">Auto-approve threshold (0–100)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={settings.autoApproveThreshold}
              onChange={(e) => setSettings({ ...settings, autoApproveThreshold: Number(e.target.value) })}
              className="input-cyber w-full"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">Auto-reject threshold (0–100)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={settings.autoRejectThreshold}
              onChange={(e) => setSettings({ ...settings, autoRejectThreshold: Number(e.target.value) })}
              className="input-cyber w-full"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">Require KYC for bets above ($)</span>
            <input
              type="number"
              min={0}
              value={settings.requiredForBetAbove}
              onChange={(e) => setSettings({ ...settings, requiredForBetAbove: Number(e.target.value) })}
              className="input-cyber w-full"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-text-secondary text-xs font-mono">Max file size (bytes)</span>
            <input
              type="number"
              min={1024}
              value={settings.maxFileSizeBytes}
              onChange={(e) => setSettings({ ...settings, maxFileSizeBytes: Number(e.target.value) })}
              className="input-cyber w-full"
            />
          </label>

          <label className="flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox"
              checked={settings.requiredForWithdrawal}
              onChange={(e) => setSettings({ ...settings, requiredForWithdrawal: e.target.checked })}
              className="accent-brand-maroon"
            />
            <span className="text-text-secondary text-xs font-mono">Require KYC before withdrawal</span>
          </label>

          <div className="md:col-span-2 flex items-center gap-3">
            {msg && (
              <div className={`flex items-center gap-1.5 text-xs ${msg.type === 'ok' ? 'text-brand-green' : 'text-brand-red'}`}>
                {msg.type === 'ok' ? <Check size={13} /> : <AlertCircle size={13} />}
                {msg.text}
              </div>
            )}
            <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-2 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin inline mr-1" /> : <Save size={14} className="inline mr-1" />}
              Save Policy
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
