'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  BUTTON — Primary, Secondary, Ghost, Danger variants
 * ═══════════════════════════════════════════════════════════════
 *
 *  Thin React wrapper around existing CSS classes (.btn-brand, .btn-brand-outline)
 *  with extra variants for Danger (red) and Ghost (transparent).
 *
 *  USAGE:
 *    import { Button } from '@/design-system/components/Button';
 *    <Button variant="primary" size="lg">Flip for $5.00</Button>
 *    <Button variant="danger" loading>Deleting...</Button>
 *
 *  VARIANTS:
 *    - primary   → filled green (default CTA)
 *    - secondary → outline green (secondary action)
 *    - ghost     → transparent (tertiary / inline action)
 *    - danger    → filled red (destructive action)
 *
 *  SIZES:
 *    - sm  → 32px tall (chips, inline)
 *    - md  → 40px tall (default)
 *    - lg  → 56px tall (primary CTA, "Flip for $X")
 *
 *  STATES:
 *    - loading → shows spinner, disables interaction
 *    - disabled → grayed out
 *
 *  EXISTING CLASSES PRESERVED:
 *    - `primary` uses the existing `.btn-brand` CSS class
 *    - `secondary` uses the existing `.btn-brand-outline` CSS class
 *    - These continue to work without the new component
 * ═══════════════════════════════════════════════════════════════
 */

import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

// ── Variant styles (additive — don't break existing .btn-brand CSS class) ──
const variantClasses: Record<ButtonVariant, string> = {
  primary:   'btn-brand',           // filled green (existing)
  secondary: 'btn-brand-outline',   // outline green (existing)
  ghost: `
    relative px-6 py-3 font-display font-semibold text-text-secondary
    rounded-lg bg-transparent
    transition-all duration-150 ease-out
    hover:bg-surface2 hover:text-text-primary hover:-translate-y-0.5
    active:translate-y-0
  `.replace(/\s+/g, ' ').trim(),
  danger: `
    relative px-6 py-3 font-display font-semibold text-white
    bg-brand-red rounded-lg shadow-elevate-sm
    transition-all duration-150 ease-out
    hover:bg-brand-red-dim hover:shadow-brand-red hover:-translate-y-0.5
    active:translate-y-0 active:shadow-elevate-sm
    background-image linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 55%)
  `.replace(/\s+/g, ' ').trim(),
};

// ── Size styles (overrides default padding for non-primary/secondary variants) ──
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-5 text-sm',
  lg: 'h-14 px-8 text-lg',
};

// ── Fix: Tailwind has issues with `background-image:` in string literal. Use proper class for danger. ──
const dangerBgFix = 'hover:bg-brand-red-dim hover:shadow-brand-red hover:-translate-y-0.5';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      fullWidth = false,
      leftIcon,
      rightIcon,
      className = '',
      children,
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    const widthClass = fullWidth ? 'w-full' : '';

    // Compose variant + size + width
    // Note: for 'primary' and 'secondary', the CSS class already includes padding,
    // so we only ADD size classes for 'ghost' and 'danger' (which have inline padding).
    const baseClasses = variantClasses[variant];
    const needsSizeOverride = variant === 'ghost' || variant === 'danger';
    const sizeClass = needsSizeOverride ? sizeClasses[size] : '';
    const dangerBgFixClass = variant === 'danger' ? dangerBgFix : '';

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={[
          'inline-flex items-center justify-center gap-2',
          baseClasses,
          sizeClass,
          dangerBgFixClass,
          widthClass,
          isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-busy={loading || undefined}
        {...rest}
      >
        {loading ? (
          <Loader2 size={size === 'lg' ? 22 : size === 'sm' ? 12 : 16} className="animate-spin" />
        ) : (
          leftIcon
        )}
        <span>{children}</span>
        {!loading && rightIcon}
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;