-- Migration 024: add 'cancelled' to payment_orders.status CHECK constraint
-- Phase 8 P0 fix: user-initiated QR cancel (DELETE /api/wallet/deposit/qr/:orderId)
-- sets status='cancelled'. The original migration 018 was missing this value.

ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN (
    'pending',
    'awaiting_payment',
    'detected',
    'verifying',
    'paid',
    'failed',
    'expired',
    'refunded',
    'cancelled'
  ));
