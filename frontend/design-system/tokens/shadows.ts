/**
 * ═══════════════════════════════════════════════════════════════
 *  SHADOW TOKENS — Elevation + brand glow shadows
 * ═══════════════════════════════════════════════════════════════
 *
 *  TS-mirror of `tailwind.config.js` → `theme.extend.boxShadow`.
 *
 *  TWO FAMILIES:
 *    1. `elevation` — neutral drop-shadows for layering (cards on top of
 *       cards, modals on top of cards). Multiple shadow layers simulate
 *       ambient + key light (mimics real materials).
 *    2. `brand`     — colored glow shadows tinted with brand colors.
 *       Used sparingly: primary CTAs, big buttons, win celebrations.
 *
 *  PHILOSOPHY:
 *    - Default UI uses elevation (depth via shadow).
 *    - Brand glow only on interactive primary actions and celebration moments.
 *      Overusing glow makes the UI feel "slot-machine cheap".
 *
 *  PERFORMANCE:
 *    - All shadows are static CSS strings (no runtime cost).
 *    - For animated shadows (e.g., win celebration pulsing), use the
 *      `animations.ts` tokens + framer-motion.
 * ═══════════════════════════════════════════════════════════════
 */

import { brand } from './colors';

/** ── ELEVATION (neutral depth) ───────────────────────────────── */
/**
 * Layered shadows: ambient + key light + inset highlight.
 * Each level adds another shadow layer for realistic depth.
 */
export const elevation = {
  /** Smallest lift — chips, tags, inline buttons */
  sm: '0 1px 2px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.03)',
  /** Default — buttons, inputs, cards */
  md: '0 2px 8px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
  /** Larger — modals, dropdowns */
  lg: '0 8px 24px rgba(0, 0, 0, 0.5), 0 12px 40px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
  /** Largest — celebration overlays, full-screen modals */
  xl: '0 16px 48px rgba(0, 0, 0, 0.6), 0 24px 80px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
  /** Inset — pressed buttons, input fields */
  inset: 'inset 0 2px 4px rgba(0, 0, 0, 0.5)',
} as const;

export type ElevationToken = keyof typeof elevation;

/** ── BRAND GLOW (colored shadows) ────────────────────────────── */
/**
 * Tinted drop-shadows that match each brand color.
 * Use SPARINGLY — only on:
 *   - Primary CTAs (the main "Flip" button)
 *   - Win/loss celebrations
 *   - Active/selected state indicators
 *
 * Each glow has:
 *   - 28px spread with brand color at 28% opacity (visible but not garish)
 *   - 1px inset highlight on top (the "embossed" feel)
 */
export const brandGlow = {
  /** Green glow — primary CTA, win celebration */
  green:  `0 4px 14px ${brand.green}47, inset 0 1px 0 rgba(255, 255, 255, 0.15)`,
  /** Red glow — danger actions, loss celebrations */
  red:    `0 4px 14px ${brand.red}47, inset 0 1px 0 rgba(255, 255, 255, 0.10)`,
  /** Gold glow — premium features, streak indicators */
  gold:   `0 4px 14px ${brand.gold}47, inset 0 1px 0 rgba(255, 255, 255, 0.15)`,
  /** Maroon glow — squad feature, secondary CTAs */
  maroon: `0 4px 14px ${brand.maroon}47, inset 0 1px 0 rgba(255, 255, 255, 0.10)`,
  /** Info glow — informational highlights, links */
  info:   `0 4px 14px ${brand.info}38, inset 0 1px 0 rgba(255, 255, 255, 0.10)`,
} as const;

export type BrandGlowToken = keyof typeof brandGlow;

/** ── FOCUS RING (accessibility) ──────────────────────────────── */
/**
 * Keyboard focus indicator. Green (brand primary) at 2px outline + 2px offset.
 * Applied via `*:focus-visible` in globals.css. Exposed here for cases
 * where you need a custom focus ring (e.g., on canvas elements).
 */
export const focusRing = {
  /** Default 2px solid green outline */
  outline: `2px solid ${brand.green}`,
  /** Outline offset from element */
  offset:  '2px',
} as const;

/** ── COMBINED SHADOW EXPORT ──────────────────────────────────── */
/**
 * Combined export including pre-defined Tailwind aliases.
 * Tailwind classes available: `shadow-elevate-sm`, `shadow-brand-green`, etc.
 */
export const shadows = {
  elevation,
  brandGlow,
  focusRing,
  // ── Tailwind aliases (for reference, defined in tailwind.config.js) ──
  tailwindAliases: {
    'elevate-sm':  elevation.sm,
    'elevate-md':  elevation.md,
    'elevate-lg':  elevation.lg,
    'brand-green': brandGlow.green,
    'brand-red':   brandGlow.red,
    'brand-gold':  brandGlow.gold,
    'brand-maroon':brandGlow.maroon,
    'brand-info':  brandGlow.info,
  },
} as const;

export type Shadows = typeof shadows;