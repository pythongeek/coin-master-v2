/**
 * ═══════════════════════════════════════════════════════════════
 *  COLOR TOKENS — Stake-grade dark casino palette
 * ═══════════════════════════════════════════════════════════════
 *
 *  These are TS-mirror exports of the same values defined in
 *  `tailwind.config.js` under `theme.extend.colors`.
 *
 *  USE THIS FILE WHEN:
 *    - You need a color value in JS code (Three.js material, framer-motion,
 *      inline style prop, Chart.js, Recharts, canvas drawing, etc.)
 *    - You want TypeScript autocomplete for hex values.
 *    - You want IDE hover-tooltips.
 *
 *  USE TAILWIND CLASSES WHEN:
 *    - You're styling JSX with `className="bg-brand-green"`.
 *    - You want Tailwind's opacity modifiers (`bg-brand-green/20`).
 *
 *  SINGLE SOURCE OF TRUTH:
 *    `tailwind.config.js` → `theme.extend.colors`
 *    If you change a hex value, update BOTH this file and tailwind.config.js
 *    (or migrate to a code-generation step later).
 *
 *  PALETTE PHILOSOPHY:
 *    - Deep navy-black base (not pure #000 — easier on eyes for long sessions)
 *    - Layered surfaces (void → surface → surface2) for elevation hierarchy
 *    - Bangladesh-flag-inspired brand colors:
 *        green  = win / primary action
 *        red    = loss / danger
 *        gold   = premium / streak / rain
 *        maroon = squad feature
 *    - 3 levels of borders (border, border2) for hover/focus states
 *    - 3 levels of text (primary, secondary, muted)
 * ═══════════════════════════════════════════════════════════════
 */

/** ── BACKGROUND LAYERS ───────────────────────────────────────── */
export const bg = {
  /** Main page background (darkest) */
  primary:   '#0B0E11',
  /** Card / panel surface */
  secondary: '#141920',
  /** Elevated surface (modals, popovers) */
  tertiary:  '#1B212B',
  /** Hover state for surface2 */
  hover:     '#262C36',
  /** Game area (darker than primary for contrast with 3D coin) */
  game:      '#08090C',
} as const;

/** ── BORDERS ─────────────────────────────────────────────────── */
export const border = {
  /** Default border */
  DEFAULT:  '#262C36',
  /** Hover/focus border (brighter) */
  strong:   '#343C49',
} as const;

/** ── TEXT ────────────────────────────────────────────────────── */
export const text = {
  /** Primary text (high contrast) */
  primary:   '#F4F6F8',
  /** Secondary text (labels, captions) */
  secondary: '#9AA3B2',
  /** Muted text (placeholders, disabled) */
  muted:     '#5B6472',
  /** Win state (alias of brand.green) */
  accent:    '#00C566',
  /** Loss state (alias of brand.red) */
  danger:    '#E8384F',
} as const;

/** ── BRAND COLORS — Bangladesh-flag-inspired ──────────────────── */
export const brand = {
  /** Primary green (win, primary CTAs, brand identity) */
  green:    '#00C566',
  /** Dimmed green for hover/disabled states */
  greenDim: '#0A9A52',
  /** Red (loss, danger, errors) */
  red:      '#E8384F',
  /** Dimmed red */
  redDim:   '#B82B3D',
  /** Gold (premium, streak indicators, rain events) */
  gold:     '#E8A93D',
  /** Dimmed gold */
  goldDim:  '#C28A28',
  /** Maroon (squad feature, secondary brand) */
  maroon:   '#A8395C',
  /** Dimmed maroon */
  maroonDim:'#822C47',
  /** Info blue (neutral notifications, links) */
  info:     '#5B8DEF',
  /** Dimmed info */
  infoDim:  '#3F6BC4',
} as const;

/** ── COIN COLORS (3D scene) ──────────────────────────────────── */
export const coin = {
  /** Heads face (gold) */
  heads: '#E8A93D',
  /** Tails face (silver) */
  tails: '#C0C8D0',
  /** Edge case (rare 3rd outcome) */
  edge:  '#FF6B00',
} as const;

/** ── MULTIPLIER COLORS (for slider/heatmap) ──────────────────── */
export const multiplier = {
  /** 1x-2x (low risk) — green */
  low:      '#00C566',
  /** 2x-10x (medium risk) — amber */
  medium:   '#FFC107',
  /** 10x-100x (high risk) — orange */
  high:     '#FF5722',
  /** 100x+ (extreme risk) — pink */
  extreme:  '#E91E63',
} as const;

/** ── GLASS / TRANSPARENCY HELPERS ────────────────────────────── */
/** Tailwind-style opacity utilities as raw rgba for non-Tailwind consumers */
export const withAlpha = (hex: string, alpha: number): string => {
  // Validate alpha 0-1
  const a = Math.max(0, Math.min(1, alpha));
  // Parse hex (supports #RGB and #RRGGBB)
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** ── AGGREGATE EXPORT ────────────────────────────────────────── */
export const colors = {
  bg,
  border,
  text,
  brand,
  coin,
  multiplier,
  withAlpha,
} as const;

/** ── TYPE EXPORTS ────────────────────────────────────────────── */
export type BgToken        = keyof typeof bg;
export type BorderToken    = keyof typeof border;
export type TextToken      = keyof typeof text;
export type BrandToken     = keyof typeof brand;
export type CoinToken      = keyof typeof coin;
export type MultiplierTier = keyof typeof multiplier;
export type Colors         = typeof colors;