'use client';
/**
 * Phase 2.5 — Cluster Graph Viewer (pure SVG, no D3 dep)
 *
 * Renders nodes (users) and edges (shared resources) for a fraud
 * cluster. Layout = nodes on a circle, edges as curves between them.
 * Click a node → opens the user's risk profile via onNodeClick prop.
 *
 * Surgical addition: pure presentational component, used by
 * AdminFraudPanel via a modal.
 */
import { useState } from 'react';
import CopyableUid from './CopyableUid';

export interface GraphNode {
  id: string;
  username: string;
  riskScore: number;
  riskTier: string;
  isFlagged: boolean;
}

export interface GraphEdge {
  id: string;
  a: string;
  b: string;
  resourceType: string;
  resourceHash: string;
  strength: number;
}

const TIER_COLOR: Record<string, string> = {
  critical: '#dc3545',
  high_risk: '#fd7e14',
  medium_risk: '#eab308',
  low_risk: '#3b82f6',
  safe: '#6b7280',
};

const EDGE_COLOR: Record<string, string> = {
  device: '#a78bfa',
  ip: '#f472b6',
  kyc: '#fb923c',
  phone: '#34d399',
  wallet: '#22d3ee',
  email_domain_ip: '#94a3b8',
  referral: '#c084fc',
};

const RESOURCE_LABEL: Record<string, string> = {
  device: 'same device',
  ip: 'same IP',
  kyc: 'same KYC',
  phone: 'same phone',
  wallet: 'same wallet',
  email_domain_ip: 'same email+IP',
  referral: 'same referrer',
};

const SIZE = 420;
const PADDING = 80;
const NODE_RADIUS = 28;

export default function ClusterGraphViewer({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (userId: string) => void;
}) {
  const [hover, setHover] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);

  // Position nodes evenly around a circle.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = Math.min(SIZE, SIZE) / 2 - PADDING;
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
    positions.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });

  const focused = hover?.kind === 'node' ? nodes.find((n) => n.id === hover.id) : null;
  const focusedEdges = hover?.kind === 'node'
    ? edges.filter((e) => e.a === hover.id || e.b === hover.id)
    : [];

  if (nodes.length === 0) {
    return (
      <div className="p-6 text-text-muted text-sm text-center">
        No nodes in this cluster.
      </div>
    );
  }

  if (nodes.length === 1) {
    return (
      <div className="p-6 text-text-muted text-sm text-center">
        Single-node cluster — no edges to visualize.
        <div className="mt-2"><CopyableUid id={nodes[0].id} truncate={12} /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="bg-surface-2 rounded-lg border border-border">
        {/* Edge arcs */}
        {edges.map((e) => {
          const pa = positions.get(e.a);
          const pb = positions.get(e.b);
          if (!pa || !pb) return null;
          const isHighlighted = hover?.id === e.id;
          const dim = hover !== null && !isHighlighted && hover.kind === 'node' &&
                       e.a !== hover.id && e.b !== hover.id;
          // Curve: control point at midpoint pushed outward for arcs.
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const ox = -dy / len;
          const oy = dx / len;
          const cpOff = Math.min(60, len * 0.18);
          const cpX = mx + ox * cpOff;
          const cpY = my + oy * cpOff;
          const path = `M ${pa.x} ${pa.y} Q ${cpX} ${cpY} ${pb.x} ${pb.y}`;
          const color = EDGE_COLOR[e.resourceType] ?? '#64748b';
          return (
            <g key={e.id}>
              <path
                d={path}
                stroke={color}
                strokeWidth={isHighlighted ? 3 : 1.5 + e.strength}
                fill="none"
                opacity={dim ? 0.2 : isHighlighted ? 1 : 0.55}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover({ kind: 'edge', id: e.id })}
                onMouseLeave={() => setHover(null)}
              />
              <text
                x={cpX}
                y={cpY}
                textAnchor="middle"
                dy="-4"
                fontSize="10"
                fill={color}
                opacity={isHighlighted ? 1 : 0.7}
                style={{ pointerEvents: 'none' }}
              >
                {RESOURCE_LABEL[e.resourceType] ?? e.resourceType}
              </text>
              <text
                x={cpX}
                y={cpY}
                textAnchor="middle"
                dy="10"
                fontSize="9"
                fill="#94a3b8"
                opacity={isHighlighted ? 1 : 0.6}
                style={{ pointerEvents: 'none' }}
              >
                ({e.resourceHash})
              </text>
            </g>
          );
        })}
        {/* Nodes */}
        {nodes.map((n) => {
          const p = positions.get(n.id)!;
          const color = TIER_COLOR[n.riskTier] ?? '#64748b';
          const isHovered = hover?.id === n.id;
          return (
            <g key={n.id}>
              <circle
                cx={p.x} cy={p.y} r={NODE_RADIUS}
                fill={color}
                opacity={isHovered ? 1 : 0.9}
                stroke={n.isFlagged ? '#fbbf24' : '#0f172a'}
                strokeWidth={n.isFlagged ? 3 : 1.5}
                style={{ cursor: onNodeClick ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover({ kind: 'node', id: n.id })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onNodeClick?.(n.id)}
              />
              <text
                x={p.x} y={p.y - NODE_RADIUS - 8}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#e2e8f0"
                style={{ pointerEvents: 'none' }}
              >
                {n.username}
              </text>
              <text
                x={p.x} y={p.y + 4}
                textAnchor="middle"
                fontSize="13"
                fontWeight="700"
                fill="#0f172a"
                style={{ pointerEvents: 'none' }}
              >
                {n.riskScore}
              </text>
              <text
                x={p.x} y={p.y + NODE_RADIUS + 12}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
                style={{ pointerEvents: 'none' }}
              >
                {n.id.slice(0, 8)}…
              </text>
            </g>
          );
        })}
        {/* Center label */}
        <text x={cx} y={cy} textAnchor="middle" fontSize="10" fill="#475569">
          {nodes.length} nodes · {edges.length} shared resources
        </text>
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-text-muted">
        <span>Node fill = risk tier:</span>
        {Object.entries(TIER_COLOR).map(([tier, c]) => (
          <span key={tier} className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: c }} />
            {tier}
          </span>
        ))}
      </div>

      {/* Hover detail */}
      {focused && (
        <div className="text-xs bg-surface border border-brand-gold/30 rounded-lg px-3 py-2 w-full max-w-md">
          <div className="text-text-primary font-medium">
            {focused.username} · risk {focused.riskScore} ({focused.riskTier})
            {focused.isFlagged && <span className="ml-2 px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold text-[10px]">flagged</span>}
          </div>
          <div className="text-text-muted mt-1 font-mono text-[10px]">{focused.id}</div>
          <button
            type="button"
            onClick={() => onNodeClick?.(focused.id)}
            className="mt-1 text-brand-gold hover:text-brand-gold/80 text-xs"
          >
            Open risk profile →
          </button>
        </div>
      )}
      {hover?.kind === 'edge' && (() => {
        const e = edges.find((x) => x.id === hover.id);
        if (!e) return null;
        return (
          <div className="text-xs bg-surface border border-brand-gold/30 rounded-lg px-3 py-2 w-full max-w-md">
            <div className="text-text-primary font-medium">
              {RESOURCE_LABEL[e.resourceType] ?? e.resourceType}
            </div>
            <div className="text-text-muted mt-1">strength: {e.strength.toFixed(2)} · resource: <code>{e.resourceHash}</code></div>
          </div>
        );
      })()}
    </div>
  );
}