'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  TOAST — Stackable notifications
 * ═══════════════════════════════════════════════════════════════
 *
 *  Imperative API: `showToast({...})` from anywhere. Toast renders into
 *  a fixed container that's mounted once in the app root.
 *
 *  USAGE:
 *    import { showToast, ToastContainer } from '@/design-system/components/Toast';
 *
 *    // In your layout or _app:
 *    <ToastContainer />
 *
 *    // Anywhere else:
 *    showToast({ message: 'Bet placed!', variant: 'success' });
 *    showToast({ message: 'Connection lost', variant: 'danger', duration: 0 });
 *
 *  REASON FOR NOT USING SONNER:
 *    Sonner relies on React 18 createPortal patterns that fail silently
 *    with React 19 (per memory). This implementation does the same thing
 *    in ~50 lines without that dependency.
 *
 *  VARIANTS:
 *    - info    → blue
 *    - success → green
 *    - warning → amber
 *    - danger  → red
 *
 *  OPTIONS:
 *    - duration  → ms before auto-dismiss (0 = sticky, default 4000)
 *    - action    → optional action button (e.g., "Undo", "Retry")
 * ═══════════════════════════════════════════════════════════════
 */

import { ReactNode, useEffect, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { cn } from '@/design-system/components/utils';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  message: ReactNode;
  variant?: ToastVariant;
  duration?: number;   // ms; 0 = sticky
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastEntry {
  id: string;
  message: ReactNode;
  variant: ToastVariant;
  duration: number;
  action?: ToastOptions['action'];
}

const subscribers = new Set<(toasts: ToastEntry[]) => void>();
let toastId = 0;
const toastQueue: ToastEntry[] = [];

function notify() {
  subscribers.forEach((cb) => cb([...toastQueue]));
}

export function showToast(options: ToastOptions): string {
  const id = `toast-${++toastId}`;
  toastQueue.push({
    id,
    message: options.message,
    variant: options.variant ?? 'info',
    duration: options.duration ?? 4000,
    action: options.action,
  });
  notify();
  return id;
}

export function dismissToast(id: string) {
  const idx = toastQueue.findIndex((t) => t.id === id);
  if (idx >= 0) {
    toastQueue.splice(idx, 1);
    notify();
  }
}

// ── Container (mount once in app root) ─────────────────────────
const variantIcons: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

const variantColorClasses: Record<ToastVariant, string> = {
  info:    'text-brand-info border-brand-info/40',
  success: 'text-brand-green border-brand-green/40',
  warning: 'text-brand-gold border-brand-gold/40',
  danger:  'text-brand-red border-brand-red/40',
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const cb = (next: ToastEntry[]) => setToasts(next);
    subscribers.add(cb);
    setToasts([...toastQueue]);
    return () => { subscribers.delete(cb); };
  }, []);

  // Auto-dismiss timers
  useEffect(() => {
    const timers = toasts
      .filter((t) => t.duration > 0)
      .map((t) =>
        setTimeout(() => dismissToast(t.id), t.duration),
      );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  const handleDismiss = useCallback((id: string) => dismissToast(id), []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[3000] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => {
        const Icon = variantIcons[toast.variant];
        return (
          <div
            key={toast.id}
            role="status"
            className={cn(
              'pointer-events-auto',
              'glass-card-raised rounded-lg p-3 pr-2 min-w-[280px] max-w-md',
              'flex items-start gap-2',
              'border-l-4',
              variantColorClasses[toast.variant],
              'animate-lift-in',
            )}
          >
            <Icon size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 text-sm text-text-primary">
              {toast.message}
            </div>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  handleDismiss(toast.id);
                }}
                className="shrink-0 text-text-secondary hover:text-text-primary text-xs font-medium px-2 py-0.5 rounded hover:bg-surface2 transition-colors"
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDismiss(toast.id)}
              className="shrink-0 text-text-muted hover:text-text-primary p-1 -m-1"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
ToastContainer.displayName = 'ToastContainer';

export default ToastContainer;