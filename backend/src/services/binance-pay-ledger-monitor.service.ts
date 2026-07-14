/**
 * ═══════════════════════════════════════════════════════════════
 *  BINANCE LEDGER MONITOR — polls /sapi/v1/capital/deposit/hisrec
 * ═══════════════════════════════════════════════════════════════
 *
 *  Detects QR deposits by polling Binance's authoritative deposit
 *  ledger, matching ledger entries to our open payment_orders via
 *  qr_memo == ledger.addressTag.
 *
 *  Auth: HMAC-SHA256(secret, queryString)
 *  Endpoint: https://api.binance.com/sapi/v1/capital/deposit/hisrec
 *
 *  ENV VARS REQUIRED:
 *    BINANCE_API_KEY     - 64-char hex public key (read-only, IP-restricted)
 *    BINANCE_API_SECRET  - 64-char hex secret
 *    BINANCE_API_BASE    - 'https://api.binance.com' (default)
 *
 *  SAFETY:
 *    - Read-only API key (no trading/withdrawal permission)
 *    - IP-restricted at Binance (whitelist your backend's egress IP)
 *    - Failure mode: if API fails, orders stay in 'awaiting_payment' and
 *      retry on next tick. We never auto-credit based on uncertain data.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { query, withTransaction } from '../config/database';
import { emitPaymentUpdate } from './payment-socket.service';
import { queueEmail } from './notification.service';
import { coinsToCurrency } from './rate-fetcher';
import { loadChainConfigs, type ChainConfig } from './chain-config.service';
import { scoreDepositWithLlm, ruleBasedVerdict, type ScoringInput, type ScoringVerdict } from './llm-scorer.service';

const BINANCE_API_KEY = (process.env.BINANCE_API_KEY || '').trim();
const BINANCE_API_SECRET = (process.env.BINANCE_API_SECRET || '').trim();
const BINANCE_API_BASE = (process.env.BINANCE_API_BASE || 'https://api.binance.com').replace(/\/$/, '');
const RECV_WINDOW_MS = 5000;
const POLL_INTERVAL_MS = parseInt(process.env.BINANCE_LEDGER_POLL_INTERVAL_MS || '15000', 10);
const ORDER_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

// Chain cache loaded at boot and refreshed every 5 min
let chainCache: { configs: Map<string, ChainConfig>; loadedAt: number } | null = null;
const CHAIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function getEnabledChains(): Promise<Map<string, ChainConfig>> {
  if (chainCache && Date.now() - chainCache.loadedAt < CHAIN_CACHE_TTL_MS) {
    return chainCache.configs;
  }
  const chains = await loadChainConfigs();
  const map = new Map<string, ChainConfig>();
  for (const c of chains) map.set(c.networkCode, c);
  chainCache = { configs: map, loadedAt: Date.now() };
  return map;
}

// ── Binance Spot signed-request helper ─────────────────────────
function signQuery(params: Record<string, string | number>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  q.append('recvWindow', String(RECV_WINDOW_MS));
  q.append('timestamp', String(Date.now()));
  const queryString = q.toString();
  const signature = crypto
    .createHmac('sha256', BINANCE_API_SECRET)
    .update(queryString)
    .digest('hex');
  return `${queryString}&signature=${signature}`;
}

interface BinanceDepositRow {
  id: string;
  amount: string;
  coin: string;
  network: string;
  status: number;          // 0=pending, 1=success, 2=rejected (credited failed)
  address: string;         // our receive address
  addressTag: string;      // memo (matches qr_memo)
  txId: string;
  insertTime: number;
  transferType?: number;
  confirmTimes?: string;
  unlockConfirm?: number;
  walletType?: number;
}

async function callBinanceDepositHisrec(
  startTimeMs: number,
  endTimeMs: number
): Promise<BinanceDepositRow[]> {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error(
      'BINANCE_API_KEY / BINANCE_API_SECRET not configured. Polling disabled.'
    );
  }
  const qs = signQuery({
    coin: 'USDT',
    status: 1, // success only
    startTime: startTimeMs,
    endTime: endTimeMs,
    limit: 1000,
  });
  const url = `${BINANCE_API_BASE}/sapi/v1/capital/deposit/hisrec?${qs}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ledger API ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as BinanceDepositRow[];
  return Array.isArray(json) ? json : [];
}

// ── Find pending QR orders that need matching ─────────────────
async function getOpenQrOrders(): Promise<
  Array<{
    id: string;
    merchant_order_id: string;
    user_id: string;
    qr_memo: string | null;
    amount_crypto: number;
    amount_coins: number;
    chain: string;
    receive_address: string;
    memo_supported: boolean;
    match_strategy: string;
    created_at: Date;
    expires_at: Date;
  }>
> {
  const r = await query(
    `SELECT id, merchant_order_id, user_id, qr_memo,
            amount_crypto::float8 AS amount_crypto,
            amount_coins::float8 AS amount_coins,
            chain, receive_address, memo_supported, match_strategy,
            created_at, expires_at
     FROM payment_orders
     WHERE gateway = 'binance_pay_qr'
       AND status IN ('awaiting_payment', 'detected')
       AND expires_at > NOW()
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at ASC
     LIMIT 200`
  );
  return r.rows as any;
}

// ── Look up user history for LLM context ───────────────────────
async function getUserHistory(userId: string): Promise<{
  lastNDeposits: number;
  avgAmount: number;
  chargebacks: number;
  kycTier: string;
  accountAgeDays: number;
}> {
  const r = await query(
    `SELECT
       (SELECT COUNT(*) FROM payment_orders WHERE user_id = $1 AND status = 'paid')::int AS last_n,
       (SELECT COALESCE(AVG(amount_crypto), 0)::float8 FROM payment_orders WHERE user_id = $1 AND status = 'paid') AS avg_amount,
       (SELECT COUNT(*) FROM audit_log WHERE user_id = $1 AND category = 'payment' AND action = 'chargeback')::int AS chargebacks,
       (SELECT COALESCE(kyc_tier, 'none') FROM users WHERE id = $1) AS kyc_tier,
       (SELECT EXTRACT(DAY FROM NOW() - created_at)::int FROM users WHERE id = $1) AS age_days`,
    [userId]
  );
  const row = r.rows[0] || {};
  return {
    lastNDeposits: row.last_n || 0,
    avgAmount: row.avg_amount || 0,
    chargebacks: row.chargebacks || 0,
    kycTier: row.kyc_tier || 'none',
    accountAgeDays: row.age_days || 0,
  };
}

// ── Credit the user's wallet (reuses payment.ts logic) ────────
async function creditOrder(orderId: string, amountCoins: number, userId: string, source = 'binance_pay_qr'): Promise<boolean> {
  const { handlePaymentWebhook } = await import('./payment');
  const result = await handlePaymentWebhook(
    'binance_pay_qr',
    {
      gatewayOrderId: orderId,
      merchantOrderId: orderId,
      status: 'paid',
      amountUsdt: amountCoins,
      paidAt: new Date(),
      rawPayload: { source: 'binance-ledger-monitor' },
    },
    new Date()
  );
  return result.processed;
}

// ── Hold an order for admin review ─────────────────────────────
async function holdForReview(orderId: string, reason: string, verdict: ScoringVerdict): Promise<void> {
  await query(
    `UPDATE payment_orders
     SET status = 'verifying',
         admin_hold_reason = $1,
         llm_verdict = $2,
         llm_confidence = $3,
         llm_reason = $4,
         llm_scored_at = NOW(),
         updated_at = NOW()
     WHERE merchant_order_id = $5 AND status IN ('awaiting_payment', 'detected')`,
    [reason, verdict.verdict, verdict.confidence, verdict.reason, orderId]
  );
}

async function rejectOrder(orderId: string, reason: string, verdict: ScoringVerdict): Promise<void> {
  await query(
    `UPDATE payment_orders
     SET status = 'failed',
         status_message = $1,
         llm_verdict = 'REJECT',
         llm_confidence = $3,
         llm_reason = $4,
         llm_scored_at = NOW(),
         updated_at = NOW()
     WHERE merchant_order_id = $5 AND status IN ('awaiting_payment', 'detected')`,
    [reason, verdict.confidence, verdict.reason, orderId]
  );
}

// ── Public: scan once (called by cron or self-loop) ────────────
export interface ScanResult {
  scannedOrders: number;
  ledgerEntriesChecked: number;
  matchesFound: number;
  autoCredited: number;
  held: number;
  rejected: number;
  errors: string[];
}

export async function scanOnce(): Promise<ScanResult> {
  const result: ScanResult = {
    scannedOrders: 0, ledgerEntriesChecked: 0, matchesFound: 0,
    autoCredited: 0, held: 0, rejected: 0, errors: [],
  };

  let orders;
  try {
    orders = await getOpenQrOrders();
  } catch (err) {
    result.errors.push(`getOpenQrOrders: ${(err as Error).message}`);
    return result;
  }
  result.scannedOrders = orders.length;
  if (orders.length === 0) return result;

  // Determine Binance query window
  const oldestCreated = Math.min(...orders.map((o) => new Date(o.created_at).getTime()));
  const startTime = oldestCreated - 60_000; // 1-min overlap
  const endTime = Date.now() + 60_000;

  let ledgerRows: BinanceDepositRow[];
  try {
    ledgerRows = await callBinanceDepositHisrec(startTime, endTime);
  } catch (err) {
    result.errors.push(`binanceApi: ${(err as Error).message}`);
    return result;
  }
  result.ledgerEntriesChecked = ledgerRows.length;

  // Index ledger by memo (addressTag)
  const ledgerByMemo = new Map<string, BinanceDepositRow[]>();
  for (const row of ledgerRows) {
    if (!row.addressTag) continue;
    if (!ledgerByMemo.has(row.addressTag)) ledgerByMemo.set(row.addressTag, []);
    ledgerByMemo.get(row.addressTag)!.push(row);
  }

  // Build a second index for non-memo chains: by (chain, amount) for fast lookup
  const ledgerByChainAmount = new Map<string, BinanceDepositRow[]>();
  for (const row of ledgerRows) {
    if (!row.network) continue;
    // Key: chain + amount rounded to 8 decimals
    const key = `${row.network}|${parseFloat(row.amount).toFixed(8)}`;
    if (!ledgerByChainAmount.has(key)) ledgerByChainAmount.set(key, []);
    ledgerByChainAmount.get(key)!.push(row);
  }

  for (const order of orders) {
    // Two matching strategies:
    //   - memo-supported chain (BSC BEP20): exact memo match in ledger's addressTag
    //   - non-memo chain (TRC20 USDT): match by (chain network + exact amount + within time window)
    let candidates: BinanceDepositRow[] = [];
    let matchStrategy = order.match_strategy || 'memo';

    if (order.memo_supported && order.qr_memo) {
      candidates = ledgerByMemo.get(order.qr_memo) || [];
    } else {
      // Try exact amount match first (within last 24h)
      const amountKey = `${order.chain}|${order.amount_crypto.toFixed(8)}`;
      candidates = ledgerByChainAmount.get(amountKey) || [];
      // Fallback: amount within 0.5% tolerance (handles minor gas conversions)
      if (candidates.length === 0) {
        candidates = ledgerRows.filter((row) => {
          if (row.network !== order.chain) return false;
          const delta = Math.abs(parseFloat(row.amount) - order.amount_crypto);
          return delta <= 0.5; // within 50 cents
        });
      }
    }
    if (candidates.length === 0) continue;

    // For non-memo chains, require exact amount to avoid false matches
    if (!order.memo_supported) {
      const exactMatch = candidates.find((c) => Math.abs(parseFloat(c.amount) - order.amount_crypto) < 0.01);
      if (!exactMatch) {
        // Ambiguous (multiple similar amounts) -> hold for review
        continue;
      }
      candidates = [exactMatch];
    }

    // Pick the most recent candidate (or the only one after exact-match filter)
    const ledgerEntry = candidates[0];
    result.matchesFound += 1;

    // Mark detected (idempotent — only if still awaiting_payment)
    await query(
      `UPDATE payment_orders
       SET status = 'detected',
           detected_tx_hash = $1,
           detected_at = NOW(),
           binance_ledger_entry = $2::jsonb,
           updated_at = NOW()
       WHERE merchant_order_id = $3 AND status = 'awaiting_payment'`,
      [
        ledgerEntry.txId,
        JSON.stringify(ledgerEntry),
        order.merchant_order_id,
      ]
    );

    // Skip if this tx was already credited (duplicate tx_hash across orders)
    const dupCheck = await query(
      `SELECT id FROM payment_orders
       WHERE detected_tx_hash = $1 AND merchant_order_id != $2 AND status = 'paid'
       LIMIT 1`,
      [ledgerEntry.txId, order.merchant_order_id]
    );
    if (dupCheck.rows.length > 0) {
      await rejectOrder(order.merchant_order_id, `Duplicate tx_hash ${ledgerEntry.txId} already credited to another order`, {
        verdict: 'REJECT', confidence: 1.0, reason: 'Duplicate on-chain tx already credited',
      });
      result.rejected += 1;
      continue;
    }

    // Get user history for LLM context
    const userHistory = await getUserHistory(order.user_id);

    const scoringInput: ScoringInput = {
      order: {
        orderId: order.merchant_order_id,
        userId: order.user_id,
        expectedUsdt: order.amount_crypto,
        memo: order.qr_memo || '',   // empty for non-memo chains (TRC20)
        createdAt: new Date(order.created_at),
        expiresAt: new Date(order.expires_at),
      },
      observed: {
        txHash: ledgerEntry.txId,
        fromAddress: ledgerEntry.address,  // Binance Pay internal — not the actual sender
        toAddress: ledgerEntry.address,
        amount: parseFloat(ledgerEntry.amount),
        network: ledgerEntry.network,
        confirmations: ledgerEntry.unlockConfirm ?? 1,
        timestamp: new Date(ledgerEntry.insertTime),
      },
      ledger: {
        ledgerId: ledgerEntry.id,
        senderAddress: ledgerEntry.address,
        walletType: ledgerEntry.walletType,
        transferType: ledgerEntry.transferType,
      },
      userHistory,
      riskFlags: {
        ipCountry: 'unknown',   // TODO: enrich from req IP geolocation
        deviceFp: 'unknown',
        sanctionsHits: 0,       // TODO: OFAC SDN list check
        kycTier: userHistory.kycTier,
      },
    };

    // Get LLM verdict (with rule-based fallback if MiniMax fails)
    let llmVerdict: ScoringVerdict;
    let ruleVerdict: ScoringVerdict;
    try {
      [llmVerdict, ruleVerdict] = await Promise.all([
        scoreDepositWithLlm(scoringInput).catch((err) => ({
          verdict: 'MANUAL_HOLD' as const,
          confidence: 0,
          reason: `LLM unavailable: ${(err as Error).message}`,
        })),
        Promise.resolve(ruleBasedVerdict(scoringInput)),
      ]);
    } catch (err) {
      result.errors.push(`scoring order ${order.merchant_order_id}: ${(err as Error).message}`);
      continue;
    }

    // Disagreement gate: rule vs LLM → force MANUAL_HOLD regardless of confidence
    const disagreement = llmVerdict.verdict !== ruleVerdict.verdict;
    let finalVerdict: ScoringVerdict = disagreement
      ? { verdict: 'MANUAL_HOLD', confidence: Math.min(llmVerdict.confidence, ruleVerdict.confidence), reason: `LLM↔rule disagreement (LLM=${llmVerdict.verdict}, rule=${ruleVerdict.verdict}). LLM: ${llmVerdict.reason}. Rule: ${ruleVerdict.reason}` }
      : llmVerdict;

    // Amount-banded thresholds
    const amountUsd = order.amount_crypto;
    let autoCreditThreshold = 0.80;
    if (amountUsd > 500) autoCreditThreshold = 0.92;
    if (amountUsd > 2000) autoCreditThreshold = 999; // never auto-credit >$2k

    if (finalVerdict.verdict === 'AUTO_CREDIT' && finalVerdict.confidence >= autoCreditThreshold) {
      try {
        emitPaymentUpdate(order.user_id, {
          orderId: order.merchant_order_id,
          userId: order.user_id,
          status: 'detected',
          amountUsdt: order.amount_crypto,
          amountCoins: order.amount_coins,
          llmVerdict: finalVerdict.verdict,
          llmConfidence: finalVerdict.confidence,
          detectedTxHash: ledgerEntry.txId,
        });
        const ok = await creditOrder(order.merchant_order_id, order.amount_coins, order.user_id);
        if (ok) {
          await query(
            `UPDATE payment_orders
             SET llm_verdict = $1, llm_confidence = $2, llm_reason = $3,
                 llm_model_version = $4, llm_scored_at = NOW(),
                 rule_verdict = $5, rule_disagreement = $6,
                 updated_at = NOW()
             WHERE merchant_order_id = $7`,
            [llmVerdict.verdict, llmVerdict.confidence, llmVerdict.reason,
             'minimax-m3', ruleVerdict.verdict, disagreement, order.merchant_order_id]
          );
          result.autoCredited += 1;

          // Queue receipt email to the customer (silent if no email configured)
          try {
            const userRow = await query(
              `SELECT email, username FROM users WHERE id = $1`,
              [order.user_id]
            );
            if (userRow.rows.length > 0 && userRow.rows[0].email) {
              const usdEq = await coinsToCurrency(order.amount_crypto, 'USD');
              const bdtEq = await coinsToCurrency(order.amount_crypto, 'BDT');
              await queueEmail({
                recipient: userRow.rows[0].email,
                recipient_kind: 'user',
                user_id: order.user_id,
                event_type: 'deposit.credited',
                context: {
                  username: userRow.rows[0].username,
                  order_id: order.merchant_order_id,
                  chain: order.chain || 'BSC',
                  chain_full: order.chain || 'BNB Smart Chain',
                  amount_usdt: order.amount_crypto.toFixed(2),
                  amount_usd: usdEq.toFixed(2),
                  amount_bdt: bdtEq.toFixed(2),
                  tx_hash: ledgerEntry.txId || '',
                  confirmed_at: new Date().toISOString(),
                },
              });
            }
          } catch (_) {
            // email failure is non-critical
          }
        }
      } catch (err) {
        result.errors.push(`credit order ${order.merchant_order_id}: ${(err as Error).message}`);
      }
    } else if (finalVerdict.verdict === 'REJECT') {
      emitPaymentUpdate(order.user_id, {
        orderId: order.merchant_order_id,
        userId: order.user_id,
        status: 'failed',
        amountUsdt: order.amount_crypto,
        amountCoins: order.amount_coins,
        llmVerdict: finalVerdict.verdict,
        llmConfidence: finalVerdict.confidence,
        reason: finalVerdict.reason,
      });
      await rejectOrder(order.merchant_order_id, finalVerdict.reason, finalVerdict);
      result.rejected += 1;
    } else {
      await holdForReview(order.merchant_order_id, finalVerdict.reason, finalVerdict);
      await query(
        `UPDATE payment_orders
         SET llm_verdict = $1, llm_confidence = $2, llm_reason = $3,
             llm_model_version = $4, llm_scored_at = NOW(),
             rule_verdict = $5, rule_disagreement = $6,
             updated_at = NOW()
         WHERE merchant_order_id = $7`,
        [llmVerdict.verdict, llmVerdict.confidence, llmVerdict.reason,
         'minimax-m3', ruleVerdict.verdict, disagreement, order.merchant_order_id]
      );
      result.held += 1;
    }
  }

  return result;
}

// ── Background loop (start once at boot) ───────────────────────
let loopHandle: NodeJS.Timeout | null = null;

export function startLedgerMonitorLoop(): void {
  if (loopHandle) return;
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    console.warn('[binance-ledger-monitor] BINANCE_API_KEY/SECRET missing — loop NOT started');
    return;
  }
  console.log(`[binance-ledger-monitor] starting poll loop, interval=${POLL_INTERVAL_MS}ms`);
  let tickCount = 0;
  const tick = async () => {
    tickCount += 1;
    const start = Date.now();
    try {
      const r = await scanOnce();
      // Every ~5 minutes (20 ticks at 15s), expire stale orders + log run
      let expiredCount = 0;
      if (tickCount % 20 === 0) {
        try {
          const { expireStaleQrOrders } = await import('./binance-pay-qr.service');
          expiredCount = await expireStaleQrOrders();
          // Log reconciliation run
          await query(
            `INSERT INTO payment_reconciliation_log
              (gateway, checked_count, confirmed_count, failed_count, expired_count, errors, duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
              'binance_pay_qr',
              r.scannedOrders,
              r.autoCredited,
              r.rejected,
              expiredCount,
              JSON.stringify(r.errors),
              Date.now() - start,
            ]
          );
        } catch (e) {
          console.error('[binance-ledger-monitor] expire/log error:', e);
        }
      }
      if (r.scannedOrders > 0 || r.errors.length > 0 || expiredCount > 0) {
        console.log(`[binance-ledger-monitor] tick=${tickCount} scanned=${r.scannedOrders} ledger=${r.ledgerEntriesChecked} matches=${r.matchesFound} credited=${r.autoCredited} held=${r.held} rejected=${r.rejected} expired=${expiredCount} errors=${r.errors.length}`);
      }
    } catch (err) {
      console.error('[binance-ledger-monitor] tick error:', err);
    }
  };
  // Initial tick after 5s (let server boot fully), then every POLL_INTERVAL_MS
  setTimeout(tick, 5000);
  loopHandle = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopLedgerMonitorLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
    console.log('[binance-ledger-monitor] loop stopped');
  }
}
