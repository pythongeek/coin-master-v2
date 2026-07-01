/**
 * ═══════════════════════════════════════════════════════════════
 *  SPACING TOKENS — 4px grid system + named semantic tokens
 * ═══════════════════════════════════════════════════════════════
 *
 *  TS-mirror of Tailwind's default spacing scale (which is also 4px-based).
 *  Tailwind defaults: 4px=1, 8px=2, 12px=3, 16px=4, 20px=5, 24px=6...
 *
 *  TWO LAYERS:
 *    1. `space`  — raw numeric scale (0, 1, 2, 3...). Use for utility-style
 *                  one-off spacing in JSX (e.g., framer-motion translate).
 *    2. `layout` — semantic aliases for common patterns (sidebar widths,
 *                  header heights, panel paddings). Document intent.
 *
 *  WHY TWO LAYERS:
 *    - Raw `space[4]` is unambiguous (16px) but loses intent.
 *    - `layout.sidebarLeft` documents that 380px = "left sidebar".
 *    - If sidebar width needs to change, only the semantic value updates.
 *      Components that use the semantic name don't need to know.
 *
 *  UNIT NOTE:
 *    - All values are in `px` (NOT rem). Spacing should be deterministic
 *      across user font-size preferences — we don't want a button to grow
 *      when the user bumps browser zoom.
 * ═══════════════════════════════════════════════════════════════
 */

/** ── RAW 4PX SCALE ───────────────────────────────────────────── */
/**
 * Each unit = 4px.
 * space[4] = 16px, space[6] = 24px, etc.
 * Mirrors Tailwind: `p-4` → 16px padding.
 */
export const space = {
  0:  '0',
  1:  '4px',
  2:  '8px',
  3:  '12px',
  4:  '16px',
  5:  '20px',
  6:  '24px',
  7:  '28px',
  8:  '32px',
  9:  '36px',
  10: '40px',
  11: '44px',
  12: '48px',
  14: '56px',
  16: '64px',
  18: '72px',
  20: '80px',
  24: '96px',
  28: '112px',
  32: '128px',
  36: '144px',
  40: '160px',
  44: '176px',
  48: '192px',
  52: '208px',
  56: '224px',
  60: '240px',
  64: '256px',
  72: '288px',
  80: '320px',
  96: '384px',
} as const;

export type SpaceToken = keyof typeof space;

/** ── SEMANTIC LAYOUT TOKENS ──────────────────────────────────── */
/**
 * Named values for recurring layout patterns.
 * Components reference these for intent.
 *
 * Example: `<aside style={{ width: layout.sidebarLeft }}>` reads as
 * "left sidebar width" rather than magic number 380.
 */
export const layout = {
  // ── Sidebar widths (per guide §1.3) ─────────────────────────
  /** Left sidebar (BetControls) */
  sidebarLeft:  '380px',
  /** Right sidebar (LiveStats + LiveChat) */
  sidebarRight: '320px',
  /** Min-width guarantees (same as widths to prevent squeeze) */
  sidebarLeftMin:  '380px',
  sidebarRightMin: '320px',

  // ── Header / footer heights ─────────────────────────────────
  /** Top game header */
  gameHeaderHeight: '56px',
  /** Bottom game footer (betting status, hot keys) */
  gameFooterHeight: '48px',

  // ── Panel inner padding ─────────────────────────────────────
  /** Standard panel inner padding (cards, modals) */
  panelPadding:      space[4],  // 16px
  /** Larger panel padding (auth modals, settings) */
  panelPaddingLarge: space[6],  // 24px
  /** Compact padding (chips, badges) */
  panelPaddingTight: space[2],  // 8px

  // ── Common gaps ─────────────────────────────────────────────
  /** Default gap between related items in a flex/grid row */
  gapDefault: space[4],  // 16px
  /** Tighter gap (chips, tags) */
  gapTight:   space[2],  // 8px
  /** Wider gap (section breaks) */
  gapWide:    space[8],  // 32px

  // ── Common icon / button sizes ──────────────────────────────
  /** Small icon button (e.g., close X) */
  iconSm: '24px',
  /** Default icon size */
  iconMd: '32px',
  /** Large icon (hero) */
  iconLg: '48px',

  /** Primary CTA button height (e.g., "Flip for $X") */
  buttonCtaHeight: '56px',
  /** Default button height */
  buttonDefaultHeight: '40px',
  /** Small button height (chips, inline actions) */
  buttonSmHeight:  '32px',

  /** Input field height */
  inputHeight: '44px',

  // ── Border radii ────────────────────────────────────────────
  /** Subtle rounding (chips, tags) */
  radiusSm:   '6px',
  /** Default rounding (buttons, inputs, cards) */
  radiusMd:   '8px',
  /** Large rounding (modals, big cards) */
  radiusLg:   '12px',
  /** Extra large rounding (hero panels, floating UI) */
  radiusXl:   '16px',
  /** Fully rounded (avatars, pills) */
  radiusFull: '9999px',

  // ── z-index scale ───────────────────────────────────────────
  /** Dropdown menus, tooltips */
  zDropdown: '100',
  /** Sticky headers */
  zSticky:   '200',
  /** Modals, overlays */
  zModal:    '1000',
  /** Win celebrations, top-most notifications */
  zCelebration: '2000',
  /** Emergency toasts (rate-limit warnings, errors) */
  zEmergency:   '3000',
} as const;

export type LayoutToken = keyof typeof layout;

/** ── AGGREGATE EXPORT ────────────────────────────────────────── */
export const spacing = {
  space,
  layout,
} as const;

export type Spacing = typeof spacing;