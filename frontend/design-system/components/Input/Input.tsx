'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INPUT — Text + BetAmount + Search variants
 * ═══════════════════════════════════════════════════════════════
 *
 *  Wraps the existing `.input-cyber` CSS class with React + types.
 *  Special variants:
 *    - `betAmount` → numeric input with currency adornment, max/half/2x quick buttons
 *    - `search`    → search icon prefix
 *
 *  USAGE:
 *    import { Input } from '@/design-system/components/Input';
 *    <Input placeholder="Username" />
 *    <Input type="betAmount" value={amount} onChange={setAmount} max={balance} currency="USDT" />
 *    <Input type="search" placeholder="Find user..." />
 *
 *  ACCESSIBILITY:
 *    - All inputs are labelled via aria-label or wrapping <label>
 *    - Error state sets aria-invalid="true"
 *    - Focus ring inherited from global `*:focus-visible`
 * ═══════════════════════════════════════════════════════════════
 */

import { forwardRef, InputHTMLAttributes, ReactNode, useState, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/design-system/components/utils';

export type InputSize = 'sm' | 'md' | 'lg';
export type InputVariant = 'text' | 'betAmount' | 'search' | 'error';

export interface BetAmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> {
  value: number | string;
  onChange: (value: number) => void;
  max?: number;
  currency?: string;
  /** Show quick-action buttons (½ / 2x / Max) below the input */
  showQuickButtons?: boolean;
}

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  onClear?: () => void;
}

export interface BaseInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: InputVariant;
  size?: InputSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  label?: string;
  error?: string;
  helper?: string;
}

const sizeClasses: Record<InputSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-11 px-4 text-sm',
  lg: 'h-14 px-5 text-base',
};

const variantInputClasses: Record<InputVariant, string> = {
  text:     'input-cyber',
  betAmount: 'input-cyber font-mono text-right pr-16',  // room for currency suffix
  search:   'input-cyber pl-10 pr-10',                   // room for icons
  error:    'input-cyber border-brand-red focus:border-brand-red',
};

// ── Plain Input ────────────────────────────────────────────────
export const Input = forwardRef<HTMLInputElement, BaseInputProps>(
  (
    { variant = 'text', size, leftIcon, rightIcon, label, error, helper, className = '', ...rest },
    ref,
  ) => {
    const effectiveVariant: InputVariant = error ? 'error' : variant;
    const effectiveSize = size ?? (variant === 'betAmount' ? 'lg' : 'md');
    return (
      <div className="w-full">
        {label && (
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {(leftIcon || variant === 'search') && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              {variant === 'search' ? <Search size={16} /> : leftIcon}
            </div>
          )}
          <input
            ref={ref}
            aria-invalid={!!error || undefined}
            className={cn(
              'w-full bg-void border border-border rounded-lg text-text-primary placeholder-text-muted transition-all duration-150',
              variantInputClasses[effectiveVariant],
              sizeClasses[effectiveSize],
              effectiveVariant === 'betAmount' && 'tabular-nums',
              className,
            )}
            {...rest}
          />
          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
              {rightIcon}
            </div>
          )}
        </div>
        {(error || helper) && (
          <p className={cn(
            'mt-1 text-xs',
            error ? 'text-brand-red' : 'text-text-muted',
          )}>
            {error ?? helper}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

// ── BetAmountInput ─────────────────────────────────────────────
export const BetAmountInput = forwardRef<HTMLInputElement, BetAmountInputProps>(
  (
    {
      value,
      onChange,
      max,
      currency = 'USD',
      showQuickButtons = true,
      placeholder = '0.00',
      disabled,
      ...rest
    },
    ref,
  ) => {
    const displayValue = typeof value === 'number' ? value.toString() : value;

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        // Allow empty string (parent decides what to do)
        if (raw === '') {
          onChange(0);
          return;
        }
        // Strip non-numeric except dot
        const cleaned = raw.replace(/[^0-9.]/g, '');
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          onChange(parsed);
        }
      },
      [onChange],
    );

    const quickAction = useCallback(
      (factor: 'half' | 'double' | 'max') => {
        if (max == null) return;
        if (factor === 'half') onChange(max / 2);
        else if (factor === 'double') onChange(Math.min(max, (typeof value === 'number' ? value : 0) * 2));
        else if (factor === 'max') onChange(max);
      },
      [max, value, onChange],
    );

    return (
      <div className="w-full">
        <div className="relative">
          <input
            ref={ref}
            type="text"
            inputMode="decimal"
            value={displayValue}
            onChange={handleChange}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(
              'w-full h-14 px-4 pr-16 bg-void border border-border rounded-lg text-text-primary font-mono text-base text-right tabular-nums placeholder-text-muted',
              'transition-all duration-150 outline-none',
              'focus:border-brand-green',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            style={{ boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.4)' }}
            {...rest}
          />
          <div className="absolute right-4 top-1/2 -translate-y-1/2 text-text-muted font-mono text-sm pointer-events-none">
            {currency}
          </div>
        </div>
        {showQuickButtons && max != null && (
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={() => quickAction('half')}
              disabled={disabled}
              className="flex-1 h-8 rounded-md bg-surface2 text-text-secondary text-xs font-medium hover:bg-border hover:text-text-primary transition-colors disabled:opacity-50"
            >
              ½
            </button>
            <button
              type="button"
              onClick={() => quickAction('double')}
              disabled={disabled}
              className="flex-1 h-8 rounded-md bg-surface2 text-text-secondary text-xs font-medium hover:bg-border hover:text-text-primary transition-colors disabled:opacity-50"
            >
              2x
            </button>
            <button
              type="button"
              onClick={() => quickAction('max')}
              disabled={disabled}
              className="flex-1 h-8 rounded-md bg-surface2 text-text-secondary text-xs font-medium hover:bg-border hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Max
            </button>
          </div>
        )}
      </div>
    );
  },
);
BetAmountInput.displayName = 'BetAmountInput';

// ── SearchInput ────────────────────────────────────────────────
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onClear, className, ...rest }, ref) => {
    const [internalValue, setInternalValue] = useState('');
    const v = (value as string) ?? internalValue;
    const showClear = !!v && !!onClear;

    return (
      <div className="relative w-full">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
          <Search size={16} />
        </div>
        <input
          ref={ref}
          type="search"
          value={v}
          onChange={(e) => {
            setInternalValue(e.target.value);
            rest.onChange?.(e);
          }}
          className={cn(
            'w-full h-10 pl-10 pr-10 bg-void border border-border rounded-lg text-text-primary text-sm placeholder-text-muted',
            'transition-all duration-150 outline-none',
            'focus:border-brand-green',
            className,
          )}
          style={{ boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.4)' }}
          {...rest}
        />
        {showClear && (
          <button
            type="button"
            onClick={() => {
              setInternalValue('');
              onClear?.();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  },
);
SearchInput.displayName = 'SearchInput';

export default Input;