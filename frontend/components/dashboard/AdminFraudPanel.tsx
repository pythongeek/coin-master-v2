'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN FRAUD PANEL — Phase 1.7
 * ═══════════════════════════════════════════════════════════════
 *  Single dashboard for fraud analysts:
 *    - Live Risk Feed: top users by risk_score, filterable by tier
 *    - Fraud Clusters: detected multi-account rings
 *    - Recent Alerts: last 24h of fraud_alerts (severity chips)
 *    - Drill-in modal: click any user → risk profile breakdown
 *
 *  Surgical scope: pure addition. No changes to the admin sidebar
 *  layout, navigation, or other panels.
 */
import { useState, useEffect, useCallback } from 'react';
import { AlertOctagon, RefreshCw, Users, Layers, Bell, X, ChevronRight, Network, Mail } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import CopyableUid from '@/components/dashboard/CopyableUid';
import ClusterGraphViewer from '@/components/dashboard/ClusterGraphViewer';
import AdminFraudDigest from '@/components/dashboard/AdminFraudDigest';

interface RiskUserRow {
  id: string;
  username: string;
  email: string | null;
  is_flagged: boolean;
  risk_score: number;
  risk_tier: string;
  created_at: string;
  bonus_balance_coins: string | number;
  withdrawable_balance_coins: string | number;
  kyc_status: string | null;
  device_count: number;
  score_breakdown?: { signals?: Array<{ code: string; weight: number; detail: string }> };
  last_calculated?: string;
}

interface FraudClusterRow {
  id: string;
  cluster_label: string;
  member_user_ids: string[];
  signal_types: string[];
  total_strength: number | string;
  member_count: number;
  detected_at: string;
  status: string;
}

interface FraudAlertRow {
  id: string;
  alert_type: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  title: string;
  body: string;
  affected_user_ids: string[];
  risk_score?: number;
  signals: string[];
  channels_sent: string[];
  delivery?: Record<string, unknown>;
  recommended_action?: string;
  admin_link?: string;
  created_at: string;
}

const TIER_STYLES: Record<string, string> = {
  critical: 'bg-brand-red/20 text-brand-red border-brand-red/40',
  high_risk: 'bg-brand-orange/20 text-brand-orange border-brand-orange/40',
  medium_risk: 'bg-brand-gold/20 text-brand-gold border-brand-gold/40',
  low_risk: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  safe: 'bg-surface text-text-muted border-border',
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-brand-red/20 text-brand-red',
  high: 'bg-brand-orange/20 text-brand-orange',
  medium: 'bg-brand-gold/20 text-brand-gold',
  info: 'bg-blue-500/20 text-blue-400',
};

export default function AdminFraudPanel() {
  const token = useGameStore((s) => s.token);
  const [activeView, setActiveView] = useState<'feed' | 'clusters' | 'alerts' | 'digest'>('feed');
  const [tierFilter, setTierFilter] = useState<string>('all');

  const [users, setUsers] = useState<RiskUserRow[]>([]);
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [clusters, setClusters] = useState<FraudClusterRow[]>([]);
  const [alerts, setAlerts] = useState<FraudAlertRow[]>([]);
  const [severityCounts, setSeverityCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [drillUser, setDrillUser] = useState<any | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  // Phase 2.5 — graph viewer state
  const [graphClusterId, setGraphClusterId] = useState<string | null>(null);
  const [graph, setGraph] = useState<any | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const openClusterGraph = async (clusterId: string) => {
    setGraphClusterId(clusterId);
    setGraph(null);
    setGraphLoading(true);
    try {
      const r: any = await api.get(`/admin/fraud/clusters/${clusterId}/graph`, token);
      if (r.success) setGraph(r.graph);
      else setDrillError(r.error || 'Graph load failed');
    } finally { setGraphLoading(false); }
  };

  const loadFeed = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const qs = tierFilter === 'all' ? '' : `?tier=${encodeURIComponent(tierFilter)}`;
      const res = await api.get(`/admin/fraud/live-feed${qs}`, token);
      if (res.success) {
        setUsers(res.users || []);
        setTierCounts(res.tierCounts || {});
      }
    } finally { setLoading(false); }
  }, [token, tierFilter]);

  const loadClusters = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await api.get(`/admin/fraud/clusters`, token);
      if (res.success) setClusters(res.clusters || []);
    } finally { setLoading(false); }
  }, [token]);

  const loadAlerts = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await api.get(`/admin/fraud/alerts?hours=24`, token);
      if (res.success) {
        setAlerts(res.alerts || []);
        setSeverityCounts(res.severityCounts || {});
      }
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    if (activeView === 'feed') loadFeed();
    if (activeView === 'clusters') loadClusters();
    if (activeView === 'alerts') loadAlerts();
  }, [activeView, loadFeed, loadClusters, loadAlerts]);

  const openUserDrill = async (uid: string) => {
    setDrillUser(null);
    setDrillError(null);
    setDrillLoading(true);
    try {
      const res = await api.get(`/admin/fraud/users/${uid}/risk-profile`, token);
      if (res.success) setDrillUser(res);
      else setDrillError(res.error || 'Failed to load');
    } catch (e: any) { setDrillError(e?.message || 'Network error'); }
    finally { setDrillLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="heading-display text-lg text-text-primary flex items-center gap-2">
          <AlertOctagon className="text-brand-red" size={20} /> Fraud Center
        </h2>
        <button
          onClick={() => activeView === 'feed' ? loadFeed() : activeView === 'clusters' ? loadClusters() : loadAlerts()}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* View tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          onClick={() => setActiveView('feed')}
          className={`px-3 py-1.5 rounded-t text-sm font-mono flex items-center gap-2 ${activeView === 'feed' ? 'bg-brand-maroon text-white' : 'text-text-muted hover:text-text-primary'}`}
        >
          <Users size={14} /> Live Risk Feed
          {Object.values(tierCounts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) > 0 && activeView !== 'feed' ? null : null}
        </button>
        <button
          onClick={() => setActiveView('clusters')}
          className={`px-3 py-1.5 rounded-t text-sm font-mono flex items-center gap-2 ${activeView === 'clusters' ? 'bg-brand-maroon text-white' : 'text-text-muted hover:text-text-primary'}`}
        >
          <Layers size={14} /> Fraud Clusters
          {clusters.length > 0 && activeView !== 'clusters' && (
            <span className="px-1.5 py-0.5 rounded-full bg-brand-orange/30 text-brand-orange text-[10px]">{clusters.length}</span>
          )}
        </button>
        <button
          onClick={() => setActiveView('alerts')}
          className={`px-3 py-1.5 rounded-t text-sm font-mono flex items-center gap-2 ${activeView === 'alerts' ? 'bg-brand-maroon text-white' : 'text-text-muted hover:text-text-primary'}`}
        >
          <Bell size={14} /> Recent Alerts
          {severityCounts.critical > 0 && activeView !== 'alerts' && (
            <span className="px-1.5 py-0.5 rounded-full bg-brand-red/30 text-brand-red text-[10px]">{severityCounts.critical}</span>
          )}
        </button>
        {/* P3-5: Daily Fraud Digest sub-view */}
        <button
          onClick={() => setActiveView('digest')}
          className={`px-3 py-1.5 rounded-t text-sm font-mono flex items-center gap-2 ${activeView === 'digest' ? 'bg-brand-maroon text-white' : 'text-text-muted hover:text-text-primary'}`}
        >
          <Mail size={14} /> Daily Digest
        </button>
      </div>

      {/* ── LIVE RISK FEED ── */}
      {activeView === 'feed' && (
        <div className="space-y-3">
          {/* Tier summary chips */}
          <div className="flex gap-2 flex-wrap text-xs">
            {(['critical', 'high_risk', 'medium_risk', 'low_risk', 'safe'] as const).map((tier) => (
              <button
                key={tier}
                onClick={() => setTierFilter(tier)}
                className={`px-3 py-1.5 rounded border ${TIER_STYLES[tier]} ${tierFilter === tier ? 'ring-2 ring-offset-2 ring-offset-surface ring-brand-gold' : 'opacity-70 hover:opacity-100'}`}
              >
                {tier.replace('_', ' ')}: <span className="font-bold ml-1">{tierCounts[tier] ?? 0}</span>
              </button>
            ))}
            <button
              onClick={() => setTierFilter('all')}
              className={`px-3 py-1.5 rounded border border-border text-text-muted ${tierFilter === 'all' ? 'ring-2 ring-offset-2 ring-offset-surface ring-brand-gold' : 'opacity-70 hover:opacity-100'}`}
            >
              all: <span className="font-bold ml-1">{Object.values(tierCounts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)}</span>
            </button>
          </div>

          {users.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">
              {loading ? 'Loading…' : 'No users in this tier. Try a different filter.'}
            </p>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 text-text-muted font-mono">
                  <tr>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Risk</th>
                    <th className="text-right p-2">Score</th>
                    <th className="text-right p-2">Bonus</th>
                    <th className="text-right p-2">W/D</th>
                    <th className="text-center p-2">KYC</th>
                    <th className="text-center p-2">Devices</th>
                    <th className="text-left p-2">Top signals</th>
                    <th className="text-right p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const sigs = u.score_breakdown?.signals ?? [];
                    const topSigs = sigs
                      .filter((s) => s.weight > 0)
                      .sort((a, b) => b.weight - a.weight)
                      .slice(0, 3);
                    return (
                      <tr key={u.id} className="border-t border-border hover:bg-surface-2/50">
                        <td className="p-2">
                          <div className="text-text-primary font-medium">{u.username}</div>
                          <CopyableUid id={u.id} truncate={8} />
                        </td>
                        <td className="p-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] border ${TIER_STYLES[u.risk_tier] || TIER_STYLES.safe}`}>
                            {u.risk_tier}
                          </span>
                          {u.is_flagged && (
                            <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-brand-red/20 text-brand-red">flagged</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          <span className={`font-bold ${u.risk_score >= 70 ? 'text-brand-red' : u.risk_score >= 30 ? 'text-brand-orange' : 'text-text-muted'}`}>
                            {u.risk_score}
                          </span>
                          <span className="text-text-muted">/100</span>
                        </td>
                        <td className="p-2 text-right text-text-muted">${Number(u.bonus_balance_coins).toFixed(2)}</td>
                        <td className="p-2 text-right text-text-muted">${Number(u.withdrawable_balance_coins).toFixed(2)}</td>
                        <td className="p-2 text-center text-text-muted">{u.kyc_status ?? '—'}</td>
                        <td className="p-2 text-center text-text-muted">{u.device_count ?? 0}</td>
                        <td className="p-2 text-text-muted">
                          {topSigs.length === 0 ? '—' : topSigs.map((s) => `${s.code}+${s.weight}`).join(', ')}
                        </td>
                        <td className="p-2 text-right">
                          <button
                            onClick={() => openUserDrill(u.id)}
                            className="text-brand-gold hover:text-brand-gold/80"
                            title="Open risk profile"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CLUSTERS ── */}
      {activeView === 'clusters' && (
        <div className="space-y-2">
          {clusters.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">
              {loading ? 'Loading…' : 'No fraud clusters detected yet.'}
            </p>
          ) : (
            clusters.map((c) => (
              <div key={c.id} className="bg-surface border border-brand-orange/30 rounded-lg p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="font-mono text-xs text-text-muted">{c.cluster_label}</div>
                    <div className="text-text-primary font-medium mt-1">{c.member_count} accounts · strength {Number(c.total_strength).toFixed(2)}</div>
                    <div className="text-text-muted text-xs mt-1">
                      Signals: {c.signal_types.join(', ')}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <span className={`px-2 py-1 rounded text-xs ${c.status === 'confirmed' ? 'bg-brand-red/20 text-brand-red' : c.status === 'dismissed' ? 'bg-surface text-text-muted' : 'bg-brand-gold/20 text-brand-gold'}`}>
                      {c.status}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.member_user_ids.slice(0, 6).map((uid) => (
                    <span key={uid} className="inline-flex items-center gap-1">
                      <CopyableUid id={uid} truncate={8} />
                      <button
                        onClick={() => openUserDrill(uid)}
                        title={`Open risk profile for ${uid}`}
                        className="text-[10px] text-text-muted hover:text-brand-gold"
                      >
                        →
                      </button>
                    </span>
                  ))}
                  {c.member_user_ids.length > 6 && (
                    <span className="px-2 py-0.5 text-[10px] text-text-muted">+{c.member_user_ids.length - 6} more</span>
                  )}
                </div>
                <div className="text-text-muted text-[10px] mt-2">
                  detected: {new Date(c.detected_at).toLocaleString()}
                </div>
                <button
                  type="button"
                  onClick={() => openClusterGraph(c.id)}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface-2 border border-border rounded text-xs text-text-secondary hover:text-brand-gold"
                >
                  <Network size={12} />
                  View Graph
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── ALERTS ── */}
      {activeView === 'alerts' && (
        <div className="space-y-2">
          {(['critical', 'high', 'medium', 'info'] as const).map((sev) => (
            severityCounts[sev] > 0 && (
              <div key={sev} className="text-xs text-text-muted">
                <span className={`inline-block px-2 py-0.5 rounded ${SEVERITY_STYLES[sev]}`}>{sev}</span>
                <span className="ml-2">{severityCounts[sev]} alerts in last 24h</span>
              </div>
            )
          ))}
          {alerts.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">
              {loading ? 'Loading…' : 'No alerts in the last 24 hours. The system is quiet.'}
            </p>
          ) : (
            alerts.map((a) => (
              <div key={a.id} className={`bg-surface border rounded-lg p-3 ${
                a.severity === 'critical' ? 'border-brand-red/40' :
                a.severity === 'high' ? 'border-brand-orange/40' :
                a.severity === 'medium' ? 'border-brand-gold/40' :
                'border-border'
              }`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${SEVERITY_STYLES[a.severity]}`}>
                      {a.severity}
                    </span>
                    <span className="text-text-muted font-mono text-[10px]">{a.alert_type}</span>
                  </div>
                  <span className="text-text-muted text-[10px]">{new Date(a.created_at).toLocaleString()}</span>
                </div>
                <div className="text-text-primary font-medium text-sm mt-1">{a.title}</div>
                <div className="text-text-muted text-xs mt-1">{a.body}</div>
                {a.signals.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {a.signals.map((sig, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-surface-2 text-[10px] text-text-muted">{sig}</span>
                    ))}
                  </div>
                )}
                {a.affected_user_ids.length > 0 && (
                  <div className="mt-2 flex items-center gap-1 flex-wrap text-text-muted text-[10px]">
                    <span>Affected:</span>
                    {a.affected_user_ids.map((uid) => (
                      <span key={uid} className="inline-flex items-center gap-1">
                        <CopyableUid id={uid} truncate={8} />
                        <button
                          onClick={() => openUserDrill(uid)}
                          title={`Open risk profile for ${uid}`}
                          className="text-text-muted hover:text-brand-gold"
                        >
                          →
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {a.channels_sent.length > 0 && (
                  <div className="mt-1 text-text-muted text-[10px]">
                    sent via: {a.channels_sent.join(', ')}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* P3-5: DAILY FRAUD DIGEST SUB-VIEW */}
      {activeView === 'digest' && (
        <AdminFraudDigest />
      )}

      {/* ── PHASE 2.5: CLUSTER GRAPH MODAL ── */}
      {graphClusterId && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-surface border border-brand-orange/40 rounded-lg max-w-2xl w-full p-5 my-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-text-primary font-medium flex items-center gap-2">
                <Network size={16} className="text-brand-orange" /> Cluster Graph
                <code className="text-xs text-text-muted ml-1">{graphClusterId.slice(0, 8)}…</code>
              </h3>
              <button onClick={() => { setGraphClusterId(null); setGraph(null); }} className="text-text-muted hover:text-text-primary">
                <X size={18} />
              </button>
            </div>
            {graphLoading && <p className="text-text-muted text-sm">Loading graph…</p>}
            {graph && (
              <ClusterGraphViewer
                nodes={graph.nodes}
                edges={graph.edges}
                onNodeClick={(uid) => { setGraphClusterId(null); setGraph(null); openUserDrill(uid); }}
              />
            )}
          </div>
        </div>
      )}

      {/* ── DRILL-IN MODAL ── */}
      {(drillLoading || drillUser || drillError) && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-surface border border-border rounded-lg max-w-3xl w-full p-5 my-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-text-primary font-medium">Risk Profile</h3>
              <button onClick={() => setDrillUser(null)} className="text-text-muted hover:text-text-primary">
                <X size={18} />
              </button>
            </div>
            {drillLoading && <p className="text-text-muted text-sm">Loading…</p>}
            {drillError && <p className="text-brand-red text-sm">{drillError}</p>}
            {drillUser && (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-text-primary font-medium">{drillUser.user?.username}</div>
                  <CopyableUid id={drillUser.user?.id} />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <span className={`px-2 py-1 rounded text-xs border ${TIER_STYLES[drillUser.user?.risk_tier] || TIER_STYLES.safe}`}>
                    Risk: {drillUser.user?.risk_score}/100 ({drillUser.user?.risk_tier})
                  </span>
                  {drillUser.user?.is_flagged && <span className="px-2 py-1 rounded text-xs bg-brand-red/20 text-brand-red">flagged</span>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-text-muted">Bonus:</span> <span className="text-text-primary">${Number(drillUser.user?.bonus_balance_coins ?? 0).toFixed(2)}</span></div>
                  <div><span className="text-text-muted">W/D:</span> <span className="text-text-primary">${Number(drillUser.user?.withdrawable_balance_coins ?? 0).toFixed(2)}</span></div>
                  <div><span className="text-text-muted">Wagering:</span> <span className="text-text-primary">{Number(drillUser.user?.wagering_completed_coins ?? 0).toFixed(2)} / {Number(drillUser.user?.wagering_required_coins ?? 0).toFixed(2)}</span></div>
                  <div><span className="text-text-muted">Devices:</span> <span className="text-text-primary">{drillUser.user?.device_count ?? 0}</span></div>
                </div>
                {drillUser.signals?.length > 0 && (
                  <div>
                    <div className="text-text-secondary text-xs font-mono mb-1">Fraud signals ({drillUser.signals.length})</div>
                    <ul className="space-y-1">
                      {drillUser.signals.slice(0, 10).map((s: any) => (
                        <li key={s.id} className="flex justify-between text-xs">
                          <span className="text-text-primary">{s.signal_type}</span>
                          <span className="text-text-muted">{s.severity}</span>
                          <span className="text-text-muted">{s.detected_at ? new Date(s.detected_at).toLocaleDateString() : '—'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {drillUser.devices?.length > 0 && (
                  <div>
                    <div className="text-text-secondary text-xs font-mono mb-1">Devices ({drillUser.devices.length})</div>
                    <ul className="space-y-1">
                      {drillUser.devices.map((d: any) => (
                        <li key={d.fingerprintHash} className="flex justify-between text-xs">
                          <span className="font-mono text-text-muted">{d.fingerprintHash.slice(0, 16)}…</span>
                          <span className="text-text-primary">{d.accountCount} accounts</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${TIER_STYLES[d.trustLevel === 'untrusted' ? 'critical' : d.trustLevel === 'suspicious' ? 'high_risk' : 'low_risk'] || ''}`}>{d.trustLevel}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {drillUser.clusters?.length > 0 && (
                  <div>
                    <div className="text-text-secondary text-xs font-mono mb-1">Cluster membership</div>
                    <ul className="space-y-1">
                      {drillUser.clusters.map((cl: any) => (
                        <li key={cl.id} className="text-xs">
                          <span className="font-mono text-text-muted">{cl.clusterLabel}</span>
                          <span className="ml-2 text-text-primary">{cl.memberCount} members · {cl.signalTypes?.join(', ')}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {Array.isArray(drillUser.riskHistory) && drillUser.riskHistory.length > 0 && (
                  <div>
                    <div className="text-text-secondary text-xs font-mono mb-1">Risk history (last {drillUser.riskHistory.length})</div>
                    <ul className="space-y-1">
                      {drillUser.riskHistory.slice().reverse().map((h: any, i: number) => (
                        <li key={i} className="flex justify-between text-xs">
                          <span className="text-text-primary">{h.tier}</span>
                          <span className="text-text-muted">{h.score}/100</span>
                          <span className="text-text-muted">{h.at ? new Date(h.at).toLocaleString() : '—'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}