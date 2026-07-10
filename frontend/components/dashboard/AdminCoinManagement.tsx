'use client';

import { useState, useEffect } from 'react';
import { Coins, Check, Clock, AlertCircle, RefreshCw, Loader2, TrendingUp, RotateCcw } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';

interface Deposit {
  id: string;
  userId: string;
  toAddress: string;
  cryptoAmount: string;
  fiatEquivalent: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

interface Rate {
  id: string;
  currencyPair: string;
  customRate: string;
  isPlatformDefault: boolean;
  validFrom: string;
}

export default function AdminCoinManagement() {
  const { addToast } = useToast();
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [pair, setPair] = useState('USDT_BDT');
  const [customRate, setCustomRate] = useState('');
  const [buySpread, setBuySpread] = useState('0.01');
  const [sellSpread, setSellSpread] = useState('0.01');
  const [justification, setJustification] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [dRes, rRes] = await Promise.all([
        fetch('/api/admin/deposits/queue'),
        fetch('/api/admin/rates'),
      ]);
      const dData = await dRes.json();
      const rData = await rRes.json();
      if (dData.success) setDeposits(dData.data || []);
      if (rData.success) setRates(rData.data || []);
    } catch (err) {
      addToast('Failed to load coin data', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [addToast]);

  const forceComplete = async (id: string) => {
    setActionId(id);
    try {
      const res = await fetch(`/api/admin/deposits/${id}/force-complete`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        addToast('Deposit force-completed', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Failed', 'error');
      }
    } catch (err) {
      addToast('Network error', 'error');
    } finally {
      setActionId(null);
    }
  };

  const expireOld = async () => {
    setActionId('expire');
    try {
      const res = await fetch('/api/admin/deposits/expire-old', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        addToast('Expired old deposits', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Failed', 'error');
      }
    } catch (err) {
      addToast('Network error', 'error');
    } finally {
      setActionId(null);
    }
  };

  const setRate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customRate || !justification) {
      addToast('Rate and justification required', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/rates/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, customRate: Number(customRate), buySpread: Number(buySpread), sellSpread: Number(sellSpread), justification }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('Custom rate set', 'success');
        setCustomRate('');
        setJustification('');
        fetchData();
      } else {
        addToast(data.error || 'Failed', 'error');
      }
    } catch (err) {
      addToast('Network error', 'error');
    }
  };

  const revertRate = async (p: string) => {
    try {
      const res = await fetch('/api/admin/rates/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair: p, justification: 'Admin revert from dashboard' }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('Rate reverted to market', 'success');
        fetchData();
      } else {
        addToast(data.error || 'Failed', 'error');
      }
    } catch (err) {
      addToast('Network error', 'error');
    }
  };

  return (
    <div className="space-y-5">
      {/* Custom Rate Card */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-brand-maroon/10 flex items-center justify-center text-brand-maroon">
            <TrendingUp size={20} />
          </div>
          <div>
            <h3 className="heading-display text-sm">Custom Exchange Rate</h3>
            <p className="text-text-muted text-xs font-mono">Override the market rate for deposits/withdrawals.</p>
          </div>
        </div>

        <form onSubmit={setRate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="text-xs font-mono text-text-muted">Pair</label>
            <select className="input-cyber w-full" value={pair} onChange={(e) => setPair(e.target.value)}>
              <option value="USDT_BDT">USDT / BDT</option>
              <option value="USDT_USD">USDT / USD</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-mono text-text-muted">Custom Rate</label>
            <input className="input-cyber w-full" type="number" step="0.000001" value={customRate} onChange={(e) => setCustomRate(e.target.value)} placeholder="e.g. 120" />
          </div>
          <div>
            <label className="text-xs font-mono text-text-muted">Buy Spread (%)</label>
            <input className="input-cyber w-full" type="number" step="0.001" value={buySpread} onChange={(e) => setBuySpread(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-mono text-text-muted">Sell Spread (%)</label>
            <input className="input-cyber w-full" type="number" step="0.001" value={sellSpread} onChange={(e) => setSellSpread(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-mono text-text-muted">Justification</label>
            <input className="input-cyber w-full" value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Why is this override needed?" />
          </div>
          <div className="md:col-span-2">
            <button type="submit" className="btn-brand w-full md:w-auto">Set Custom Rate</button>
          </div>
        </form>

        {rates.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-mono text-text-muted mb-2">Active Overrides</h4>
            <div className="space-y-2">
              {rates.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div className="text-xs font-mono">
                    <span className="text-text-primary">{r.currencyPair}</span> · rate {r.customRate} · {r.isPlatformDefault ? 'platform default' : 'custom'}
                  </div>
                  <button onClick={() => revertRate(r.currencyPair)} className="text-brand-red text-xs font-mono hover:underline">
                    <RotateCcw size={12} className="inline mr-1" />Revert
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Deposit Queue Card */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-green/10 flex items-center justify-center text-brand-green">
              <Coins size={20} />
            </div>
            <div>
              <h3 className="heading-display text-sm">Deposit Queue</h3>
              <p className="text-text-muted text-xs font-mono">Pending and in-progress deposits.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={fetchData} className="px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary text-xs font-mono">
              <RefreshCw size={12} className="inline mr-1" />Refresh
            </button>
            <button onClick={expireOld} disabled={actionId === 'expire'} className="px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary text-xs font-mono disabled:opacity-50">
              {actionId === 'expire' ? <Loader2 size={12} className="inline animate-spin" /> : <Clock size={12} className="inline mr-1" />}
              Expire Old
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 size={20} className="animate-spin text-brand-maroon" />
          </div>
        ) : deposits.length === 0 ? (
          <div className="text-center text-text-muted text-xs font-mono p-6">
            <AlertCircle size={20} className="mx-auto mb-2 opacity-50" />
            No pending deposits.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="text-left py-2 px-2">Address</th>
                  <th className="text-right py-2 px-2">Amount</th>
                  <th className="text-right py-2 px-2">Fiat</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-right py-2 px-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => (
                  <tr key={d.id} className="border-b border-border/50">
                    <td className="py-2 px-2 truncate max-w-[140px]" title={d.toAddress}>{d.toAddress}</td>
                    <td className="py-2 px-2 text-right">{d.cryptoAmount} USDT</td>
                    <td className="py-2 px-2 text-right">${d.fiatEquivalent}</td>
                    <td className="py-2 px-2"><span className="px-2 py-0.5 rounded bg-brand-gold/10 text-brand-gold">{d.status}</span></td>
                    <td className="py-2 px-2 text-right">
                      <button
                        onClick={() => forceComplete(d.id)}
                        disabled={actionId === d.id}
                        className="px-2 py-1 rounded border border-brand-green/40 text-brand-green hover:bg-brand-green/10 disabled:opacity-50"
                      >
                        {actionId === d.id ? <Loader2 size={12} className="inline animate-spin" /> : <Check size={12} className="inline mr-1" />}
                        Complete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
