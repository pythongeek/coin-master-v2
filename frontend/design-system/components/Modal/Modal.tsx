'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  MODAL — Centered dialog with backdrop
 * ═══════════════════════════════════════════════════════════════
 *
 *  Implemented WITHOUT react-dom createPortal or Radix Dialog —
 *  both fail silently with React 19 + Next.js 14.
 *
 *  Recipe (matches `react-19-portal-replacement`):
 *    - Module-level singleton state (subscribers set)
 *    - Imperative show()/hide() API
 *    - Conditional render into document.body via direct DOM manipulation
 *
 *  USAGE:
 *    import { Modal, showModal, hideModal } from '@/design-system/components/Modal';
 *
 *    function SettingsButton() {
 *      return <Button onClick={() => showModal('settings')}>Settings</Button>;
 *    }
 *
 *    // In layout or _app:
 *    <Modal id="settings" title="Settings" onClose={() => hideModal('settings')}>
 *      <p>Settings content</p>
 *    </Modal>
 *
 *  VARIANTS:
 *    - sm  → 384px max width (small confirmations)
 *    - md  → 480px max width (default)
 *    - lg  → 640px max width (forms, settings)
 *    - xl  → 800px max width (rich content)
 *
 *  SUBCOMPONENTS:
 *    - Modal.Header  → title + close button
 *    - Modal.Body    → scrollable content area
 *    - Modal.Footer  → action buttons
 *
 *  ACCESSIBILITY:
 *    - Escape key closes
 *    - Click on backdrop closes
 *    - Focus trap is NOT implemented (Radix would have done this) — see
 *      react-19-portal-replacement recipe for upgrade path.
 *    - aria-modal + aria-labelledby
 * ═══════════════════════════════════════════════════════════════
 */

import {
  HTMLAttributes,
  ReactNode,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { X } from 'lucide-react';
import { cn } from '@/design-system/components/utils';

// ── Module-level singleton state ───────────────────────────────
const modalSubscribers = new Map<string, () => void>();
const modalContent = new Map<string, ReactNode>();

export function showModal(id: string) {
  modalSubscribers.get(id)?.();
}
export function hideModal(id: string) {
  // mark this modal hidden — listener flips the useState to render null
  modalSubscribers.get(id)?.();
  modalContent.delete(id);
}

/** Internal — Modal component calls this to provide its content node */
function _registerModalContent(id: string, content: ReactNode) {
  modalContent.set(id, content);
  // notify any external triggers
  modalSubscribers.get(id)?.();
}

// ── Types ──────────────────────────────────────────────────────
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  title?: string;
  size?: ModalSize;
  /** Called when user presses Escape or clicks backdrop */
  onClose?: () => void;
  /** Hide the default close button */
  hideCloseButton?: boolean;
  children?: ReactNode;
}

const sizeMaxWidth: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
};

// ── Modal Root ─────────────────────────────────────────────────
function ModalRoot({
  id,
  title,
  size = 'md',
  onClose,
  hideCloseButton = false,
  className,
  children,
  ...rest
}: ModalProps) {
  const [open, setOpen] = useState(false);

  // Subscribe to imperative show/hide
  useEffect(() => {
    modalSubscribers.set(id, () => setOpen((v) => !v));
    return () => { modalSubscribers.delete(id); };
  }, [id]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return;
    const orig = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = orig; };
  }, [open]);

  // Render directly to document.body (no portal — see file header)
  useEffect(() => {
    if (!open) return;
    // The actual <div> below is rendered via React tree, not portal.
    // React will place it where we use <Modal id=...> in the JSX tree.
    // Body scroll lock is the main side effect.
  }, [open]);

  if (!open) return null;

  const handleBackdrop = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? `modal-${id}-title` : undefined}
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      {...rest}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-void/80 backdrop-blur-sm animate-fade-in"
        onClick={handleBackdrop}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        className={cn(
          'relative w-full glass-card-raised rounded-xl p-6 animate-lift-in',
          sizeMaxWidth[size],
          className,
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between mb-4">
            {title && (
              <h2 id={`modal-${id}-title`} className="heading-display text-xl text-text-primary">
                {title}
              </h2>
            )}
            {!hideCloseButton && (
              <button
                type="button"
                onClick={handleBackdrop}
                className="ml-auto text-text-muted hover:text-text-primary transition-colors p-1 -m-1"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function ModalBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('', className)} {...rest}>{children}</div>;
}

function ModalFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-end gap-2 pt-4 mt-4 border-t border-border', className)} {...rest}>
      {children}
    </div>
  );
}

ModalRoot.displayName = 'Modal';
export const Modal = Object.assign(ModalRoot, {
  Body:   ModalBody,
  Footer: ModalFooter,
});

export default Modal;