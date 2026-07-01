'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  useSound — SFX playback with Howler.js, lazy-loaded
 * ═══════════════════════════════════════════════════════════════
 *
 *  Lazy-loads Howler.js so the bundle stays small for users who
 *  never trigger a sound (mobile data, etc.). Pre-loads a registry
 *  of named sounds; play/stop on demand.
 *
 *  HOW SOUND ASSETS WORK HERE:
 *    - Sound files live in `public/sounds/{name}.{ext}`.
 *    - Pass `name: 'coin-flip'` and the hook resolves to
 *      '/sounds/coin-flip.mp3' (or .ogg / .wav if configured).
 *    - File format fallback chain: mp3 → ogg → wav (browser picks).
 *
 *  ASSET STATUS (as of 2026-06-28):
 *    No sound files exist yet under /public/sounds/. This hook is
 *    ready to use — drop files in and they'll work. Until then,
 *    calls to playSound() are silent no-ops (no console errors).
 *
 *  USAGE:
 *    import { useSound } from '@/design-system/hooks/useSound';
 *
 *    function FlipButton() {
 *      const { play, stop } = useSound();
 *
 *      const handleFlip = () => {
 *        play('coin-flip');
 *        // ... actual flip logic ...
 *      };
 *
 *      return <button onClick={handleFlip}>Flip</button>;
 *    }
 *
 *  BROWSER AUTOPLAY POLICY:
 *    Most browsers block audio until the user has interacted with
 *    the page. The first call to play() inside a click handler
 *    "unlocks" audio for subsequent calls. No special handling
 *    needed here — Howler handles this transparently.
 * ═══════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type SoundName =
  | 'coin-flip'      // coin spinning
  | 'coin-land'      // coin lands on heads/tails
  | 'win'            // win celebration
  | 'lose'           // loss
  | 'rain'           // crypto rain claim
  | 'click'          // generic button click
  | 'notification';  // toast / ping

export type SoundExtension = 'mp3' | 'ogg' | 'wav';

export interface UseSoundOptions {
  /** Master volume (0-1). Default 0.5 (don't blast users). */
  volume?: number;
  /** Whether to preload all sounds on mount. Default true. */
  preload?: boolean;
  /** File extension preference. Default 'mp3'. */
  format?: SoundExtension;
}

export interface UseSoundReturn {
  /** Play a named sound. Returns the Howler sound ID for control. */
  play: (name: SoundName, options?: { volume?: number; rate?: number }) => number | null;
  /** Stop a specific playback by ID, or all of a name. */
  stop: (nameOrId: SoundName | number) => void;
  /** Stop all sounds. */
  stopAll: () => void;
  /** True once Howler is loaded and ready. */
  ready: boolean;
  /** Whether the user's browser has audio unlocked (has interacted). */
  unlocked: boolean;
}

// Registry of sound name → filename stem (without extension)
const SOUND_FILES: Record<SoundName, string> = {
  'coin-flip':     'coin-flip',
  'coin-land':     'coin-land',
  'win':           'win',
  'lose':          'lose',
  'rain':          'rain',
  'click':         'click',
  'notification':  'notification',
};

export function useSound(options: UseSoundOptions = {}): UseSoundReturn {
  const {
    volume: defaultVolume = 0.5,
    preload = true,
    format = 'mp3',
  } = options;

  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  // Refs to Howler instances — one per sound name
  const soundsRef = useRef<Map<SoundName, unknown>>(new Map());
  const HowlClassRef = useRef<typeof import('howler').Howl | null>(null);

  // Lazy-load Howler on mount (client-side only)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    (async () => {
      try {
        const mod = await import('howler');
        if (cancelled) return;
        // @types/howler exposes Howler as a namespace; howler.js exports
        // Howl/Howler as named exports (CJS interop). We only need Howl.
        HowlClassRef.current = (mod as unknown as { Howl: typeof import('howler').Howl }).Howl
          ?? (mod as unknown as { default: { Howl: typeof import('howler').Howl } }).default?.Howl
          ?? null;

        // Detect autoplay-unlock state. Browsers expose this via
        // a one-shot user-interaction listener.
        const onFirstInteract = () => {
          setUnlocked(true);
          window.removeEventListener('pointerdown', onFirstInteract);
          window.removeEventListener('keydown', onFirstInteract);
        };
        window.addEventListener('pointerdown', onFirstInteract, { once: true });
        window.addEventListener('keydown', onFirstInteract, { once: true });

        // Preload sounds if requested
        if (preload && HowlClassRef.current) {
          const Howl = HowlClassRef.current;
          for (const [name, stem] of Object.entries(SOUND_FILES)) {
            const src = [`/sounds/${stem}.${format}`];
            // Note: real production might try fallback formats, e.g.
            // [`/sounds/${stem}.${format}`, `/sounds/${stem}.ogg`]
            // For now, single format to keep things simple.
            const sound = new Howl({ src, volume: defaultVolume, preload: true });
            soundsRef.current.set(name as SoundName, sound);
          }
        }

        setReady(true);
      } catch (err) {
        // Howler failed to load (offline, blocked, etc.) — silent failure
        // is acceptable here, sounds are non-essential
        console.warn('[useSound] Howler failed to load:', err);
      }
    })();

    return () => {
      cancelled = true;
      // Stop and unload all sounds on unmount
      soundsRef.current.forEach((s) => {
        const howl = s as { stop: () => void; unload: () => void };
        try { howl.stop(); howl.unload(); } catch { /* ignore */ }
      });
      soundsRef.current.clear();
    };
  }, [defaultVolume, preload, format]);

  const play = useCallback(
    (name: SoundName, opts?: { volume?: number; rate?: number }): number | null => {
      const sound = soundsRef.current.get(name);
      if (!sound) return null;
      const howl = sound as { volume: (v: number, id?: number) => void; rate: (r: number, id?: number) => void; play: () => number };
      const vol = opts?.volume ?? defaultVolume;
      const id = howl.play();
      if (opts?.rate != null) howl.rate(opts.rate, id);
      howl.volume(vol, id);
      return id;
    },
    [defaultVolume],
  );

  const stop = useCallback((nameOrId: SoundName | number) => {
    if (typeof nameOrId === 'number') {
      // Stop by playback ID — walk all sounds and stop the matching ID
      soundsRef.current.forEach((s) => {
        const howl = s as { stop: (id?: number) => void };
        try { howl.stop(nameOrId); } catch { /* ignore */ }
      });
    } else {
      const sound = soundsRef.current.get(nameOrId);
      if (sound) {
        const howl = sound as { stop: () => void };
        try { howl.stop(); } catch { /* ignore */ }
      }
    }
  }, []);

  const stopAll = useCallback(() => {
    soundsRef.current.forEach((s) => {
      const howl = s as { stop: () => void };
      try { howl.stop(); } catch { /* ignore */ }
    });
  }, []);

  return { play, stop, stopAll, ready, unlocked };
}

export default useSound;