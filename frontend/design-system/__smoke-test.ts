/**
 * ═══════════════════════════════════════════════════════════════
 *  DESIGN SYSTEM SMOKE TEST
 * ═══════════════════════════════════════════════════════════════
 *
 *  This file exists ONLY to:
 *    1. Verify the @/design-system path alias resolves.
 *    2. Verify all token files compile without TypeScript errors.
 *    3. Provide a single import example for component authors.
 *
 *  It is NOT used at runtime and can be deleted once components start
 *  importing these tokens. Kept for now as a sanity check.
 *
 *  To verify it compiles:
 *    cd frontend && npx tsc --noEmit
 *
 *  To verify the path alias works at runtime (Next.js compiles):
 *    npm run build
 * ═══════════════════════════════════════════════════════════════
 */

import {
  colors,
  brand,
  coin,
  multiplier,
  withAlpha,
  typography,
  fontFamily,
  type,
  spacing,
  space,
  layout,
  shadows,
  elevation,
  brandGlow,
  animations,
  duration,
  easing,
  easingJs,
  keyframes,
  animation,
  DESIGN_SYSTEM_VERSION,
} from '@/design-system';

// ── Test 1: colors are defined ─────────────────────────────────
const greenHex: string = brand.green;
const goldHex: string = coin.heads;
const multiplierHigh: string = multiplier.high;
const transparentGreen: string = withAlpha(brand.green, 0.5);

// ── Test 2: typography presets are CSSProperty objects ──────────
const h1Style = {
  fontFamily: type.h1.fontFamily,
  fontSize:   type.h1.fontSize,
  fontWeight: type.h1.fontWeight as string,
};

// ── Test 3: spacing values are CSS strings ─────────────────────
const sidebarWidth: string = layout.sidebarLeft;
const padding: string = layout.panelPadding;
const gap: string = space[4];

// ── Test 4: shadows are CSS strings ────────────────────────────
const cardShadow: string = elevation.md;
const ctaGlow: string = brandGlow.green;

// ── Test 5: animation helper produces CSS string ───────────────
const floatUpCss: string = animation('floatUp', 'medium', 'outExpo');

// ── Test 6: JS easing works on a value ─────────────────────────
const eased: number = easingJs.outExpo(0.5);   // ≈ 0.984

// ── Compile-time only — never executed ─────────────────────────
export const __designSystemSmokeTest = {
  version: DESIGN_SYSTEM_VERSION,
  greenHex,
  goldHex,
  multiplierHigh,
  transparentGreen,
  h1Style,
  sidebarWidth,
  padding,
  gap,
  cardShadow,
  ctaGlow,
  floatUpCss,
  eased,
  // reference `colors`, `typography`, etc. to satisfy "no unused imports" rules
  _refs: { colors, typography, spacing, shadows, animations, fontFamily, duration, easing, keyframes },
} as const;