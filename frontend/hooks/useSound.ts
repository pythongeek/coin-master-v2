'use client';

import { useCallback, useRef, useEffect } from 'react';
import { useGameStore } from '@/lib/store';

const SOUNDS = {
  flip: '/assets/flip.mp3',
  land: '/assets/land.mp3',
  win: '/assets/win.mp3',
  lose: '/assets/lose.mp3',
};

export function useSound() {
  const settings = useGameStore((s) => s.settings);
  const howlsRef = useRef<Record<string, any>>({});

  // Dynamically load howler client-side
  useEffect(() => {
    if (typeof window !== 'undefined') {
      import('howler').then(({ Howl }) => {
        Object.entries(SOUNDS).forEach(([key, path]) => {
          howlsRef.current[key] = new Howl({
            src: [path],
            volume: 0.4,
            preload: true,
          });
        });
      });
    }
  }, []);

  const playRainSynth = useCallback(() => {
    if (!settings.sound) return;
    if (typeof window === 'undefined') return;

    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

      const playChime = (freq: number, startTime: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);

        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.15, startTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + duration);
      };

      const now = ctx.currentTime;
      // Sparkling casino chime arpeggio
      playChime(587.33, now, 1.0);        // D5
      playChime(659.25, now + 0.12, 0.9);   // E5
      playChime(880.00, now + 0.24, 1.2);   // A5
      playChime(1174.66, now + 0.36, 1.5);  // D6
    } catch (e) {
      console.warn('Web Audio rain synth failed:', e);
    }
  }, [settings.sound]);

  const play = useCallback(
    (key: keyof typeof SOUNDS | 'rain') => {
      if (!settings.sound) return;

      if (key === 'rain') {
        playRainSynth();
        return;
      }

      const sound = howlsRef.current[key];
      if (sound) {
        sound.stop();
        sound.play();
      }
    },
    [settings.sound, playRainSynth]
  );

  return { play };
}
