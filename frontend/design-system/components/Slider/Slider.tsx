'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  SLIDER — Numeric range input with custom styling
 * ═══════════════════════════════════════════════════════════════
 *
 *  Styled wrapper around <input type="range">. Stake-style: green
 *  fill from min to thumb, dark track behind.
 *
 *  USAGE:
 *    import { Slider } from '@/design-system/components/Slider';
 *
 *    <Slider
 *      min={1.01}
 *      max={1000}
 *      step={0.01}
 *      value={multiplier}
 *      onChange={setMultiplier}
 *      formatValue={(v) => `${v.toFixed(2)}x`}
 *    />
 *
 *  PROPS:
 *    - Standard range input props (min/max/step/value/onChange)
 *    - formatValue  → callback to display value text near thumb
 *    - color        → track fill color (default brand-green)
 *    - showValue    → show value label below slider
 *
 *  HOW IT STYLES:
 *    - Track: dark void background
 *    - Filled portion (left of thumb): brand color
 *    - Thumb: 16px circle, brand color, subtle shadow
 *
 *  Implementation note: native input[type=range] is used (browser handles
 *  touch, keyboard, accessibility). We override thumb/track via CSS vars.
 * ═══════════════════════════════════════════════════════════════
 */

import { InputHTMLAttributes, useCallback, useId } from 'react';
import { cn } from '@/design-system/components/utils';

export type SliderColor = 'brand' | 'multiplier';

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  color?: SliderColor;
  showValue?: boolean;
  formatValue?: (value: number) => string;
  label?: string;
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  color = 'brand',
  showValue = true,
  formatValue,
  label,
  className,
  disabled,
  ...rest
}: SliderProps) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;

  const fillColor = color === 'brand' ? '#00C566' : '#00C566';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange],
  );

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="flex justify-between mb-1.5 text-xs">
          <span className="text-text-secondary font-medium">{label}</span>
          {showValue && formatValue && (
            <span className="font-mono font-bold tabular-nums" style={{ color: fillColor }}>
              {formatValue(value)}
            </span>
          )}
        </div>
      )}
      <div className="relative">
        {/* Track background */}
        <div className="absolute inset-y-0 left-0 right-0 flex items-center pointer-events-none">
          <div className="w-full h-1.5 rounded-full bg-void border border-border" />
        </div>
        {/* Filled portion */}
        <div
          className="absolute inset-y-0 left-0 flex items-center pointer-events-none"
          style={{ width: `${pct}%` }}
        >
          <div className="h-1.5 rounded-full" style={{ backgroundColor: fillColor, width: '100%' }} />
        </div>
        {/* Native input (invisible but interactive) */}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          className={cn(
            'relative w-full h-6 bg-transparent appearance-none cursor-pointer',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            // Thumb (browser-specific — handle in CSS)
            '[&::-webkit-slider-thumb]:appearance-none',
            '[&::-webkit-slider-thumb]:w-4',
            '[&::-webkit-slider-thumb]:h-4',
            '[&::-webkit-slider-thumb]:rounded-full',
            '[&::-webkit-slider-thumb]:bg-brand-green',
            '[&::-webkit-slider-thumb]:shadow-brand-green',
            '[&::-webkit-slider-thumb]:cursor-pointer',
            '[&::-webkit-slider-thumb]:border-2',
            '[&::-webkit-slider-thumb]:border-void',
            // Firefox
            '[&::-moz-range-thumb]:w-4',
            '[&::-moz-range-thumb]:h-4',
            '[&::-moz-range-thumb]:rounded-full',
            '[&::-moz-range-thumb]:bg-brand-green',
            '[&::-moz-range-thumb]:border-2',
            '[&::-moz-range-thumb]:border-void',
            '[&::-moz-range-thumb]:cursor-pointer',
          )}
          style={{
            // Custom property for Firefox track fill
            // @ts-ignore — custom prop
            '--fill': `${pct}%`,
          }}
          {...rest}
        />
      </div>
      {/* Min/max labels */}
      <div className="flex justify-between mt-1 text-[10px] text-text-muted font-mono tabular-nums">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
Slider.displayName = 'Slider';

export default Slider;