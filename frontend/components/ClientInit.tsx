'use client';
/**
 * ===============================================================
 *  CLIENT INIT — hydrate the auth store from /api/auth/me on mount
 * ===============================================================
 *
 *  PR-1B. After the httpOnly cf_token cookie is set on login, the
 *  browser holds the JWT but client JS cannot read it. The only way
 *  for the client to know who the user is, is to call /api/auth/me;
 *  the browser auto-attaches the cookie for same-origin requests.
 *
 *  layout.tsx is a Server Component and cannot use Zustand hooks.
 *  This client component runs inside <body>, mounts on first paint,
 *  and kicks off exactly one initialize() per browser session.
 */


import { useEffect } from 'react';
import { useGameStore } from '@/lib/store';

export function ClientInit(): null {
  const initialize = useGameStore((s) => s.initialize);

  useEffect(() => {
    // Fire-and-forget. initialize() is idempotent: subsequent calls
    // just re-fetch /api/auth/me and overwrite the store. Safe to
    // re-run on hot-reload in dev.
    void initialize();
  }, [initialize]);

  return null;
}
