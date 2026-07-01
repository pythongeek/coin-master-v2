'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  CARD — Generic + GameCard + StatCard variants
 * ═══════════════════════════════════════════════════════════════
 *
 *  Wraps the existing `.glass-card` / `.glass-card-raised` CSS classes
 *  with React components + structured props.
 *
 *  VARIANTS:
 *    - default  → surface bg, md elevation (most cards)
 *    - raised   → surface2 bg, lg elevation (modals, hero panels)
 *    - outline  → transparent bg, border only (subtle cards)
 *    - accent   → green-tinted bg (active / selected state)
 *
 *  SUBCOMPONENTS:
 *    - Card.Header    → top section with title + actions
 *    - Card.Body      → main content area
 *    - Card.Footer    → bottom section (actions, metadata)
 *    - StatCard       → special card for numeric KPIs (label + value + trend)
 *
 *  USAGE:
 *    import { Card, StatCard } from '@/design-system/components/Card';
 *
 *    <Card>
 *      <Card.Header>Title</Card.Header>
 *      <Card.Body>Content</Card.Body>
 *    </Card>
 *
 *    <StatCard label="Win Rate" value="64.2%" trend="+2.1%" trendDirection="up" />
 * ═══════════════════════════════════════════════════════════════
 */

import { HTMLAttributes, ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/design-system/components/utils';

export type CardVariant = 'default' | 'raised' | 'outline' | 'accent';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  default: 'glass-card',          // existing CSS class
  raised:  'glass-card-raised',   // existing CSS class
  outline: 'bg-transparent border border-border rounded-xl',
  accent:  'bg-brand-green/10 border border-brand-green/30 rounded-xl shadow-elevate-md',
};

const paddingClasses = {
  none: '',
  sm:   'p-2',
  md:   'p-4',
  lg:   'p-6',
};

function CardRoot({
  variant = 'default',
  padding = 'md',
  interactive = false,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        variantClasses[variant],
        paddingClasses[padding],
        interactive && 'cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-elevate-lg',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

function CardHeader({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between pb-3 mb-3 border-b border-border',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

function CardBody({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('', className)} {...rest}>
      {children}
    </div>
  );
}

function CardFooter({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between pt-3 mt-3 border-t border-border',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

CardRoot.displayName = 'Card';
export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Body:   CardBody,
  Footer: CardFooter,
});

// ── StatCard — KPI-style numeric display ──────────────────────
export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string | number;
  /** Optional unit suffix (e.g., "%", " USD", " bets") */
  unit?: string;
  /** Trend string (e.g., "+2.1%" or "-$5") */
  trend?: string;
  trendDirection?: 'up' | 'down' | 'flat';
  /** Optional icon shown next to the label */
  icon?: ReactNode;
}

const trendColorClasses = {
  up:   'text-brand-green',
  down: 'text-brand-red',
  flat: 'text-text-muted',
};

export function StatCard({
  label,
  value,
  unit,
  trend,
  trendDirection = 'flat',
  icon,
  className = '',
  ...rest
}: StatCardProps) {
  const TrendIcon =
    trendDirection === 'up' ? TrendingUp :
    trendDirection === 'down' ? TrendingDown : Minus;

  return (
    <Card variant="default" padding="md" {...rest} className={className}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          {label}
        </span>
        {icon && <span className="text-text-muted">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono font-bold text-2xl text-text-primary tabular-nums">
          {value}
        </span>
        {unit && <span className="text-text-muted text-sm">{unit}</span>}
      </div>
      {trend && (
        <div className={cn('flex items-center gap-1 mt-2 text-xs', trendColorClasses[trendDirection])}>
          <TrendIcon size={12} />
          <span className="font-mono">{trend}</span>
        </div>
      )}
    </Card>
  );
}
StatCard.displayName = 'StatCard';

export default Card;