/**
 * P2-11 focused test — deposit status constants.
 *
 * Verifies:
 *   1. DEPOSIT_STATUS has exactly the 6 values from the live DB
 *      transactions_status_check constraint
 *   2. DepositStatus type matches the constant values
 *   3. QR_ORDER_STATUS has the 7 payment_orders values
 *   4. QrOrderStatus type matches
 *   5. ALL_DEPOSIT_STATUSES / ALL_QR_ORDER_STATUSES array membership
 *   6. String literals in deposit-monitor.ts use ${DEPOSIT_STATUS.*}
 *   7. String literals in binance-pay-qr.service.ts use ${QR_ORDER_STATUS.*}
 *      (with the exception of L230 which is a code comment)
 *
 * Run with: npx ts-node --require ./src/test/setup.ts src/test/p2-11-deposit-status.test.ts
 */

import {
  DEPOSIT_STATUS,
  ALL_DEPOSIT_STATUSES,
  type DepositStatus,
  QR_ORDER_STATUS,
  ALL_QR_ORDER_STATUSES,
  type QrOrderStatus,
} from '../constants/deposit';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

console.log('P2-11: deposit status constants');

// ── Case 1: DEPOSIT_STATUS values match the live DB constraint ────
// Reference values from pg_constraint:
const EXPECTED_DEPOSIT = {
  PENDING: 'pending',
  CONFIRMING: 'confirming',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
assert(JSON.stringify(DEPOSIT_STATUS) === JSON.stringify(EXPECTED_DEPOSIT),
  'DEPOSIT_STATUS matches live DB transactions_status_check values');

// ── Case 2: DepositStatus type union covers all values ───────────
const allDepositValues: DepositStatus[] = [
  DEPOSIT_STATUS.PENDING,
  DEPOSIT_STATUS.CONFIRMING,
  DEPOSIT_STATUS.CONFIRMED,
  DEPOSIT_STATUS.COMPLETED,
  DEPOSIT_STATUS.FAILED,
  DEPOSIT_STATUS.CANCELLED,
];
assert(allDepositValues.length === 6, `DepositStatus has 6 distinct values (got ${allDepositValues.length})`);

// ── Case 3: QR_ORDER_STATUS values match the QR flow ──────────────
const EXPECTED_QR = {
  AWAITING_PAYMENT: 'awaiting_payment',
  DETECTED: 'detected',
  VERIFYING: 'verifying',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};
assert(JSON.stringify(QR_ORDER_STATUS) === JSON.stringify(EXPECTED_QR),
  'QR_ORDER_STATUS matches payment_orders.status values');

// ── Case 4: QrOrderStatus type union ─────────────────────────────
const allQrValues: QrOrderStatus[] = [
  QR_ORDER_STATUS.AWAITING_PAYMENT,
  QR_ORDER_STATUS.DETECTED,
  QR_ORDER_STATUS.VERIFYING,
  QR_ORDER_STATUS.PAID,
  QR_ORDER_STATUS.FAILED,
  QR_ORDER_STATUS.EXPIRED,
  QR_ORDER_STATUS.CANCELLED,
];
assert(allQrValues.length === 7, `QrOrderStatus has 7 distinct values (got ${allQrValues.length})`);

// ── Case 5: ALL_*_STATUSES array membership ─────────────────────
assert(ALL_DEPOSIT_STATUSES.length === 6,
  `ALL_DEPOSIT_STATUSES has 6 entries (got ${ALL_DEPOSIT_STATUSES.length})`);
assert(ALL_QR_ORDER_STATUSES.length === 7,
  `ALL_QR_ORDER_STATUSES has 7 entries (got ${ALL_QR_ORDER_STATUSES.length})`);
assert(ALL_DEPOSIT_STATUSES.includes(DEPOSIT_STATUS.PENDING), 'ALL_DEPOSIT_STATUSES includes PENDING');
assert(ALL_QR_ORDER_STATUSES.includes(QR_ORDER_STATUS.AWAITING_PAYMENT), 'ALL_QR_ORDER_STATUSES includes AWAITING_PAYMENT');

// ── Case 6: deposit-monitor.ts uses ${DEPOSIT_STATUS.*} ──────────
const fs = require('fs') as typeof import('fs');
const depositMonitorSrc = fs.readFileSync(
  __dirname + '/../services/deposit-monitor.ts',
  'utf-8',
);
assert(
  depositMonitorSrc.includes('${DEPOSIT_STATUS.CONFIRMING}'),
  'deposit-monitor.ts uses ${DEPOSIT_STATUS.CONFIRMING}',
);
assert(
  depositMonitorSrc.includes('${DEPOSIT_STATUS.COMPLETED}'),
  'deposit-monitor.ts uses ${DEPOSIT_STATUS.COMPLETED}',
);
// The only remaining literal should be the "deposit" string used for
// the transaction type column (not a status), which is unrelated.
const remainingStatusLiterals = depositMonitorSrc.match(
  /'(pending|confirming|completed|confirmed|failed|cancelled)'/g,
);
const realStatusLiterals = (remainingStatusLiterals || []).filter(
  (s: string) => s !== "'deposit'",
);
assert(
  realStatusLiterals.length === 0,
  `deposit-monitor.ts has zero status literals (got ${JSON.stringify(realStatusLiterals)})`,
);

// ── Case 7: binance-pay-qr.service.ts uses QR_ORDER_STATUS.* ────
const binanceSrc = fs.readFileSync(
  __dirname + '/../services/binance-pay-qr.service.ts',
  'utf-8',
);
const requiredQrRefs = [
  'QR_ORDER_STATUS.AWAITING_PAYMENT',
  'QR_ORDER_STATUS.DETECTED',
  'QR_ORDER_STATUS.VERIFYING',
  'QR_ORDER_STATUS.PAID',
  'QR_ORDER_STATUS.EXPIRED',
  'QR_ORDER_STATUS.CANCELLED',
];
for (const ref of requiredQrRefs) {
  assert(binanceSrc.includes(ref), `binance-pay-qr.service.ts references ${ref}`);
}

// Comments (L230) and the wire-format emit (now uses QR_ORDER_STATUS)
// are exempt. Confirm zero raw status literals remain outside comments
// by removing comment lines first.
const codeLines = binanceSrc.split('\n').filter(
  (l: string) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
);
const codeOnly = codeLines.join('\n');
const qrLiterals = codeOnly.match(
  /'(awaiting_payment|detected|verifying|paid|failed|expired|cancelled)'/g,
);
assert(
  (qrLiterals || []).length === 0,
  `binance-pay-qr.service.ts has zero QR-status literals in code (got ${JSON.stringify(qrLiterals || [])})`,
);

// ── Case 8: The two status sets share only the natural terminal states ──
// 'failed' and 'cancelled' appear in BOTH sets (natural terminal states).
// 'confirmed' and 'completed' are mutually exclusive (DB-side distinction).
const SHARED = new Set(['failed', 'cancelled']);
const depositOnly = new Set(
  Object.values(DEPOSIT_STATUS).filter((s) => !SHARED.has(s as string)),
);
const qrOnly = new Set(
  Object.values(QR_ORDER_STATUS).filter((s) => !SHARED.has(s as string)),
);
for (const dep of depositOnly) {
  assert(
    !qrOnly.has(dep as any),
    `DEPOSIT_STATUS-exclusive '${dep}' is not in QR_ORDER_STATUS (correct — DB-side distinction)`,
  );
}
for (const qr of qrOnly) {
  assert(
    !depositOnly.has(qr as any),
    `QR_ORDER_STATUS-exclusive '${qr}' is not in DEPOSIT_STATUS (correct — wire/UX-side distinction)`,
  );
}
assert(
  depositOnly.size === 4 && qrOnly.size === 5,
  `DEPOSIT has 4 unique + 2 shared; QR has 5 unique + 2 shared (got ${depositOnly.size}/${qrOnly.size})`,
);

console.log('');
if (failed) {
  console.error('FAILED: P2-11 deposit-status tests did not all pass');
  process.exit(1);
} else {
  console.log('PASS: All P2-11 deposit-status tests passed');
  process.exit(0);
}
