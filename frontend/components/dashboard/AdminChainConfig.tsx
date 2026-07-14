'use client';
/**
 * =============================================================
 *  ADMIN CHAIN CONFIG - edit deposit chains (address, fees, etc)
 * =============================================================
 *
 *  Lets super_admin manage deposit_chain_config without psql.
 *  - Enable/disable a chain
 *  - Update deposit address (BSC 0x... / TRX T... / ETH 0x...)
 *  - Adjust fees, confirmations, estimated detection time
 *  - View notes
 *
 *  All updates invalidate the chain cache so /wallet/deposit picks them up.
 */

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, XCircle, Loader2, AlertCircle, Save, RefreshCw, ExternalLink } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface ChainRow {
  id: string;
  chain_key: string;
  display_name: string;
  network_code: string;
  token_symbol: string;
  deposit_address: string;
  memo_supported: boolean;
  min_confirmations: number;
  estimated_seconds: number;
  avg_fee_usdt: number;
  is_enabled: boolean;
  display_order: number;
  notes: string | null;
  updated_at?: string;
}

function isValidAddress(addr: string, networkCode: string): { ok: boolean; error?: string } {
  const trimmed = addr.trim();
  if (!trimmed) return { ok: false, error: 'Address required' };
  const evm = ['BSC', 'ETH', 'ARBITRUM', 'POLYGON'];
  if (evm.includes(networkCode)) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return { ok: false, error: 'Must be 0x-prefixed 40-hex EVM address' };
  } else if (networkCode === 'TRX') {
    if (!/^T[a-zA-Z0-9]{33}$/.test(trimmed)) return { ok: false, error: 'Must be T-prefixed 34-char TRON address' };
  }
  return { ok: true };
}

export default function AdminChainConfig() {
  const [chains, setChains] = useState<ChainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [successKey, setSuccessKey] = useState<string | null>(null);
  // Edit state per chain
  const [edits, setEdits] = useState<Record<string, Partial<ChainRow>>>({});
  const [addressValid, setAddressValid] = useState<Record<string, { ok: boolean; error?: string }>>({});

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/chains`, { headers });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setChains(json.chains);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function setEdit(chainKey: string, field: keyof ChainRow, value: unknown) {
    setEdits((prev) => ({ ...prev, [chainKey]: { ...prev[chainKey], [field]: value } }));
    if (field === 'deposit_address' || field === 'network_code') {
      const chain = chains.find((c) => c.chain_key === chainKey);
      const addr = field === 'deposit_address' ? String(value) : chain?.deposit_address || '';
      const net = field === 'network_code' ? String(value) : chain?.network_code || '';
      const valid = isValidAddress(addr, net);
      setAddressValid((prev) => ({ ...prev, [chainKey]: valid }));
    }
  }

  function dirty(chain: ChainRow): Partial<ChainRow> {
    const edit = edits[chain.chain_key] || {};
    const result: Partial<ChainRow> = {};
    for (const k of Object.keys(edit)) {
      const typedK = k as keyof ChainRow;
      if (edit[typedK] !== chain[typedK]) {
        (result as Record<string, unknown>)[typedK] = edit[typedK];
      }
    }
    return result;
  }

  async function save(chain: ChainRow) {
    const changes = dirty(chain);
    if (Object.keys(changes).length === 0) return;

    // Client-side validation
    if (changes.deposit_address !== undefined) {
      const v = isValidAddress(String(changes.deposit_address), chain.network_code);
      if (!v.ok) {
        setError(`${chain.chain_key}: ${v.error}`);
        return;
      }
      // Normalize the address before sending
      changes.deposit_address = String(changes.deposit_address).trim();
    }

    setSavingKey(chain.chain_key);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/chains/${chain.chain_key}/config`, {
        method: 'POST',
        headers,
        body: JSON.stringify(changes),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setSuccessKey(chain.chain_key);
      setTimeout(() => setSuccessKey(null), 2000);
      // Clear edits for this chain
      setEdits((prev) => {
        const next = { ...prev };
        delete next[chain.chain_key];
        return next;
      });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  async function toggleEnabled(chain: ChainRow) {
    setSavingKey(chain.chain_key);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/payments/chains/${chain.chain_key}/toggle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ isEnabled: !chain.is_enabled }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  }

  if (loading && chains.length === 0) {
    return <p className="text-sm text-text-muted font-mono">Loading chains...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-mono text-text-primary">Deposit Chains</h2>
          <p className="text-xs text-text-muted font-mono mt-1">
            Configure which blockchain networks customers can deposit on. Each chain has its own address, fees, and confirmation requirements.
          </p>
        </div>
        <button type="button" onClick={load} className="p-2 rounded hover:bg-bg-elevated" aria-label="Refresh">
          <RefreshCw size={16} className={`text-text-muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
          <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-300 text-sm">{error}</span>
        </div>
      )}

      <div className="space-y-3">
        {chains.map((chain) => {
          const edit = edits[chain.chain_key] || {};
          const changes = dirty(chain);
          const hasChanges = Object.keys(changes).length > 0;
          const addrValid = addressValid[chain.chain_key] || { ok: true };
          const currentAddr = (edit.deposit_address ?? chain.deposit_address) as string;
          const validNow = currentAddr === chain.deposit_address ? { ok: true } : isValidAddress(currentAddr, chain.network_code);
          const isSaving = savingKey === chain.chain_key;
          const justSaved = successKey === chain.chain_key;

          return (
            <div key={chain.id} className="glass-card p-4 rounded-xl">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base text-text-primary font-bold">
                    {chain.display_name}
                  </span>
                  <span className="text-xs text-text-muted font-mono">({chain.network_code})</span>
                  {chain.memo_supported ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">memo</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">no memo</span>
                  )}
                  {chain.is_enabled ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-mono">enabled</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400 font-mono">disabled</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleEnabled(chain)}
                  disabled={isSaving}
                  className={`text-xs px-3 py-1 rounded font-mono ${
                    chain.is_enabled
                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                      : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                  } disabled:opacity-50`}
                >
                  {chain.is_enabled ? 'Disable' : 'Enable'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs text-text-muted font-mono mb-1">Deposit address</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={currentAddr}
                      onChange={(e) => setEdit(chain.chain_key, 'deposit_address', e.target.value)}
                      placeholder={chain.network_code === 'TRX' ? 'T...' : '0x...'}
                      className={`flex-1 px-3 py-2 bg-bg-elevated border rounded font-mono text-xs text-text-primary focus:outline-none ${
                        validNow.ok ? 'border-border-default focus:border-brand-green' : 'border-red-500/50'
                      }`}
                    />
                    {chain.deposit_address && (
                      <a
                        href={chain.network_code === 'TRX'
                          ? `https://tronscan.org/#/address/${chain.deposit_address}`
                          : `https://bscscan.com/address/${chain.deposit_address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded hover:bg-bg-elevated text-text-muted"
                        title="View on explorer"
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                  {!validNow.ok && (
                    <p className="text-xs text-red-400 font-mono mt-1">{validNow.error}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Display name</label>
                  <input
                    type="text"
                    value={(edit.display_name ?? chain.display_name) as string}
                    onChange={(e) => setEdit(chain.chain_key, 'display_name', e.target.value)}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Network code (Binance ledger)</label>
                  <select
                    value={(edit.network_code ?? chain.network_code) as string}
                    onChange={(e) => setEdit(chain.chain_key, 'network_code', e.target.value)}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  >
                    <option value="BSC">BSC (BEP20)</option>
                    <option value="ETH">ETH (ERC20)</option>
                    <option value="ARBITRUM">ARBITRUM</option>
                    <option value="POLYGON">POLYGON</option>
                    <option value="TRX">TRX (TRC20)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Token symbol</label>
                  <input
                    type="text"
                    value={(edit.token_symbol ?? chain.token_symbol) as string}
                    onChange={(e) => setEdit(chain.chain_key, 'token_symbol', e.target.value)}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Min confirmations</label>
                  <input
                    type="number"
                    min={1}
                    value={(edit.min_confirmations ?? chain.min_confirmations) as number}
                    onChange={(e) => setEdit(chain.chain_key, 'min_confirmations', parseInt(e.target.value, 10))}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Estimated detection (seconds)</label>
                  <input
                    type="number"
                    min={1}
                    value={(edit.estimated_seconds ?? chain.estimated_seconds) as number}
                    onChange={(e) => setEdit(chain.chain_key, 'estimated_seconds', parseInt(e.target.value, 10))}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>

                <div>
                  <label className="block text-xs text-text-muted font-mono mb-1">Avg network fee (USDT)</label>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={(edit.avg_fee_usdt ?? chain.avg_fee_usdt) as number}
                    onChange={(e) => setEdit(chain.chain_key, 'avg_fee_usdt', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs text-text-muted font-mono mb-1">
                    <input
                      type="checkbox"
                      checked={(edit.memo_supported ?? chain.memo_supported) as boolean}
                      onChange={(e) => setEdit(chain.chain_key, 'memo_supported', e.target.checked)}
                      className="mr-2"
                    />
                    Memo-tag supported (chain has tag field for per-order matching)
                  </label>
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs text-text-muted font-mono mb-1">Notes (shown to admin)</label>
                  <input
                    type="text"
                    value={(edit.notes ?? chain.notes ?? '') as string}
                    onChange={(e) => setEdit(chain.chain_key, 'notes', e.target.value)}
                    placeholder="e.g. Tether contract on BSC"
                    className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary focus:outline-none focus:border-brand-green"
                  />
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                {justSaved && (
                  <span className="text-xs text-green-400 font-mono flex items-center gap-1">
                    <CheckCircle2 size={12} /> Saved
                  </span>
                )}
                {hasChanges && (
                  <button
                    type="button"
                    onClick={() => setEdits((prev) => {
                      const next = { ...prev };
                      delete next[chain.chain_key];
                      return next;
                    })}
                    className="text-xs px-3 py-1 rounded text-text-muted hover:text-text-primary font-mono"
                  >
                    Discard
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => save(chain)}
                  disabled={!hasChanges || !validNow.ok || isSaving}
                  className="text-xs px-3 py-1 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 font-mono flex items-center gap-1 disabled:opacity-30"
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Saving...
                    </>
                  ) : (
                    <>
                      <Save size={12} /> Save changes
                    </>
                  )}
                </button>
              </div>

              {chain.updated_at && (
                <p className="text-xs text-text-muted font-mono mt-2">
                  Last updated: {new Date(chain.updated_at).toLocaleString()}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}