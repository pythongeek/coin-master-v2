'use client';

/**
 * Service Worker registration (browser only).
 *
 * Registers /sw.js at the site root so the offline shell works across
 * the whole app. Skips registration in dev to avoid stale-cache pain.
 */

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    // Defer registration until after the page is idle so SW install
    // never competes with the initial paint for bandwidth.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch(() => {
          /* offline cache is a progressive enhancement */
        });
    };
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);
  return null;
}