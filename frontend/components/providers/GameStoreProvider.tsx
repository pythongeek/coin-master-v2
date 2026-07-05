'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME STORE PROVIDER — Wraps the app with Zustand rehydration
 *  and global Toast notifications.
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, type ReactNode } from 'react';
import { useGameStore } from '@/lib/store';
import { ToastProvider } from './ToastProvider';

export function GameStoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Ensure the Zustand store rehydrates from localStorage on the client.
    // This is especially important when the persist middleware is used.
    void useGameStore.persist?.rehydrate?.();
  }, []);

  return (
    <ToastProvider>
      <>{children}</>
    </ToastProvider>
  );
}
