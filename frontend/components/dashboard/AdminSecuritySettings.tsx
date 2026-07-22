'use client';

import { useState, useEffect } from 'react';
import { Shield, ToggleLeft, ToggleRight, Loader2 } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';

export default function AdminSecuritySettings() {
  const { addToast } = useToast();
  const [required, setRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/admin/settings/admin-2fa-status')
      .then(r => r.json())
      .then(data => {
        setRequired(data.required === true);
        setLoading(false);
      })
      .catch(() => {
        addToast('Failed to load 2FA status', 'error');
        setLoading(false);
      });
  }, [addToast]);

  const toggle = async () => {
    setSaving(true);
    const next = !required;
    try {
      const res = await fetch('/api/admin/settings/admin_2fa_required', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next ? 'true' : 'false' }),
      });
      const data = await res.json();
      if (data.success) {
        setRequired(next);
        addToast(`Admin 2FA ${next ? 'enabled' : 'disabled'}`, 'success');
      } else {
        addToast(data.error || 'Failed to update', 'error');
      }
    } catch (err) {
      addToast('Network error', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-card p-6 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-brand-maroon" />
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-maroon/10 flex items-center justify-center text-brand-maroon">
            <Shield size={20} />
          </div>
          <div>
            <h3 className="heading-display text-sm">Admin 2FA Requirement</h3>
            <p className="text-text-muted text-xs font-mono">
              When enabled, all admin accounts must use two-factor authentication to log in.
            </p>
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={saving}
          className="text-brand-maroon hover:text-brand-maroon/80 disabled:opacity-50"
          title={required ? 'Disable admin 2FA requirement' : 'Enable admin 2FA requirement'}
        >
          {saving ? <Loader2 size={24} className="animate-spin" /> : required ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
        </button>
      </div>
      <div className={`text-xs font-mono px-3 py-2 rounded border ${required ? 'bg-brand-green/10 border-brand-green/30 text-brand-green' : 'bg-brand-gold/10 border-brand-gold/30 text-brand-gold'}`}>
        Status: <strong>{required ? 'REQUIRED' : 'OPTIONAL'}</strong>
        {required ? ' — admin users without 2FA cannot access the dashboard.' : ' — admin users can log in with username and password only.'}
      </div>
    </div>
  );
}
