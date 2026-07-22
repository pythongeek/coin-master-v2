'use client';
/**
 * Phase 3 / P3-3a — ClusterGraphViewer compatibility shim.
 *
 * Wraps D3ForceGraph so the existing AdminFraudPanel import works
 * unchanged. Old GraphEdge.resourceHash is ignored (the new D3 viewer
 * doesn't render per-edge hash text; the resourceType alone is enough
 * for the colour/label).
 *
 * Internal re-export of D3ForceGraph:
 *   - same onNodeClick contract
 *   - same node colour-by-risk-tier
 *   - same edge colour-by-resource-type
 *   - same hover/tooltip UX
 *   - D3 adds: force simulation, zoom, drag, view-state persistence
 */
import D3ForceGraph, { GraphNode, GraphEdge } from './D3ForceGraph';

export type { GraphNode, GraphEdge };

export default function ClusterGraphViewer({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (userId: string) => void;
}) {
  // fraud-ring defaults: node size = degree, tighter layout
  return (
    <D3ForceGraph
      nodes={nodes}
      edges={edges}
      onNodeClick={onNodeClick}
      scope="fraud"
      width={460}
      height={360}
      chargeStrength={-200}
      linkDistance={56}
      collideRadius={32}
      nodeSizeFrom="degree"
      sizeScale={7}
      minRadius={8}
      maxRadius={28}
    />
  );
}