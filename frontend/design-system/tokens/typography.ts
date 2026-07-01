/**
 * ═══════════════════════════════════════════════════════════════
 *  TYPOGRAPHY TOKENS — Font families + scale + weights
 * ═══════════════════════════════════════════════════════════════
 *
 *  TS-mirror of `tailwind.config.js` → `theme.extend.fontFamily`.
 *
 *  THREE ROLES:
 *    - display: large headings, hero numbers, big stats (Space Grotesk)
 *      → geometric, slightly condensed, casino feel
 *    - body:    paragraphs, labels, UI text (Inter)
 *      → clean, readable, industry-standard
 *    - mono:    numbers, balances, multipliers, addresses (JetBrains Mono)
 *      → monospaced so digits align in tables
 *
 *  WHEN TO USE WHAT:
 *    - Display: page titles, big "Flip for $X" button, win overlay amount
 *    - Body:    everything else
 *    - Mono:    any place where numbers might change and you want them to
 *               NOT shift width (balances, multipliers, bet history)
 *
 *  FONT LOADING:
 *    Self-hosted via `next/font/google` in app/layout.tsx — see
 *    `frontend/app/layout.tsx` (FontLoader config).
 * ═══════════════════════════════════════════════════════════════
 */

/** ── FONT FAMILIES ───────────────────────────────────────────── */
/**
 * Display font — for large headings and hero numbers.
 * Geometric sans-serif with a slight condensed feel.
 */
export const fontFamily = {
  display: '"Space Grotesk", sans-serif',
  body:    'Inter, sans-serif',
  mono:    '"JetBrains Mono", monospace',
} as const;

export type FontFamilyToken = keyof typeof fontFamily;

/** ── FONT SIZES (rem-based, scales with root font-size) ───────── */
/**
 * Type scale following a 1.25 ratio (major third).
 * Each step is ~25% larger than the previous.
 */
export const fontSize = {
  /** 0.75rem — micro labels, badges */
  xs:   '0.75rem',
  /** 0.875rem — small body, captions */
  sm:   '0.875rem',
  /** 1rem — body text (default) */
  base: '1rem',
  /** 1.125rem — large body, emphasized text */
  lg:   '1.125rem',
  /** 1.25rem — small headings */
  xl:   '1.25rem',
  /** 1.5rem — section headings */
  '2xl':'1.5rem',
  /** 1.875rem — page section titles */
  '3xl':'1.875rem',
  /** 2.25rem — page titles */
  '4xl':'2.25rem',
  /** 3rem — hero numbers, win overlays */
  '5xl':'3rem',
  /** 3.75rem — huge stat displays */
  '6xl':'3.75rem',
  /** 4.5rem — max-display, splash screens */
  '7xl':'4.5rem',
} as const;

export type FontSizeToken = keyof typeof fontSize;

/** ── LINE HEIGHTS ────────────────────────────────────────────── */
/**
 * Tighter line heights for display sizes (more visual impact),
 * looser for body (better readability).
 */
export const lineHeight = {
  none:    '1',
  tight:   '1.15',   // display headings
  snug:    '1.3',    // large body
  normal:  '1.5',    // body text (default)
  relaxed: '1.625',  // long-form text
  loose:   '1.8',    // very spacious
} as const;

export type LineHeightToken = keyof typeof lineHeight;

/** ── FONT WEIGHTS ────────────────────────────────────────────── */
export const fontWeight = {
  thin:       '100',
  extralight: '200',
  light:      '300',
  normal:     '400',
  medium:     '500',
  semibold:   '600',
  bold:       '700',
  extrabold:  '800',
  black:      '900',
} as const;

export type FontWeightToken = keyof typeof fontWeight;

/** ── LETTER SPACING ──────────────────────────────────────────── */
/**
 * Display headings often need slightly tighter spacing for impact.
 * Body and mono keep default (0).
 */
export const letterSpacing = {
  tighter:  '-0.05em',
  tight:    '-0.025em',
  normal:   '0',
  wide:     '0.025em',
  wider:    '0.05em',
  widest:   '0.1em',
} as const;

export type LetterSpacingToken = keyof typeof letterSpacing;

/** ── PRESET TYPE STYLES ──────────────────────────────────────── */
/**
 * Composable type styles for common patterns.
 * Use like: `style={type.h1}` in JSX, or merge into a className.
 *
 * Example:
 *   <h1 style={type.h1}>CryptoFlip</h1>
 *   <span style={type.monoNumber}>12345.6789</span>
 */
export const type = {
  /** Page title */
  h1: {
    fontFamily: fontFamily.display,
    fontSize:   fontSize['4xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Section title */
  h2: {
    fontFamily: fontFamily.display,
    fontSize:   fontSize['3xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.tight,
  },
  /** Subsection */
  h3: {
    fontFamily: fontFamily.display,
    fontSize:   fontSize['2xl'],
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.snug,
  },
  /** Large body / emphasized */
  bodyLarge: {
    fontFamily: fontFamily.body,
    fontSize:   fontSize.lg,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.normal,
  },
  /** Default body */
  body: {
    fontFamily: fontFamily.body,
    fontSize:   fontSize.base,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.normal,
  },
  /** Small caption */
  caption: {
    fontFamily: fontFamily.body,
    fontSize:   fontSize.sm,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.snug,
  },
  /** Mono number (balance, multiplier, bet amount) */
  monoNumber: {
    fontFamily: fontFamily.mono,
    fontSize:   fontSize.base,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.tight,
    fontVariantNumeric: 'tabular-nums',
  },
  /** Big mono display (big balance/win amount) */
  monoDisplay: {
    fontFamily: fontFamily.mono,
    fontSize:   fontSize['5xl'],
    fontWeight: fontWeight.bold,
    lineHeight: lineHeight.tight,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: letterSpacing.tight,
  },
  /** Button label */
  button: {
    fontFamily: fontFamily.display,
    fontSize:   fontSize.base,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.none,
    letterSpacing: letterSpacing.wide,
  },
  /** Tabular number style for tables */
  tabular: {
    fontFamily: fontFamily.mono,
    fontSize:   fontSize.sm,
    fontWeight: fontWeight.normal,
    lineHeight: lineHeight.tight,
    fontVariantNumeric: 'tabular-nums',
  },
} as const;

export type TypeStyleToken = keyof typeof type;

/** ── AGGREGATE EXPORT ────────────────────────────────────────── */
export const typography = {
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
  type,
} as const;

export type Typography = typeof typography;