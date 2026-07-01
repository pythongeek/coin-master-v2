/**
 * ═══════════════════════════════════════════════════════════════
 *  ANIMATION TOKENS — Timing functions + duration + keyframes
 * ═══════════════════════════════════════════════════════════════
 *
 *  TS-mirror of `tailwind.config.js` → `theme.extend.animation` + `keyframes`.
 *
 *  THREE LAYERS:
 *    1. `duration`  — how long (in ms). Sourced from common UI patterns.
 *    2. `easing`    — cubic-bezier curves for the feel.
 *    3. `keyframes` — named animation definitions reusable across
 *                     Tailwind classes and JS animations.
 *
 *  USAGE:
 *    - Tailwind: `className="animate-float-up"` (uses built-in keyframes)
 *    - framer-motion: `transition={{ duration: 0.4, ease: easing.outExpo }}`
 *    - Three.js / canvas: `easing.inOutCubic(x)` for value interpolation
 *    - CSS-in-JS: `{ animation: `${keyframes.floatUp} 0.4s ${easing.outExpo}` }`
 *
 *  EASING REFERENCE:
 *    - outExpo:    aggressive deceleration (great for "entering" UI)
 *    - inOutCubic: symmetric ease (great for state changes)
 *    - inOutBack:  overshoots at endpoints (great for celebratory bounces)
 *    - linear:     constant speed (great for spinners, marquees)
 * ═══════════════════════════════════════════════════════════════
 */

/** ── DURATIONS (in seconds — keep all durations in seconds) ───── */
/**
 * Common UI animation durations. Anything below 100ms feels laggy
 * (the eye can't track it); anything above 600ms feels slow.
 */
export const duration = {
  /** 50ms — micro-feedback (hover, focus) */
  instant: 0.05,
  /** 100ms — quick feedback (button press) */
  fast:    0.1,
  /** 200ms — small UI changes (icon swap, dropdown open) */
  short:   0.2,
  /** 300ms — default for most UI (modals, tooltips, toggles) */
  base:    0.3,
  /** 400ms — noticeable animations (panel slide, card flip) */
  medium:  0.4,
  /** 600ms — prominent animations (page transitions) */
  long:    0.6,
  /** 1000ms — slow animations (coin flip, big celebrations) */
  slow:    1.0,
  /** 3000ms — coin spin duration (matches guide's `coinSpinDurationMs`) */
  coinSpin: 3.0,
  /** 1500ms — cooldown between games (matches guide's `cooldownBetweenGamesMs`) */
  gameCooldown: 1.5,
} as const;

export type DurationToken = keyof typeof duration;

/** ── EASING CURVES (cubic-bezier tuples) ─────────────────────── */
/**
 * Cubic bezier curves as `[x1, y1, x2, y2]` tuples.
 * Compatible with CSS `cubic-bezier()` and framer-motion `cubicBezier()`.
 *
 * To use in framer-motion:
 *   import { cubicBezier } from 'framer-motion';
 *   const curve = cubicBezier(...easing.outExpo);
 *   <motion.div transition={{ duration: 0.4, ease: curve }} />
 */
export const easing = {
  /** Default ease-out for most UI */
  default:     [0.4, 0.0, 0.2, 1] as const,
  /** Linear — constant speed (spinners) */
  linear:      [0.0, 0.0, 1.0, 1.0] as const,
  /** ease-in (slow start, fast end) — exiting UI */
  in:          [0.4, 0.0, 1.0, 1.0] as const,
  /** ease-out (fast start, slow end) — entering UI */
  out:         [0.0, 0.0, 0.2, 1.0] as const,
  /** ease-in-out (slow both ends) — state changes */
  inOut:       [0.4, 0.0, 0.2, 1.0] as const,
  /** out-expo — aggressive deceleration, punchy entrance */
  outExpo:     [0.16, 1, 0.3, 1] as const,
  /** in-out-cubic — smooth symmetric */
  inOutCubic:  [0.65, 0, 0.35, 1] as const,
  /** in-out-back — overshoots endpoints, celebratory bounce */
  inOutBack:   [0.68, -0.55, 0.265, 1.55] as const,
} as const;

export type EasingToken = keyof typeof easing;

/** ── JS-VALUE EASING FUNCTIONS ───────────────────────────────── */
/**
 * Pure-JS easing functions for use in canvas / Three.js / any time you
 * need to interpolate a value `t` (0..1) → eased value (0..1).
 *
 * Usage:
 *   const y = easingJs.outExpo(t);
 *   mesh.position.y = THREE.MathUtils.lerp(start, end, y);
 */
export const easingJs = {
  linear:     (t: number) => t,
  inQuad:     (t: number) => t * t,
  outQuad:    (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad:  (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic:    (t: number) => t * t * t,
  outCubic:   (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outExpo:    (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutBack:  (t: number) => {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  },
} as const;

export type EasingJsToken = keyof typeof easingJs;

/** ── KEYFRAMES ───────────────────────────────────────────────── */
/**
 * Reusable keyframe definitions. Identical to the Tailwind config so
 * values can be used in BOTH Tailwind classes AND JS animation libraries.
 *
 * Example (Tailwind):  `animate-float-up`
 * Example (framer):   `<motion.div animate={{ y: [8, 0], opacity: [0, 1] }} />`
 * Example (CSS-in-JS): `{ animation: \`floatUp ${duration.base}s ${easing.outExpo}\` }`
 */
export const keyframes = {
  /** Float upward + fade in (toasts, status messages) */
  floatUp: {
    from: { opacity: 0, transform: 'translateY(8px)' },
    to:   { opacity: 1, transform: 'translateY(0)' },
  },
  /** Continuous slow spin (loading spinners) */
  spinSlow: {
    from: { transform: 'rotate(0deg)' },
    to:   { transform: 'rotate(360deg)' },
  },
  /** Drop from top to bottom (rain events) */
  rainDrop: {
    from: { opacity: 1, transform: 'translateY(-20px)' },
    to:   { opacity: 0.2, transform: 'translateY(100vh)' },
  },
  /** Soft pulse (live indicators, attention-grabbers) */
  pulseSoft: {
    '0%, 100%': { opacity: 1 },
    '50%':      { opacity: 0.55 },
  },
  /** Lift in from below (cards entering viewport) */
  liftIn: {
    from: { opacity: 0, transform: 'translateY(4px) scale(0.98)' },
    to:   { opacity: 1, transform: 'translateY(0) scale(1)' },
  },
  /** Win celebration — scale punch */
  winPunch: {
    '0%':   { transform: 'scale(0.5)', opacity: 0 },
    '60%':  { transform: 'scale(1.15)', opacity: 1 },
    '100%': { transform: 'scale(1)',    opacity: 1 },
  },
  /** Lose shake — small horizontal shake */
  loseShake: {
    '0%, 100%':  { transform: 'translateX(0)' },
    '20%, 60%':  { transform: 'translateX(-4px)' },
    '40%, 80%':  { transform: 'translateX(4px)' },
  },
  /** Coin flip — full rotation cycle */
  coinFlip: {
    '0%':   { transform: 'rotateY(0deg)' },
    '100%': { transform: 'rotateY(1800deg)' },  // 5 full spins
  },
} as const;

export type KeyframeToken = keyof typeof keyframes;

/** ── CSS STRING HELPERS ──────────────────────────────────────── */
/**
 * Build a complete CSS `animation` shorthand string from tokens.
 * Useful for inline styles or CSS-in-JS that needs the full string.
 *
 * Example:
 *   const css = animation('floatUp', duration.medium, easing.outExpo);
 *   // → "floatUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)"
 */
export const animation = (
  name: KeyframeToken,
  dur: DurationToken | number = 'base',
  ease: EasingToken = 'default',
): string => {
  const durSec = typeof dur === 'number' ? dur : duration[dur];
  const curve = easing[ease];
  return `${name} ${durSec}s cubic-bezier(${curve[0]}, ${curve[1]}, ${curve[2]}, ${curve[3]})`;
};

/** ── AGGREGATE EXPORT ────────────────────────────────────────── */
export const animations = {
  duration,
  easing,
  easingJs,
  keyframes,
  animation,
} as const;

export type Animations = typeof animations;