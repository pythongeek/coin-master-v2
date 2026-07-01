'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BADGE — Status pills, VIP tiers, count badges
 * ═══════════════════════════════════════════════════════════════
 *
 *  Compact label component for indicating state, tier, or count.
 *
 *  USAGE:
 *    import { Badge } from '@/design-system/components/Badge';
 *
 *    <Badge variant="success">Won</Badge>
 *    <Badge variant="vip" tier="gold">Gold</Badge>
 *    <Badge variant="count">12</Badge>
 *
 *  VARIANTS:
 *    - default   → muted text + border
 *    - success   → green (won, active, online)
 *    - danger    → red (lost, error, banned)
 *    - warning   → amber (pending, slow)
 *    - info      → blue (informational)
 *    - vip       → uses tier prop for color (bronze/silver/gold/platinum/diamond)
 *    - count     → circular number badge (for notification counts)
 *    - live      → pulsing dot for live/streaming indicators
 *
 *  SIZES:
 *    - sm   → 18px tall (inline with text)
 *    - md   → 22px tall (default)
 *    - lg   → 28px tall (prominent tags)
 * ═══════════════════════════════════════════════════════════════
 */

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/design-system/components/utils';

export type BadgeVariant =
  | 'default'
  | 'success'
  | 'danger'
  | 'warning'
  | 'info'
  | 'vip'
  | 'count'
  | 'live';

export type VipTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Only for variant="vip" — selects the tier color */
  tier?: VipTier;
  /** Optional dot indicator (for live/online states) */
  dot?: boolean;
  children?: ReactNode;
}

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'h-[18px] px-1.5 text-[10px]',
  md: 'h-[22px] px-2 text-xs',
  lg: 'h-7 px-2.5 text-sm',
};

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface2 text-text-secondary border border-border',
  success: 'bg-brand-green/15 text-brand-green border border-brand-green/30',
  danger:  'bg-brand-red/15 text-brand-red border border-brand-red/30',
  warning: 'bg-brand-gold/15 text-brand-gold border border-brand-gold/30',
  info:    'bg-brand-info/15 text-brand-info border border-brand-info/30',
  vip:     '',   // overridden by tierClasses
  count:   'bg-brand-red text-white rounded-full min-w-[18px] h-[18px] px-1 text-[10px] font-bold flex items-center justify-center',
  live:    'bg-brand-red/15 text-brand-red border border-brand-red/30',
};

const vipTierClasses: Record<VipTier, string> = {
  bronze:   'bg-gradient-to-r from-amber-700 to-amber-600 text-white border-amber-500',
  silver:   'bg-gradient-to-r from-slate-500 to-slate-400 text-white border-slate-300',
  gold:     'bg-gradient-to-r from-yellow-600 to-yellow-500 text-void border-yellow-400 shadow-brand-gold',
  platinum: 'bg-gradient-to-r from-cyan-600 to-cyan-500 text-white border-cyan-300 shadow-brand-info',
  diamond:  'bg-gradient-to-r from-fuchsia-600 to-purple-600 text-white border-fuchsia-300',
};

export function Badge({
  variant = 'default',
  size = 'md',
  tier,
  dot = false,
  className = '',
  children,
  ...rest
}: BadgeProps) {
  const variantClass =
    variant === 'vip' && tier ? vipTierClasses[tier] : variantClasses[variant];

  // count variant doesn't use size classes (fixed dimensions)
  const sizeClass = variant === 'count' ? '' : sizeClasses[size];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium uppercase tracking-wide whitespace-nowrap',
        variantClass,
        sizeClass,
        className,
      )}
      {...rest}
    >
      {(dot || variant === 'live') && (
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full bg-current',
            (variant === 'live' || dot) && 'animate-pulse-soft',
          )}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
Badge.displayName = 'Badge';

export default Badge;