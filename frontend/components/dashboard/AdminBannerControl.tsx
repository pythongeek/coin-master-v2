'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN BANNER CONTROL — edit global announcement / maintenance banner
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { Megaphone, AlertTriangle, Info, Check, Loader2 } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type BannerType = 'info' | 'warning' | 'maintenance';

interface Banner {
  enabled: boolean;
  type: BannerType;
  message: string;
  link: string;
  linkText: string;
  dismissible: boolean;
}

const EMPTY_BANNER: Banner = {
  enabled: false,
  type: 'info',
  message: '',
  link: '',
  linkText: 'Learn more',
  dismissible: true,
};

export default function AdminBannerControl() {
  const [banner, setBanner] = useState<Banner>(EMPTY_BANNER);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchBanner = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/config/banner`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setBanner({ ...EMPTY_BANNER, ...data.banner });
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    fetchBanner();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/admin/config/banner`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(banner),
      });
      const data = await res.json();
      if (data.success) {
        addToast('Banner saved', 'success');
      } else {
        addToast(data.error || 'Failed to save banner', 'error');
      }
    } catch {
      addToast('Network error', 'error');
    }
    setSaving(false);
  };

  const update = (patch: Partial<Banner>) => setBanner((b) => ({ ...b, ...patch }));

  if (loading) {
    return <div className="glass-card p-4 text-text-muted text-sm">Loading banner...</div>;
  }

  return (
    <div className="glass-card overflow-hidden p-4">
      <div className="flex items-center gap-2 mb-4">
        <Megaphone size={16} className="text-brand-maroon" />
        <h3 className="heading-display text-sm text-text-primary">Global Announcement Banner</h3>
      </div>

      <div className="space-y-3 max-w-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={() => update({ enabled: !banner.enabled })}
            className={`relative w-14 h-7 rounded-full transition-all ${banner.enabled ? 'bg-brand-green' : 'bg-border'}`}
          >
            <span className={`absolute top-1 w-5 h-5 bg-void rounded-full transition-all ${banner.enabled ? 'left-8' : 'left-1'}`} />
          </button>
          <span className="text-sm text-text-secondary">{banner.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>

        <div className="flex gap-2">
          {(['info', 'warning', 'maintenance'] as BannerType[]).map((t) => (
            <button
              key={t}
              onClick={() => update({ type: t })}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border ${
                banner.type === t ? 'bg-brand-maroon text-white border-brand-maroon' : 'border-border text-text-secondary'
              }`}
            >
              {t === 'maintenance' ? <AlertTriangle size={12} /> : <Info size={12} />}
              {t}
            </button>
          ))}
        </div>

        <textarea
          value={banner.message}
          onChange={(e) => update({ message: e.target.value })}
          placeholder="Banner message (e.g. Scheduled maintenance at 02:00 UTC)"
          className="input-cyber w-full text-sm min-h-[80px]"
        />

        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            value={banner.link}
            onChange={(e) => update({ link: e.target.value })}
            placeholder="https://... (optional)"
            className="input-cyber w-full text-sm"
          />
          <input
            type="text"
            value={banner.linkText}
            onChange={(e) => update({ linkText: e.target.value })}
            placeholder="Link text"
            className="input-cyber w-full text-sm"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => update({ dismissible: !banner.dismissible })}
            className={`relative w-12 h-6 rounded-full transition-all ${banner.dismissible ? 'bg-brand-green' : 'bg-border'}`}
          >
            <span className={`absolute top-1 w-4 h-4 bg-void rounded-full transition-all ${banner.dismissible ? 'left-7' : 'left-1'}`} />
          </button>
          <span className="text-sm text-text-secondary">Dismissible</span>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin inline mr-1" /> : <Check size={14} className="inline mr-1" />}
          Save Banner
        </button>
      </div>
    </div>
  );
}
