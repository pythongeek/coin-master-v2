/**
 * =============================================================
 *  PAYMENT SOCKET BROADCASTER - emits real-time order updates
 * =============================================================
 *
 *  Used by:
 *    - binance-pay-ledger-monitor.service.ts (when AUTO_CREDIT fires)
 *    - admin-payments-qr.ts (when admin releases/rejects/holds)
 *    - binance-pay-qr.service.ts (on initiate, attachReceipt, expire)
 *
  Convention:
    Room:    payments:{userId}
    Event:   payment:update
    Payload: { orderId, status, amountUsdt, amountCoins, llmVerdict, detectedTxHash }
 */

import type { Server as SocketIOServer } from 'socket.io';

let ioRef: SocketIOServer | null = null;

export function bindPaymentSocket(io: SocketIOServer): void {
  ioRef = io;
}

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

export function emitPaymentUpdate(userId: string, event: PaymentUpdateEvent): void {
  if (!ioRef) return;
  ioRef.to(`payments:${userId}`).emit('payment:update', event);
}

export function emitPaymentUpdateToAll(event: PaymentUpdateEvent): void {
  if (!ioRef) return;
  ioRef.emit('payment:update:any', event);
}
