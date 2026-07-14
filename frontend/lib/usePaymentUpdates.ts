'use client';
/**
 * =============================================================
 *  usePaymentUpdates - subscribe to payment:update socket events
 * =============================================================
 *  Returns a callback that fires when the current user's order
 *  status changes. Use alongside (or instead of) polling.
 */

import { useEffect, useRef } from 'react';
import { getSocket } from './socket';

export interface PaymentUpdateEvent {
  orderId: string;
  userId?: string;
  status: 'awaiting_payment' | 'detected' | 'verifying' | 'paid' | 'failed' | 'expired';
  amountUsdt?: number;
  amountCoins?: number;
  llmVerdict?: string | null;
  llmConfidence?: number | null;
  detectedTxHash?: string | null;
  reason?: string;
}

export function usePaymentUpdates(
  userId: string | null,
  onUpdate: (event: PaymentUpdateEvent) => void,
  filterOrderId?: string
) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();

    const handler = (event: PaymentUpdateEvent) => {
      if (event.userId && event.userId !== userId) return;
      if (filterOrderId && event.orderId !== filterOrderId) return;
      callbackRef.current(event);
    };

    socket.on('payment:update', handler);
    return () => {
      socket.off('payment:update', handler);
    };
  }, [userId, filterOrderId]);
}
