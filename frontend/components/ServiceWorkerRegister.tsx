'use client';

/**
 * Service Worker registration (browser only).
 *
 * Registers /sw.js at the site root so the offline shell works across
 * the whole app. Skips registration in dev to avoid stale-cache pain.
 *
 * P3-7-fix: a cache-buster query string is appended (?v=N) and bumped
 * for every release. The browser byte-compares the registered SW URL
 * against the served SW URL on each page load; if they differ, the
 * browser downloads the new SW and activates it on the next reload.
 * This is what makes fixes to public/sw.js actually take effect for
 * users with an already-installed SW.
 */

import { useEffect } from 'react';

// Version of the SW. Bump this whenever public/sw.js changes are
// shipped so existing users receive the update on their next page load.
// (The SW file itself has a file-content URL fingerprint, but adding
// ?v= to the registration URL is the deterministic, version-stamped
// pattern that survives minification / bundling.)
const SW_VERSION = '2';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    // Defer registration until after the page is idle so SW install
    // never competes with the initial paint for bandwidth.
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${SW_VERSION}`, { scope: '/' })
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