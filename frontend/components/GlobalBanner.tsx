'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  GLOBAL BANNER — fetches public /api/public/banner and renders
 *  a dismissible announcement / maintenance banner on every page.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { X, AlertTriangle, Info } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';


// API base — `/api` on non-localhost (browser → nginx → backend),
// `http://localhost:4000` on localhost (browser → backend directly).
// All endpoint paths below should NOT include another `/api` prefix.
const API = getApiBase();

interface BannerData {
  enabled: boolean;
  type: 'info' | 'warning' | 'maintenance';
  message: string;
  link?: string;
  linkText?: string;
  dismissible?: boolean;
}

export default function GlobalBanner() {
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch(`${API}/public/banner`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.banner?.enabled) {
          setBanner(data.banner);
          const key = `banner-dismissed-${data.banner.message}`;
          setDismissed(localStorage.getItem(key) === '1');
        }
      })
      .catch(() => {});
  }, []);

  if (!banner || dismissed) return null;

  const isMaintenance = banner.type === 'maintenance';
  const Icon = isMaintenance ? AlertTriangle : Info;
  const bg = isMaintenance
    ? 'bg-brand-red/15 border-brand-red/40 text-brand-red'
    : banner.type === 'warning'
    ? 'bg-brand-gold/15 border-brand-gold/40 text-brand-gold'
    : 'bg-brand-info/15 border-brand-info/40 text-brand-info';

  const handleDismiss = () => {
    if (banner.dismissible !== false) {
      setDismissed(true);
      localStorage.setItem(`banner-dismissed-${banner.message}`, '1');
    }
  };

  return (
    <div className={`w-full border-b ${bg} px-4 py-2.5`}>
      <div className="max-w-5xl mx-auto flex items-center justify-center gap-3 text-xs font-mono">
        <Icon size={14} className="shrink-0" />
        <span className="text-center">{banner.message}</span>
        {banner.link && (
          <a href={banner.link} className="underline hover:no-underline shrink-0">
            {banner.linkText || 'Learn more'}
          </a>
        )}
        {banner.dismissible !== false && (
          <button onClick={handleDismiss} className="ml-2 p-0.5 rounded hover:bg-white/10 shrink-0" aria-label="Dismiss">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
