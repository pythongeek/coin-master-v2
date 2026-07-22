'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN HEALTH DASHBOARD — /api/admin/health
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { Activity, Database, Server, Link2, RefreshCw, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { getApiBase } from '@/lib/api/base';


const API = getApiBase();

interface HealthCheck {
  status: 'ok' | 'err';
  latencyMs: number;
  message?: string;
  blockHeight?: number;
}

interface HealthData {
  success: boolean;
  status: 'ok' | 'degraded';
  timestamp: string;
  latencyMs: number;
  checks: {
    postgres: HealthCheck;
    redis: HealthCheck;
    blockchain: HealthCheck;
  };
}

const statusBadge = (status: 'ok' | 'err') =>
  status === 'ok'
    ? 'bg-brand-green/15 text-brand-green'
    : 'bg-brand-red/15 text-brand-red';

export default function AdminHealthDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setHealth(data);
      } else {
        setError(data.error || 'Failed to load health');
      }
    } catch (e) {
      setError('Cannot connect to backend');
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, 30000);
    return () => clearInterval(id);
  }, [fetchHealth]);

  const checks = health ? [
    { key: 'Postgres', icon: Database, check: health.checks.postgres },
    { key: 'Redis', icon: Server, check: health.checks.redis },
    { key: 'Blockchain RPC', icon: Link2, check: health.checks.blockchain },
  ] : [];

  return (
    <div className="glass-card overflow-hidden p-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-brand-maroon" />
          <h3 className="heading-display text-sm text-text-primary">System Health</h3>
        </div>
        <button onClick={fetchHealth} className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {loading && !health && (
        <div className="py-8 text-center text-text-muted">
          <Loader2 size={16} className="animate-spin inline mr-2" /> Loading...
        </div>
      )}

      {error && (
        <div className="py-4 text-center text-brand-red text-sm">{error}</div>
      )}

      {health && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-muted">Overall:</span>
            <span className={`px-2 py-0.5 rounded text-xs font-mono ${health.status === 'ok' ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-red/15 text-brand-red'}`}>
              {health.status.toUpperCase()}
            </span>
            <span className="text-text-muted text-xs">(refreshed {new Date(health.timestamp).toLocaleTimeString()})</span>
          </div>

          <div className="grid gap-3">
            {checks.map(({ key, icon: Icon, check }) => (
              <div key={key} className="flex items-center justify-between p-3 rounded border border-border bg-black/20">
                <div className="flex items-center gap-3">
                  <Icon size={16} className={check.status === 'ok' ? 'text-brand-green' : 'text-brand-red'} />
                  <div>
                    <div className="text-sm text-text-primary">{key}</div>
                    {check.message && (
                      <div className="text-[10px] text-text-muted">{check.message}</div>
                    )}
                    {check.blockHeight !== undefined && (
                      <div className="text-[10px] text-text-muted">Block height: {check.blockHeight}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">{check.latencyMs}ms</span>
                  {check.status === 'ok' ? <CheckCircle size={14} className="text-brand-green" /> : <XCircle size={14} className="text-brand-red" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
