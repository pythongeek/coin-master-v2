'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  useTheme — Theme detection + toggle (dark-only stub)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Current state: dark-only. The CryptoFlip brand is built around
 *  a dark casino palette; a light theme would require reworking
 *  most color tokens. This hook provides the API surface so that
 *  light-theme support can be added later without changing
 *  call sites — only this file needs to change.
 *
 *  FUTURE WORK (when adding light theme):
 *    - Add `light` to Theme type
 *    - Toggle the `<html>` class from `dark` to `light`
 *    - Update tailwind.config.js `darkMode: 'class'`
 *    - Provide `light` variants for all design-system colors
 *    - Persist user choice in localStorage
 *
 *  USAGE:
 *    function ThemedComponent() {
 *      const { theme, setTheme, toggleTheme, isDark } = useTheme();
 *      return <div>Current theme: {theme} ({isDark ? '🌙' : '☀️'})</div>;
 *    }
 *
 *  SSR SAFETY:
 *    Returns `theme: 'dark'` and `isDark: true` on the server to
 *    match the rendered HTML (which always has `class="dark"`).
 *    After mount, syncs with system preference / localStorage.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';

export interface UseThemeReturn {
  /** Current theme. Always 'dark' on the server. */
  theme: Theme;
  /** Set theme explicitly. */
  setTheme: (theme: Theme) => void;
  /** Toggle between dark and light. */
  toggleTheme: () => void;
  /** True if theme is 'dark' (convenience). */
  isDark: boolean;
  /** True if theme is 'light' (convenience). */
  isLight: boolean;
  /** False until the hook has read the user's actual preference. */
  ready: boolean;
}

const STORAGE_KEY = 'cryptoflip-theme';

export function useTheme(): UseThemeReturn {
  // SSR — always render dark to match the static HTML
  const [theme, setThemeState] = useState<Theme>('dark');
  const [ready, setReady] = useState(false);

  // Read user's stored preference after mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (stored === 'dark' || stored === 'light') {
        setThemeState(stored);
      } else {
        // No stored preference — check system
        const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
        setThemeState(prefersLight ? 'light' : 'dark');
      }
    } catch {
      // localStorage unavailable (private browsing, etc.) — keep dark
    } finally {
      setReady(true);
    }
  }, []);

  // Sync DOM class with theme
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch {
      // ignore
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark: theme === 'dark',
    isLight: theme === 'light',
    ready,
  };
}

export default useTheme;