'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  PROGRESS — Linear bar + circular + multiplier meter variants
 * ═══════════════════════════════════════════════════════════════
 *
 *  USAGE:
 *    import { Progress } from '@/design-system/components/Progress';
 *
 *    <Progress value={45} max={100} />                       // linear
 *    <Progress value={45} max={100} variant="circle" />      // circular
 *    <Progress value={2.4} max={100} variant="multiplier" /> // 2.40x with color tier
 *
 *  VARIANTS:
 *    - linear     → horizontal bar (default)
 *    - circle     → radial progress with % in center
 *    - multiplier → like circle but shows the actual multiplier value with tier color
 *
 *  COLORS:
 *    - brand    → green (default, in-progress)
 *    - success  → green (completed, won)
 *    - warning  → amber (slow, attention needed)
 *    - danger   → red (failed, lost)
 *    - auto     → multiplier mode: color based on tier (low/medium/high/extreme)
 * ═══════════════════════════════════════════════════════════════
 */

import { HTMLAttributes } from 'react';
import { cn } from '@/design-system/components/utils';
import { multiplier } from '@/design-system';

export type ProgressVariant = 'linear' | 'circle' | 'multiplier';
export type ProgressColor = 'brand' | 'success' | 'warning' | 'danger' | 'auto';

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value: number;
  max?: number;
  variant?: ProgressVariant;
  color?: ProgressColor;
  /** Show value label (linear only — circle shows it in center) */
  showLabel?: boolean;
  /** Format function for the displayed value */
  formatValue?: (value: number, max: number, pct: number) => string;
}

const colorBarClasses: Record<Exclude<ProgressColor, 'auto'>, string> = {
  brand:   'bg-brand-green',
  success: 'bg-brand-green',
  warning: 'bg-brand-gold',
  danger:  'bg-brand-red',
};

function pickMultiplierColor(value: number): string {
  if (value <= 2) return multiplier.low;
  if (value <= 10) return multiplier.medium;
  if (value <= 100) return multiplier.high;
  return multiplier.extreme;
}

// ── Linear ─────────────────────────────────────────────────────
function LinearProgress({
  value,
  max = 100,
  color = 'brand',
  showLabel,
  formatValue,
  className,
  ...rest
}: ProgressProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const barColor = color === 'auto' ? 'brand' : color;
    return (
    <div className={cn('w-full', className)} {...rest}>
      <div
        className="w-full h-2 bg-void rounded-full overflow-hidden border border-border"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className={cn('h-full transition-all duration-300 ease-out rounded-full', colorBarClasses[barColor])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <div className="flex justify-between mt-1 text-xs text-text-muted font-mono tabular-nums">
          <span>{formatValue ? formatValue(value, max, pct) : value}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      )}
    </div>
  );
}

// ── Circle ─────────────────────────────────────────────────────
function CircleProgress({
  value,
  max = 100,
  color = 'brand',
  className,
  formatValue,
  ...rest
}: ProgressProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const stroke = color === 'auto' ? pickMultiplierColor(value) : (
    color === 'brand' || color === 'success' ? '#00C566' :
    color === 'warning' ? '#E8A93D' :
    '#E8384F'
  );
  const display = formatValue ? formatValue(value, max, pct) : `${Math.round(pct)}%`;

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} {...rest}>
      <svg width="100" height="100" className="-rotate-90" aria-hidden="true">
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="#262C36"
          strokeWidth="8"
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.3s ease-out' }}
        />
      </svg>
      <span className="absolute font-mono font-bold text-sm tabular-nums" style={{ color: stroke }}>
        {display}
      </span>
    </div>
  );
}

// ── Multiplier (alias for circle but with .toFixed(2)x) ────────
function MultiplierProgress(props: ProgressProps) {
  return (
    <CircleProgress
      {...props}
      color="auto"
      formatValue={(v) => `${v.toFixed(2)}x`}
    />
  );
}

// ── Root ───────────────────────────────────────────────────────
export function Progress(props: ProgressProps) {
  switch (props.variant) {
    case 'circle':     return <CircleProgress {...props} />;
    case 'multiplier': return <MultiplierProgress {...props} />;
    default:           return <LinearProgress {...props} />;
  }
}
Progress.displayName = 'Progress';

export default Progress;