'use client';
/**
 * Phase 3 / P3-3a — D3ForceGraph (pure d3 + raw SVG).
 *
 * Force-directed graph using d3-force. Replaces the hand-rolled
 * circle-layout ClusterGraphViewer.tsx (P3-1.5) for any consumer
 * that needs a real force simulation. Same prop contract so the
 * existing fraud-ring modal in AdminFraudPanel still works.
 *
 * What's in here, what's not:
 *   - d3-force simulation (link + many-body + center + collide)
 *   - d3-zoom for pan/zoom
 *   - d3-drag for node dragging
 *   - tooltip on node/edge hover
 *   - click → onNodeClick callback
 *   - view state (zoom + transform) persisted in localStorage
 *     so the operator doesn't lose position on tab switch
 *   - SVG legend below
 *
 * What's NOT in here:
 *   - new deps beyond d3 itself (we only pull force/zoom/drag/select/scale)
 *   - any backend change
 *   - any change to the data shape
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { ZoomIn, ZoomOut, Locate, Maximize2 } from 'lucide-react';
import CopyableUid from './CopyableUid';

// SimulationNodeDatum provides x, y, vx, vy, fx, fy, index — required
// by d3-force. We extend our public GraphNode with these so consumers
// can still build nodes from pure application data and the simulation
// can read/mutate the kinematic fields.
export interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  username?: string;
  riskScore?: number;
  riskTier?: string;
  isFlagged?: boolean;
  // free-form metric values (top-depositors: amount, top-winners: win,
  // top-fraud-signals: count, etc.). Drives node size + tooltip.
  metric?: number;
  metricLabel?: string;
}

export interface GraphEdge extends d3.SimulationLinkDatum<GraphNode> {
  id: string;
  a: string;
  b: string;
  resourceType?: string;   // 'device' | 'ip' | 'kyc' | etc. (fraud ring only)
  strength?: number;        // 0..1
}

interface ViewState { x: number; y: number; k: number }
const VIEW_KEY = (kind: string, scope: string) => `d3view:${kind}:${scope}`;
const TIER_COLOR: Record<string, string> = {
  critical: '#dc3545', high_risk: '#fd7e14', medium_risk: '#eab308',
  low_risk: '#3b82f6', safe: '#6b7280',
};
const EDGE_COLOR: Record<string, string> = {
  device: '#a78bfa', ip: '#f472b6', kyc: '#fb923c', phone: '#34d399',
  wallet: '#22d3ee', email_domain_ip: '#94a3b8', referral: '#c084fc',
  // audience-metric edges (when no resourceType, default)
  default: '#94a3b8',
};
const RESOURCE_LABEL: Record<string, string> = {
  device: 'same device', ip: 'same IP', kyc: 'same KYC',
  phone: 'same phone', wallet: 'same wallet', referral: 'same referrer',
};

const W = 480;
const H = 360;

export default function D3ForceGraph({
  nodes,
  edges,
  onNodeClick,
  // View-state persistence. scope = "fraud" | "audience:top_depositors" | etc.
  scope = 'default',
  height = H,
  width = W,
  // Force tuning per graph kind. Fraud ring pulls tight; top-N spread out.
  chargeStrength = -180,
  linkDistance = 60,
  collideRadius = 28,
  // Node radius base + scaling. Node size = max(r0, sqrt(metric) * scale).
  nodeSizeFrom = 'metric' as 'metric' | 'degree',
  sizeScale = 8,
  minRadius = 6,
  maxRadius = 26,
  // Limit visible nodes for clarity. Default 100 is fine for a
  // 480x360 view; large graphs need to constrain in the panel.
  maxNodes = 100,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (userId: string) => void;
  scope?: string;
  height?: number;
  width?: number;
  chargeStrength?: number;
  linkDistance?: number;
  collideRadius?: number;
  nodeSizeFrom?: 'metric' | 'degree';
  sizeScale?: number;
  minRadius?: number;
  maxRadius?: number;
  maxNodes?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRootRef = useRef<SVGGElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simRef = useRef<d3.Simulation<GraphNode, GraphEdge> | null>(null);
  const [hover, setHover] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);

  // Truncate input to maxNodes (keeps simulation O(n²) bounded).
  const sliced = useMemo(() => {
    if (nodes.length <= maxNodes) return { nodes, edges };
    // Keep top-N nodes by metric; drop edges that point to dropped nodes.
    const keep = new Set(nodes.slice(0, maxNodes).map((n) => n.id));
    return {
      nodes: nodes.filter((n) => keep.has(n.id)),
      edges: edges.filter((e) => keep.has(e.a) && keep.has(e.b)),
    };
  }, [nodes, edges, maxNodes]);

  // Compute degree for each node (when sizing by degree).
  const degree = useMemo(() => {
    if (nodeSizeFrom !== 'degree') return new Map<string, number>();
    const m = new Map<string, number>();
    for (const e of sliced.edges) {
      m.set(e.a, (m.get(e.a) ?? 0) + 1);
      m.set(e.b, (m.get(e.b) ?? 0) + 1);
    }
    return m;
  }, [sliced, nodeSizeFrom]);

  // Compute radius per node (for the SVG circle r attribute).
  const radius = useCallback((n: GraphNode): number => {
    const v = nodeSizeFrom === 'degree' ? (degree.get(n.id) ?? 1) : (n.metric ?? 1);
    if (!Number.isFinite(v) || v <= 0) return minRadius;
    return Math.max(minRadius, Math.min(maxRadius, Math.sqrt(v) * sizeScale));
  }, [nodeSizeFrom, degree, sizeScale, minRadius, maxRadius]);

  // Re-mount the simulation on data or scope change. Stops old sim
  // before starting a new one (prevents multiple alpha loops).
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    const g = svg.append('g').attr('class', 'd3-graph-root');
    gRootRef.current = g.node();

    // Edges (drawn first so they sit behind nodes).
    const link = g.append('g')
      .attr('stroke', '#64748b')
      .attr('stroke-opacity', 0.55)
      .selectAll<SVGLineElement, GraphEdge>('line')
      .data(sliced.edges)
      .join('line')
      .attr('stroke-width', (d) => Math.max(0.5, (d.strength ?? 0.4) * 2))
      .attr('stroke', (d) => EDGE_COLOR[d.resourceType ?? 'default'] ?? EDGE_COLOR.default)
      .attr('cursor', 'pointer')
      .on('mouseenter', (_, d) => setHover({ kind: 'edge', id: d.id }))
      .on('mouseleave', () => setHover(null));

    // Nodes.
    const nodeG = g.append('g')
      .selectAll<SVGGElement, GraphNode>('g.node')
      .data(sliced.nodes, (d) => d.id)
      .join('g')
      .attr('class', 'node')
      .attr('cursor', 'pointer')
      .on('click', (_, d) => onNodeClick?.(d.id))
      .on('mouseenter', (_, d) => setHover({ kind: 'node', id: d.id }))
      .on('mouseleave', () => setHover(null))
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simRef.current?.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simRef.current?.alphaTarget(0);
          // leave node pinned where user dropped it; double-click to unpin
          // (handled below in dblclick listener)
        }),
      );

    nodeG.append('circle')
      .attr('r', (d) => radius(d))
      .attr('fill', (d) => TIER_COLOR[d.riskTier ?? 'safe'] ?? TIER_COLOR.safe)
      .attr('stroke', (d) => d.isFlagged ? '#fbbf24' : '#0f172a')
      .attr('stroke-width', (d) => d.isFlagged ? 2.4 : 1.2)
      .attr('opacity', 0.92);

    nodeG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', -1)
      .attr('font-size', 10)
      .attr('font-weight', 600)
      .attr('fill', '#0f172a')
      .attr('pointer-events', 'none')
      .text((d) => {
        if (d.metric !== undefined && d.metricLabel) {
          if (d.metricLabel.includes('$')) {
            return `$${Math.round(d.metric).toLocaleString()}`;
          }
          return Math.round(d.metric).toString();
        }
        return Math.round(d.riskScore ?? 0).toString();
      });

    nodeG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => radius(d) + 11)
      .attr('font-size', 8.5)
      .attr('fill', '#cbd5e1')
      .attr('pointer-events', 'none')
      .text((d) => (d.username ?? d.id.slice(0, 6)));

    // Double-click to unpin a dragged node.
    nodeG.on('dblclick', (_, d) => { d.fx = null; d.fy = null; });

    // Build + start the simulation.
    const sim = d3.forceSimulation<GraphNode>(sliced.nodes)
      .force('link', d3.forceLink<GraphNode, GraphEdge>(sliced.edges)
        .id((d) => d.id)
        .distance(linkDistance)
        .strength((d) => d.strength ?? 0.4),
      )
      .force('charge', d3.forceManyBody<GraphNode>().strength(chargeStrength))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<GraphNode>().radius((d) => radius(d) + 4))
      .on('tick', () => {
        link
          .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
          .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
          .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
          .attr('y2', (d) => (d.target as GraphNode).y ?? 0);
        nodeG.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });
    simRef.current = sim;

    // Zoom + pan on the root group. View state persists in localStorage.
    const saved = loadView(scope);
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 6])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
        saveView(scope, event.transform);
      });
    zoomRef.current = zoom;
    svg.call(zoom);
    if (saved) {
      svg.call(zoom.transform, d3.zoomIdentity.translate(saved.x, saved.y).scale(saved.k));
    } else {
      svg.call(zoom.transform, d3.zoomIdentity);
    }

    return () => {
      sim.stop();
    };
  }, [sliced, radius, width, height, chargeStrength, linkDistance, scope, onNodeClick]);

  // UI helpers
  const focusNode = useCallback(() => {
    if (!sliced.nodes.length || !svgRef.current) return;
    // Reset pinned + re-center + re-zoom-to-fit.
    for (const n of sliced.nodes) { n.fx = null; n.fy = null; }
    simRef.current?.alpha(0.5).restart();
    if (zoomRef.current) {
      d3.select(svgRef.current).transition().duration(450).call(
        zoomRef.current.transform,
        d3.zoomIdentity,
      );
    }
  }, [sliced]);

  const zoomBy = useCallback((factor: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(220).call(
      zoomRef.current.scaleBy, factor,
    );
  }, []);

  const focused = hover?.kind === 'node' ? sliced.nodes.find((n) => n.id === hover.id) : null;
  const focusedEdge = hover?.kind === 'edge' ? sliced.edges.find((e) => e.id === hover.id) : null;

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Top-right toolbar */}
      <div className="w-full flex items-center justify-end gap-1">
        <button type="button" onClick={() => zoomBy(1.4)} title="Zoom in"
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-2">
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.4)} title="Zoom out"
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-2">
          <ZoomOut size={14} />
        </button>
        <button type="button" onClick={focusNode} title="Reset view"
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-2">
          <Maximize2 size={14} />
        </button>
        <span className="ml-2 text-text-muted text-[10px]">
          {sliced.nodes.length} nodes · {sliced.edges.length} edges
        </span>
      </div>

      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="bg-surface-2 rounded-lg border border-border"
        style={{ maxWidth: width }}
        role="img"
        aria-label="Audience / fraud graph"
      />

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-text-muted">
        <span>Node fill = risk tier:</span>
        {Object.entries(TIER_COLOR).map(([tier, c]) => (
          <span key={tier} className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: c }} />
            {tier}
          </span>
        ))}
        {sliced.edges.length > 0 && Object.keys(EDGE_COLOR).some((k) => sliced.edges.some((e) => e.resourceType === k)) && (
          <>
            <span className="mx-1">·</span>
            <span>Edge = resource:</span>
            {Object.entries(RESOURCE_LABEL).filter(([k]) => sliced.edges.some((e) => e.resourceType === k)).map(([k, label]) => (
              <span key={k} className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5" style={{ background: EDGE_COLOR[k] }} />
                {label}
              </span>
            ))}
          </>
        )}
      </div>

      {/* Hover detail */}
      {focused && (
        <div className="text-xs bg-surface border border-brand-gold/30 rounded-lg px-3 py-2 w-full max-w-md">
          <div className="text-text-primary font-medium">
            {focused.username ?? focused.id.slice(0, 8)} · risk {focused.riskScore ?? '—'} ({focused.riskTier ?? 'safe'})
            {focused.isFlagged && <span className="ml-2 px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold text-[10px]">flagged</span>}
          </div>
          <div className="text-text-muted mt-1 font-mono text-[10px]">{focused.id}</div>
          {focused.metric !== undefined && (
            <div className="text-text-secondary text-[11px] mt-1">{focused.metricLabel}: {Math.round(focused.metric).toLocaleString()}</div>
          )}
          <div className="mt-1 flex items-center gap-2">
            <CopyableUid id={focused.id} truncate={10} />
            {onNodeClick && (
              <button type="button" onClick={() => onNodeClick(focused.id)}
                className="text-brand-gold hover:text-brand-gold/80 text-[11px]">
                Open risk profile →
              </button>
            )}
          </div>
        </div>
      )}
      {focusedEdge && (
        <div className="text-xs bg-surface border border-brand-gold/30 rounded-lg px-3 py-2 w-full max-w-md">
          <div className="text-text-primary font-medium">
            {RESOURCE_LABEL[focusedEdge.resourceType ?? ''] ?? focusedEdge.resourceType ?? 'shared resource'}
          </div>
          <div className="text-text-muted text-[11px] mt-1">
            strength: {(focusedEdge.strength ?? 0).toFixed(2)} ·
            {focusedEdge.a.slice(0, 6)}… ↔ {focusedEdge.b.slice(0, 6)}…
          </div>
        </div>
      )}
    </div>
  );
}

// ── view state persistence (localStorage) ──────────────────────
function loadView(scope: string): ViewState | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_KEY('graph', scope)) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as ViewState;
    if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.k !== 'number') return null;
    return v;
  } catch { return null; }
}
function saveView(scope: string, t: d3.ZoomTransform): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VIEW_KEY('graph', scope), JSON.stringify({ x: t.x, y: t.y, k: t.k } satisfies ViewState));
  } catch { /* quota or private mode — ignore */ }
}