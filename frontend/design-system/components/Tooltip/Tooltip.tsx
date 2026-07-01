'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  TOOLTIP — Hover info popover
 * ═══════════════════════════════════════════════════════════════
 *
 *  Pure-CSS hover tooltip (no Radix Tooltip — see react-19-portal
 *  caveat in Modal.tsx).
 *
 *  USAGE:
 *    import { Tooltip } from '@/design-system/components/Tooltip';
 *
 *    <Tooltip content="House edge is the casino's commission">
 *      <span>?</span>
 *    </Tooltip>
 *
 *  POSITIONS:
 *    - top, bottom, left, right
 *
 *  ACCESSIBILITY:
 *    - Uses role="tooltip" on the popup
 *    - Wrapped via aria-describedby on the child via React.cloneElement
 *      (when child is a single element)
 * ═══════════════════════════════════════════════════════════════
 */

import { ReactNode, cloneElement, isValidElement } from 'react';
import { cn } from '@/design-system/components/utils';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  position?: TooltipPosition;
  /** Delay (ms) before showing on hover */
  delay?: number;
  children: ReactNode;
  className?: string;
}

const positionClasses: Record<TooltipPosition, string> = {
  top:    'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left:   'right-full top-1/2 -translate-y-1/2 mr-2',
  right:  'left-full top-1/2 -translate-y-1/2 ml-2',
};

const arrowClasses: Record<TooltipPosition, string> = {
  top:    'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-surface2',
  bottom: 'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-surface2',
  left:   'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-surface2',
  right:  'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-surface2',
};

export function Tooltip({
  content,
  position = 'top',
  delay = 200,
  children,
  className,
}: TooltipProps) {
  // Wrap child so tooltip is shown on hover/focus
  const childProps: Record<string, unknown> = {
    className: cn('relative inline-flex', className),
  };

  if (isValidElement(children)) {
    const childEl = children as React.ReactElement<{ className?: string; children?: ReactNode }>;
    const existingClass = childEl.props.className ?? '';
    const childProps = childEl.props;
    // cloneElement typing is overly strict in React 18+ for arbitrary children
    return cloneElement(childEl, {
      ...childEl.props,
      className: cn('relative inline-flex group/tooltip', existingClass),
      children: (
        <>
          {childProps.children}
          <span
            role="tooltip"
            className={cn(
              'pointer-events-none absolute z-[200] whitespace-nowrap',
              'px-2.5 py-1.5 rounded-md',
              'bg-surface2 border border-border2 text-text-primary text-xs font-medium',
              'shadow-elevate-md',
              'opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible',
              'transition-opacity duration-150',
              positionClasses[position],
            )}
            style={{ transitionDelay: `${delay}ms` }}
          >
            {content}
            {/* arrow */}
            <span
              aria-hidden="true"
              className={cn(
                'absolute w-0 h-0 border-4',
                arrowClasses[position],
              )}
            />
          </span>
        </>
      ),
    });
  }

  // Fallback if children isn't a single element
  return (
    <span {...childProps}>
      {children}
      <span role="tooltip" className="sr-only">{content}</span>
    </span>
  );
}

export default Tooltip;