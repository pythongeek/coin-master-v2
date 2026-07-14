/**
 * =============================================================
 *  PUBLIC FX RATES - rates anyone can read without auth
 * =============================================================
 *
 *  Two endpoints:
 *    GET /api/public/fx-rates           - all current rates + freshness
 *    GET /api/public/fx-convert?amount=X&from=USDT&to=BDT
 *                                       - ad-hoc conversion using current rates
 *
 *  No auth required because:
 *    - Rates are public info (Binance P2P is public)
 *    - Read-only, no money moves
 *    - Frontend shows equivalents on deposit page (logged in OR logged out)
 *
 *  Sources (in priority order):
 *    1. DB cache (rate_cache) - valid for 5 minutes
 *    2. Live Binance P2P fetch (5-second timeout)
 *    3. Hardcoded fallback (1 USDT = 1 USD = 120 BDT)
 */

import { Router, Request, Response } from 'express';
import {
  getAllCoinRates,
  coinsToCurrency,
  type SupportedCurrency,
} from '../services/rate-fetcher';

const router = Router();

function parseCurrency(s: unknown): SupportedCurrency | null {
  const v = String(s || '').toUpperCase();
  if (v === 'BDT' || v === 'USDT' || v === 'USD') return v;
  return null;
}

// =============================================================
//  GET /api/public/fx-rates
//  Returns current rates + freshness + source
// =============================================================
router.get('/fx-rates', async (_req: Request, res: Response) => {
  try {
    const rates = await getAllCoinRates();
    // Look up freshness from rate_cache so we can show when it was fetched
    const { query } = await import('../config/database');
    const cache = await query(
      `SELECT quote, rate::float8 AS rate, source, fetched_at, expires_at
       FROM rate_cache
       WHERE expires_at > NOW() - INTERVAL '1 hour'
       ORDER BY fetched_at DESC
       LIMIT 6`
    );
    const byQuote = new Map<string, any>();
    for (const row of cache.rows as any[]) {
      if (!byQuote.has(row.quote)) byQuote.set(row.quote, row);
    }
    const freshest = (cache.rows[0] as any) ?? null;

    res.json({
      success: true,
      base: 'USDT',
      rates: {
        USDT: parseFloat(rates.USDT.toFixed(8)),
        USD: parseFloat(rates.USD.toFixed(8)),
        BDT: parseFloat(rates.BDT.toFixed(2)),
      },
      freshness: freshest
        ? {
            fetchedAt: freshest.fetched_at,
            source: freshest.source,
            ageSec: Math.floor((Date.now() - new Date(freshest.fetched_at).getTime()) / 1000),
            expiresAt: freshest.expires_at,
          }
        : { source: 'fallback', ageSec: null, expiresAt: null },
      perQuote: Object.fromEntries(
        Array.from(byQuote.entries()).map(([q, r]: [string, any]) => [
          q,
          {
            rate: parseFloat(r.rate),
            source: r.source,
            fetchedAt: r.fetched_at,
            ageSec: Math.floor((Date.now() - new Date(r.fetched_at).getTime()) / 1000),
          },
        ])
      ),
      note: 'Rates sourced from Binance P2P. 1 Coin = 1 USDT (internal peg). Refreshed every 5 min.',
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================
//  GET /api/public/fx-convert?amount=50&from=USDT&to=BDT
//  Convert Coin amount to/from USDT, USD, BDT
// =============================================================
router.get('/fx-convert', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(String(req.query.amount || '0'));
    if (!isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, error: 'amount must be a non-negative number' });
    }
    const from = parseCurrency(req.query.from);
    const to = parseCurrency(req.query.to);
    if (!from) {
      return res.status(400).json({ success: false, error: 'from must be USDT|USD|BDT' });
    }
    if (!to) {
      return res.status(400).json({ success: false, error: 'to must be USDT|USD|BDT' });
    }
    if (from === to) {
      return res.json({ success: true, input: amount, from, to, output: amount, rate: 1 });
    }
    const rates = await getAllCoinRates();
    const fromRate = rates[from];
    const toRate = rates[to];
    // rates[from] = how many `from` units per 1 Coin/USDT
    // To convert: first convert to USDT (divide by fromRate), then convert to target (multiply by toRate)
    // Note: rates['USDT'] = 1 by convention
    const inUsdt = amount / fromRate;
    const output = inUsdt * toRate;
    // rate display = how many `to` units per 1 `from` unit
    const displayRate = toRate / fromRate;
    const displayPrecision = to === 'BDT' ? 2 : 4;
    res.json({
      success: true,
      input: amount,
      from,
      to,
      output: parseFloat(output.toFixed(displayPrecision)),
      rate: parseFloat((toRate / fromRate).toFixed(displayPrecision)),
      note: '1 Coin = 1 USDT. Conversion via current market rate.',
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

export default router;
