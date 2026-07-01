'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  TABS — Controlled tab switcher
 * ═══════════════════════════════════════════════════════════════
 *
 *  USAGE:
 *    import { Tabs, type TabItem } from '@/design-system/components/Tabs';
 *
 *    const tabs: TabItem[] = [
 *      { id: 'manual', label: 'Manual' },
 *      { id: 'auto',   label: 'Auto' },
 *    ];
 *
 *    const [active, setActive] = useState('manual');
 *    <Tabs items={tabs} value={active} onChange={setActive} />
 *    {active === 'manual' && <ManualPanel />}
 *    {active === 'auto'   && <AutoPanel />}
 *
 *  VARIANTS:
 *    - underline → bottom border highlights active (default for top tabs)
 *    - pill      → rounded background highlights active (default for in-card tabs)
 *    - button    → segmented-button style (each tab a button)
 *
 *  SIZES:
 *    - sm   → 28px tall
 *    - md   → 36px tall (default)
 *    - lg   → 44px tall
 * ═══════════════════════════════════════════════════════════════
 */

import { ReactNode } from 'react';
import { cn } from '@/design-system/components/utils';

export type TabsVariant = 'underline' | 'pill' | 'button';
export type TabsSize = 'sm' | 'md' | 'lg';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: TabsVariant;
  size?: TabsSize;
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
}

const sizeClasses: Record<TabsSize, string> = {
  sm: 'h-7 text-xs',
  md: 'h-9 text-sm',
  lg: 'h-11 text-base',
};

export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  variant = 'pill',
  size = 'md',
  fullWidth = false,
  className,
  ariaLabel,
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex',
        variant === 'underline' ? 'border-b border-border gap-4' : 'bg-surface2 rounded-lg p-1 gap-1',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.id === value;
        const isDisabled = !!item.disabled;

        const baseClasses = cn(
          'inline-flex items-center justify-center gap-1.5 px-3 rounded-md font-medium transition-all duration-150',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green',
          fullWidth && 'flex-1',
          sizeClasses[size],
        );

        const variantClasses =
          variant === 'pill'
            ? cn(
                isActive
                  ? 'bg-border text-text-primary shadow-elevate-sm'
                  : 'text-text-secondary hover:text-text-primary hover:bg-border/50',
              )
            : variant === 'button'
              ? cn(
                  isActive
                    ? 'bg-brand-green text-void shadow-brand-green'
                    : 'bg-surface text-text-secondary hover:text-text-primary hover:bg-surface2',
                )
              : // underline
                cn(
                  'border-b-2 -mb-px',
                  isActive
                    ? 'border-brand-green text-brand-green'
                    : 'border-transparent text-text-secondary hover:text-text-primary',
                );

        return (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => !isDisabled && onChange(item.id)}
            className={cn(
              baseClasses,
              variantClasses,
              isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
Tabs.displayName = 'Tabs';

export default Tabs;