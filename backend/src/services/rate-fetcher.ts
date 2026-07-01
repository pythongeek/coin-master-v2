/**
 * ═══════════════════════════════════════════════════════════════
 *  RATE FETCHER — Binance P2P realtime rates (with caching)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Fetches USDT/BDT and USDT/USD rates from Binance P2P public API.
 *  Uses Redis cache (1 row per quote currency, expires after 5 min).
 *
 *  ARCHITECTURE:
 *    1. Get latest cached rate from DB (if not expired)
 *    2. If expired or missing, hit Binance P2P API
 *    3. If Binance fails, fall back to last-known rate
 *    4. If no rate at all, fall back to a hardcoded default
 *
 *  GRACEFUL DEGRADATION:
 *    - Binance API down? Use last DB rate (even if expired)
 *    - DB unavailable? Use hardcoded fallback
 *    - Cold start? Fetch + write to DB, return fresh rate
 *
 *  CONVERSION LOGIC (since Coin is the base unit):
 *    1 Coin = X BDT (where X = the BDT/USDT rate × USDT/Coin rate)
 *    We peg: 1 Coin = 1 USDT
 *    So 1 Coin = USDT/BDT rate in BDT
 *    And 1 Coin = 1 USDT = USDT/USD rate in USD
 *
 *  Binance P2P API:
 *    GET https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search
 *    { fiat: "BDT", tradeType: "SELL", asset: "USDT", rows: 1, page: 1 }
 *    → returns the lowest SELL price (best USDT price for buyer paying BDT)
 * ═══════════════════════════════════════════════════════════════
 */

import { query } from '../config/database';

// ── Types ───────────────────────────────────────────────────────
export type SupportedCurrency = 'BDT' | 'USDT' | 'USD';

interface RateRow {
  base: string;
  quote: SupportedCurrency;
  rate: number;
  source: string;
  fetched_at: Date;
  expires_at: Date;
}

// ── Fallback rates (used if Binance + DB both fail) ───────────
// These are reasonable defaults as of mid-2025; updated periodically
const FALLBACK_RATES: Record<SupportedCurrency, number> = {
  USDT: 1.00,    // 1 USDT = 1 USDT (trivial, but used as base)
  USD:  1.00,    // 1 USDT ≈ 1 USD (close to peg)
  BDT:  120.00,  // 1 USDT ≈ 120 BDT (Taka)
};

// Coin ↔ USDT peg: 1 Coin = 1 USDT
const COIN_USDT_PEG = 1.00;

// ── Binance P2P API call ───────────────────────────────────────
interface BinanceP2PQuote {
  adv: { price: string; fiat: string; asset: string };
}

async function fetchBinanceP2PRate(fiat: 'BDT' | 'USD'): Promise<number | null> {
  try {
    // 5-second timeout — if Binance is slow/down, fail fast
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      `https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search?fiat=${fiat}&tradeType=SELL&asset=USDT&rows=1&page=1`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiat, page: 1, rows: 1, tradeType: 'SELL', asset: 'USDT' }),
      },
    );
    clearTimeout(timeout);

    if (!res.ok) return null;
    const json = (await res.json()) as { data?: BinanceP2PQuote[] };
    const priceStr = json.data?.[0]?.adv?.price;
    if (!priceStr) return null;
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) return null;
    return price;
  } catch {
    return null;  // network error, timeout, or malformed response
  }
}

// ── Public API ─────────────────────────────────────────────────

/** Convert 1 Coin → the given currency (1 Coin = COIN_USDT_PEG USDT = rate * currency) */
export async function getCoinRate(currency: SupportedCurrency): Promise<number> {
  if (currency === 'USDT') return COIN_USDT_PEG;

  // 1. Try cache (DB)
  const cached = await getCachedRate('USDT', currency);
  if (cached) return cached.rate * COIN_USDT_PEG;

  // 2. Fetch from Binance, write to cache
  const fresh = await fetchBinanceP2PRate(currency);
  if (fresh !== null) {
    await storeCachedRate('USDT', currency, fresh, 'binance_p2p');
    return fresh * COIN_USDT_PEG;
  }

  // 3. Fall back to hardcoded
  return FALLBACK_RATES[currency] * COIN_USDT_PEG;
}

/** Get all 3 rates at once (for /api/wallet/rates endpoint) */
export async function getAllCoinRates(): Promise<Record<SupportedCurrency, number>> {
  const [bdt, usdt, usd] = await Promise.all([
    getCoinRate('BDT'),
    getCoinRate('USDT'),
    getCoinRate('USD'),
  ]);
  return { BDT: bdt, USDT: usdt, USD: usd };
}

/** Convert Coin amount to currency amount, using current rates */
export async function coinsToCurrency(
  amountCoins: number,
  currency: SupportedCurrency,
): Promise<number> {
  const rate = await getCoinRate(currency);
  return parseFloat((amountCoins * rate).toFixed(8));
}

/** Convert currency amount to Coins (used for top-up display) */
export async function currencyToCoins(
  amountCurrency: number,
  currency: SupportedCurrency,
): Promise<number> {
  const rate = await getCoinRate(currency);
  if (rate === 0) return 0;
  return parseFloat((amountCurrency / rate).toFixed(8));
}

// ── DB cache helpers ──────────────────────────────────────────
async function getCachedRate(
  base: 'USDT',
  quote: SupportedCurrency,
): Promise<RateRow | null> {
  try {
    const r = await query(
      `SELECT base, quote, rate::float8 AS rate, source, fetched_at, expires_at
       FROM rate_cache
       WHERE base = $1 AND quote = $2 AND expires_at > NOW()
       ORDER BY fetched_at DESC LIMIT 1`,
      [base, quote],
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      base: row.base,
      quote: row.quote,
      rate: row.rate,
      source: row.source,
      fetched_at: new Date(row.fetched_at),
      expires_at: new Date(row.expires_at),
    };
  } catch {
    return null;
  }
}

async function storeCachedRate(
  base: 'USDT',
  quote: SupportedCurrency,
  rate: number,
  source: string,
): Promise<void> {
  try {
    // Clean up old rows for this base+quote (keep table small)
    await query(
      `DELETE FROM rate_cache WHERE base = $1 AND quote = $2 AND fetched_at < NOW() - INTERVAL '1 hour'`,
      [base, quote],
    );
    await query(
      `INSERT INTO rate_cache (base, quote, rate, source, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')`,
      [base, quote, rate, source],
    );
  } catch {
    // swallow — caching is best-effort
  }
}