'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  TABLE — Generic data table (bet history, leaderboard, users)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Polymorphic over the row type. Provide columns and Table handles
 *  headers, body, empty state, and consistent dark-casino styling.
 *
 *  USAGE:
 *    import { Table, type Column } from '@/design-system/components/Table';
 *
 *    interface Bet {
 *      id: string;
 *      user: string;
 *      amount: number;
 *      multiplier: number;
 *      profit: number;
 *    }
 *
 *    const columns: Column<Bet>[] = [
 *      { key: 'user',       header: 'User',       align: 'left' },
 *      { key: 'amount',     header: 'Bet',        align: 'right', format: (v) => v.toFixed(2) },
 *      { key: 'multiplier', header: 'Multiplier', align: 'right', format: (v) => `${v}x` },
 *      { key: 'profit',     header: 'Profit',     align: 'right',
 *        format: (v) => v > 0 ? `+${v}` : `${v}`,
 *        cellClassName: (v) => v > 0 ? 'text-brand-green' : 'text-brand-red' },
 *    ];
 *
 *    <Table columns={columns} data={bets} emptyMessage="No bets yet" />
 *
 *  FEATURES:
 *    - Empty state with optional custom element
 *    - Row click handler
 *    - Row-level className (for highlighting, e.g., "won/lost")
 *    - Tabular nums (monospaced digits) by default
 *    - Sticky header (optional)
 *    - Max-height scroll body
 * ═══════════════════════════════════════════════════════════════
 */

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/design-system/components/utils';

export type ColumnAlign = 'left' | 'right' | 'center';

export interface Column<T> {
  /** Unique key — used as React key */
  key: string;
  /** Header text or element */
  header: ReactNode;
  /** Alignment of header AND body cells */
  align?: ColumnAlign;
  /** Width hint — Tailwind class like 'w-32' or '%' */
  width?: string;
  /** Custom formatter for cell value */
  format?: (value: T[keyof T], row: T) => ReactNode;
  /** Custom className for cells in this column (e.g., color-code by value) */
  cellClassName?: (value: T[keyof T], row: T) => string;
  /** Cell render function (overrides value access) */
  render?: (row: T) => ReactNode;
}

export interface TableProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  columns: Column<T>[];
  data: T[];
  /** Unique key extractor */
  rowKey: (row: T) => string;
  /** Click handler for rows */
  onRowClick?: (row: T) => void;
  /** Per-row className (e.g., highlight won bets green) */
  rowClassName?: (row: T) => string;
  /** Empty state message or element */
  emptyMessage?: ReactNode;
  /** Make header sticky */
  stickyHeader?: boolean;
  /** Max height with overflow scroll */
  maxHeight?: string;
  /** Compact density (smaller padding) */
  compact?: boolean;
}

const alignClass: Record<ColumnAlign, string> = {
  left:   'text-left',
  right:  'text-right',
  center: 'text-center',
};

export function Table<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  rowClassName,
  emptyMessage = 'No data',
  stickyHeader = false,
  maxHeight,
  compact = false,
  className,
  ...rest
}: TableProps<T>) {
  const paddingY = compact ? 'py-1.5' : 'py-2';
  const paddingX = compact ? 'px-2' : 'px-3';

  return (
    <div
      className={cn(
        'w-full overflow-auto',
        maxHeight && `max-h-[${maxHeight}]`,
        className,
      )}
      {...rest}
    >
      <table className="w-full text-sm border-collapse">
        <thead className={cn(
          'text-text-muted text-xs uppercase tracking-wide',
          stickyHeader && 'sticky top-0 z-10 bg-surface',
        )}>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  paddingY,
                  paddingX,
                  'font-medium',
                  alignClass[col.align ?? 'left'],
                  col.width,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className={cn(paddingY, paddingX, 'text-center text-text-muted')}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'border-b border-border/50 hover:bg-surface2/50 transition-colors',
                  onRowClick && 'cursor-pointer',
                  rowClassName?.(row),
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => {
                  const value = (row as Record<string, unknown>)[col.key];
                  const cellContent = col.render
                    ? col.render(row)
                    : col.format
                      ? col.format(value as T[keyof T], row)
                      : (value as ReactNode);
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        paddingY,
                        paddingX,
                        'font-mono tabular-nums',
                        alignClass[col.align ?? 'left'],
                        col.cellClassName?.(value as T[keyof T], row),
                      )}
                    >
                      {cellContent}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
Table.displayName = 'Table';

export default Table;