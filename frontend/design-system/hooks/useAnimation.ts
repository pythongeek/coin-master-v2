'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  useAnimation — Pre-built framer-motion variants + helpers
 * ═══════════════════════════════════════════════════════════════
 *
 *  Wraps the design-system animation tokens into framer-motion
 *  Variants objects so components can consume them via:
 *
 *    const { variants, transitions } = useAnimation();
 *    <motion.div variants={variants.liftIn} {...} />
 *
 *  WHAT'S PROVIDED:
 *    - variants           → named Variants objects (liftIn, floatUp,
 *                           winPunch, loseShake, coinFlip, etc.)
 *    - transitions        → reusable Transition configs (snap, smooth,
 *                           spring, bounce)
 *    - staggerChildren   → helper for parent containers that want
 *                           staggered child animations
 *
 *  USAGE:
 *    import { useAnimation } from '@/design-system/hooks/useAnimation';
 *
 *    function CoinResult({ result }: { result: 'heads' | 'tails' }) {
 *      const { variants, transitions } = useAnimation();
 *      return (
 *        <motion.div
 *          variants={variants.winPunch}
 *          initial="hidden"
 *          animate="visible"
 *          transition={transitions.spring}
 *        >
 *          {result === 'heads' ? '😀' : '😢'}
 *        </motion.div>
 *      );
 *    }
 *
 *  WHY THIS HOOK:
 *    Without it, every component would either:
 *      - duplicate the same Variants/Transition literal, OR
 *      - import framer-motion directly and re-derive values that
 *        could drift from the design-system tokens.
 *    This hook bridges the design-system animations to framer-motion.
 * ═══════════════════════════════════════════════════════════════
 */

import { useMemo } from 'react';
import type { Variants, Transition } from 'framer-motion';
import { duration, easing } from '@/design-system/tokens/animations';

export interface UseAnimationReturn {
  /** Named framer-motion Variants objects. */
  variants: {
    liftIn:    Variants;
    floatUp:   Variants;
    winPunch:  Variants;
    loseShake: Variants;
    coinFlip:  Variants;
    pulseSoft: Variants;
    fadeIn:    Variants;
    scaleIn:   Variants;
  };
  /** Reusable Transition configs. */
  transitions: {
    /** Quick snap, no overshoot (UI toggles) */
    snap: Transition;
    /** Smooth ease-out (most UI) */
    smooth: Transition;
    /** Spring (playful bounces) */
    spring: Transition;
    /** Bouncy (celebrations) */
    bounce: Transition;
    /** Slow dramatic (win screen, page enter) */
    dramatic: Transition;
  };
  /** Returns a stagger Transition for parent containers. */
  staggerChildren: (delayChildren?: number, stagger?: number) => Variants;
}

export function useAnimation(): UseAnimationReturn {
  return useMemo(() => {
    // ── Variants ───────────────────────────────────────────────
    const variants: UseAnimationReturn['variants'] = {
      liftIn: {
        hidden: { opacity: 0, y: 4, scale: 0.98 },
        visible: { opacity: 1, y: 0, scale: 1 },
      },
      floatUp: {
        hidden: { opacity: 0, y: 8 },
        visible: { opacity: 1, y: 0 },
      },
      winPunch: {
        hidden: { scale: 0.5, opacity: 0 },
        visible: {
          scale: [0.5, 1.15, 1],
          opacity: [0, 1, 1],
          transition: { duration: duration.medium, ease: easing.inOutBack },
        },
      },
      loseShake: {
        hidden: { x: 0 },
        visible: {
          x: [0, -4, 4, -4, 4, 0],
          transition: { duration: duration.medium, ease: easing.inOut },
        },
      },
      coinFlip: {
        hidden: { rotateY: 0 },
        visible: {
          rotateY: 1800,
          transition: { duration: duration.coinSpin, ease: easing.outExpo },
        },
      },
      pulseSoft: {
        hidden: { opacity: 1 },
        visible: {
          opacity: [1, 0.55, 1],
          transition: {
            duration: duration.slow * 0.8,
            repeat: Infinity,
            ease: easing.inOutCubic,
          },
        },
      },
      fadeIn: {
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
      },
      scaleIn: {
        hidden: { opacity: 0, scale: 0.9 },
        visible: { opacity: 1, scale: 1 },
      },
    };

    // ── Transitions ───────────────────────────────────────────
    const transitions: UseAnimationReturn['transitions'] = {
      snap:     { duration: duration.fast, ease: easing.out },
      smooth:   { duration: duration.base, ease: easing.outExpo },
      spring:   { type: 'spring', stiffness: 280, damping: 24 },
      bounce:   { type: 'spring', stiffness: 400, damping: 12 },
      dramatic: { duration: duration.long, ease: easing.inOutCubic },
    };

    // ── Stagger helper ─────────────────────────────────────────
    const staggerChildren = (delayChildren = 0, stagger = 0.05): Variants => ({
      hidden: {},
      visible: {
        transition: {
          staggerChildren: stagger,
          delayChildren,
        },
      },
    });

    return { variants, transitions, staggerChildren };
  }, []);
}

export default useAnimation;