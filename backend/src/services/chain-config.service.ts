/**
 * =============================================================
 *  CHAIN CONFIG - per-chain deposit address + memo support
 * =============================================================
 *
 *  Single source of truth for which chains the deposit flow
 *  supports and their per-chain config (address, memo, fees).
 *
 *  Source-of-truth order:
 *    1. DB table `deposit_chain_config` (admin-editable at runtime)
 *    2. Env vars BINANCE_DEPOSIT_<KEY>_ADDRESS etc.
 *    3. Built-in defaults (BSC only)
 *
 *  Why the runtime DB row exists:
 *    - Operator can toggle chains on/off without redeploying backend
 *    - The /wallet/deposit UI reads via /api/admin/payments/chains
 *    - The /wallet/deposit/initiate endpoint reads at order-create time
 *
 *  Why env vars are fallback:
 *    - Allow fleet-wide defaults (e.g., shared deposit address across envs)
 *    - Cold start works without DB seed
 * =============================================================
 */

import { query } from '../config/database';

export interface ChainConfig {
  chainKey: string;             // 'BSC', 'TRC20', 'ERC20'
  displayName: string;          // 'BNB Smart Chain (BEP20)'
  networkCode: string;          // matches Binance Spot ledger network string
  tokenSymbol: string;          // 'USDT'
  depositAddress: string;       // '0x...' or 'T...'
  memoSupported: boolean;        // true for BSC BEP20, false for TRC20 USDT
  minConfirmations: number;     // EVM=12, Tron=19, BSC=12, ERC20=12
  estimatedSeconds: number;     // for UI display: how long until detection
  avgFeeUsdt: number;           // for UI display: how much customer pays in network fee
  isEnabled: boolean;
  displayOrder: number;
  notes: string | null;
}

// ── Env-only fallback registry (only used if DB has no rows yet) ─────
function envOnlyChain(key: string): ChainConfig | null {
  const address = (process.env[`BINANCE_DEPOSIT_${key}_ADDRESS`] || '').trim();
  if (!address) return null;
  return {
    chainKey: key,
    displayName: process.env[`BINANCE_DEPOSIT_${key}_DISPLAY_NAME`] || key,
    networkCode: process.env[`BINANCE_DEPOSIT_${key}_NETWORK`] || key,
    tokenSymbol: process.env[`BINANCE_DEPOSIT_${key}_TOKEN`] || 'USDT',
    depositAddress: address,
    memoSupported: (process.env[`BINANCE_DEPOSIT_${key}_MEMO_SUPPORTED`] || 'true').toLowerCase() === 'true',
    minConfirmations: parseInt(process.env[`BINANCE_DEPOSIT_${key}_MIN_CONFIRMATIONS`] || '12', 10),
    estimatedSeconds: parseInt(process.env[`BINANCE_DEPOSIT_${key}_ESTIMATED_SECONDS`] || '60', 10),
    avgFeeUsdt: parseFloat(process.env[`BINANCE_DEPOSIT_${key}_AVG_FEE_USDT`] || '0'),
    isEnabled: (process.env[`BINANCE_DEPOSIT_${key}_ENABLED`] || 'true').toLowerCase() === 'true',
    displayOrder: parseInt(process.env[`BINANCE_DEPOSIT_${key}_DISPLAY_ORDER`] || '100', 10),
    notes: process.env[`BINANCE_DEPOSIT_${key}_NOTES`] || null,
  };
}

// ── Cache (5-min TTL) so we don't hammer DB on every order ──────────────
let cache: { chains: ChainConfig[]; byKey: Record<string, ChainConfig>; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function loadChainConfigs(): Promise<ChainConfig[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.chains;
  }
  let chains: ChainConfig[] = [];
  try {
    const r = await query(
      `SELECT chain_key, display_name, network_code, token_symbol, deposit_address,
              memo_supported, min_confirmations, estimated_seconds, avg_fee_usdt::float8 AS avg_fee_usdt,
              is_enabled, display_order, notes
       FROM deposit_chain_config
       ORDER BY display_order ASC, chain_key ASC`
    );
    chains = r.rows.map((row: any) => ({
      chainKey: row.chain_key,
      displayName: row.display_name,
      networkCode: row.network_code,
      tokenSymbol: row.token_symbol,
      depositAddress: row.deposit_address,
      memoSupported: row.memo_supported,
      minConfirmations: row.min_confirmations,
      estimatedSeconds: row.estimated_seconds,
      avgFeeUsdt: row.avg_fee_usdt,
      isEnabled: row.is_enabled,
      displayOrder: row.display_order,
      notes: row.notes,
    }));
  } catch (err) {
    console.warn('[chain-config] DB read failed, falling back to env:', (err as Error).message);
  }

  // If DB had no rows, build from env (legacy single-chain compatibility)
  if (chains.length === 0) {
    for (const key of ['BSC', 'TRC20', 'ERC20']) {
      const c = envOnlyChain(key);
      if (c) chains.push(c);
    }
  }

  // Filter to enabled only
  chains = chains.filter((c) => c.isEnabled && c.depositAddress);

  const byKey: Record<string, ChainConfig> = {};
  for (const c of chains) byKey[c.chainKey] = c;

  cache = { chains, byKey, loadedAt: Date.now() };
  return chains;
}

export async function getChainByKey(key: string): Promise<ChainConfig | null> {
  await loadChainConfigs();
  return cache?.byKey[key] || null;
}

export function invalidateChainCache(): void {
  cache = null;
}
