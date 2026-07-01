/**
 * ═══════════════════════════════════════════════════════════════
 *  DESIGN SYSTEM — Components barrel export
 * ═══════════════════════════════════════════════════════════════
 *
 *  Single import path for all design-system components.
 *
 *  USAGE:
 *    import { Button, Card, Modal, Slider, Tabs, Toast } from '@/design-system/components';
 *
 *  Or per-component imports for tree-shaking:
 *    import { Button } from '@/design-system/components/Button';
 *
 *  ALSO EXPORTS:
 *    - cn utility (className combinator)
 *
 *  NOT EXPORTED:
 *    - Internal CSS classes (use the Tailwind classes directly OR
 *      use the component variants)
 * ═══════════════════════════════════════════════════════════════
 */

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Input, BetAmountInput, SearchInput } from './Input';
export type { InputVariant, InputSize, BetAmountInputProps, SearchInputProps, BaseInputProps } from './Input';

export { Card, StatCard } from './Card';
export type { CardProps, CardVariant, StatCardProps } from './Card';

export { Modal, showModal, hideModal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';

export { Tooltip } from './Tooltip';
export type { TooltipProps, TooltipPosition } from './Tooltip';

export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant, BadgeSize, VipTier } from './Badge';

export { Progress } from './Progress';
export type { ProgressProps, ProgressVariant, ProgressColor } from './Progress';

export { Table } from './Table';
export type { TableProps, Column, ColumnAlign } from './Table';

export { Tabs } from './Tabs';
export type { TabsProps, TabItem, TabsVariant, TabsSize } from './Tabs';

export { Slider } from './Slider';
export type { SliderProps, SliderColor } from './Slider';

export { ToastContainer, showToast, dismissToast } from './Toast';
export type { ToastVariant, ToastOptions } from './Toast';

export { cn } from './utils';
export type { ClassValue } from './utils';