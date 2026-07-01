/**
 * ═══════════════════════════════════════════════════════════════
 *  DESIGN SYSTEM — Barrel exports
 * ═══════════════════════════════════════════════════════════════
 *
 *  Single import path for all design tokens.
 *
 *  USAGE:
 *    import { colors, typography, spacing, shadows, animations } from '@/design-system';
 *
 *  Or import individual modules for tree-shaking:
 *    import { brand } from '@/design-system/tokens/colors';
 *    import { easingJs } from '@/design-system/tokens/animations';
 *
 *  PATH ALIAS SETUP:
 *    `@/design-system` → `frontend/design-system/` (configured in tsconfig.json)
 *
 *  WHAT'S IN HERE:
 *    - colors      → bg, border, text, brand, coin, multiplier palettes
 *    - typography  → fontFamily, fontSize, lineHeight, fontWeight, type presets
 *    - spacing     → space (4px scale) + layout (semantic tokens)
 *    - shadows     → elevation + brandGlow + focusRing
 *    - animations  → duration + easing + keyframes + JS easers
 *
 *  WHAT'S NOT (yet):
 *    - Components (Button, Input, Card, Modal, Tooltip, Badge, Progress,
 *      Table, Tabs, Slider, Toast) → Phase 1.2 of the implementation guide.
 *    - Hooks (useTheme, useAnimation, useSound) → Phase 1.3.
 *
 *  See:
 *    - /root/.hermes/obsidian-vault/projects/cryptoflip/todo.md (Phase 1)
 *    - /root/.hermes/obsidian-vault/projects/cryptoflip/frontend-design-system.md
 * ═══════════════════════════════════════════════════════════════
 */

export {
  colors,
  bg,
  border,
  text,
  brand,
  coin,
  multiplier,
  withAlpha,
  // types
  type BgToken,
  type BorderToken,
  type TextToken,
  type BrandToken,
  type CoinToken,
  type MultiplierTier,
  type Colors,
} from './tokens/colors';

export {
  typography,
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
  type,
  // types
  type FontFamilyToken,
  type FontSizeToken,
  type LineHeightToken,
  type FontWeightToken,
  type LetterSpacingToken,
  type TypeStyleToken,
  type Typography,
} from './tokens/typography';

export {
  spacing,
  space,
  layout,
  // types
  type SpaceToken,
  type LayoutToken,
  type Spacing,
} from './tokens/spacing';

export {
  shadows,
  elevation,
  brandGlow,
  focusRing,
  // types
  type ElevationToken,
  type BrandGlowToken,
  type Shadows,
} from './tokens/shadows';

export {
  animations,
  duration,
  easing,
  easingJs,
  keyframes,
  animation,
  // types
  type DurationToken,
  type EasingToken,
  type EasingJsToken,
  type KeyframeToken,
  type Animations,
} from './tokens/animations';

// ── HOOKS ──────────────────────────────────────────────────────
export {
  useTheme,
  useAnimation,
  useSound,
} from './hooks';
export type {
  Theme,
  UseThemeReturn,
  UseAnimationReturn,
  SoundName,
  SoundExtension,
  UseSoundOptions,
  UseSoundReturn,
} from './hooks';

/** ── VERSION ─────────────────────────────────────────────────── */
export const DESIGN_SYSTEM_VERSION = '1.0.0' as const;