/**
 * Phase 1.3 — Multi-account graph detection (L11 / L13 / L14)
 *
 * Builds an account relationship graph from shared resources:
 *   device fingerprint, IP address, KYC identity, phone, wallet,
 *   email-domain+IP combo, referral chain.
 *
 * Each resource shared between two accounts is one EDGE in the graph
 * with a strength weight (KYC = 1.0, device = 0.8, IP = 0.4).
 *
 * Algorithms:
 *   - Connected components: union-find over the edges table. Any pair of
 *     accounts connected via ANY chain of shared resources is in the
 *     same component.
 *   - Cluster detection: a component is a fraud cluster when:
 *       - member_count >= 2 (at minimum a suspicious pair), OR
 *       - total_strength >= 1.5 (multiple high-strength edges)
 *     Threshold configurable via admin_settings.
 *
 * Writes fraud_clusters rows. Each edge gets its cluster_id stamped
 * so admin can see "this edge belongs to ring X" in queries.
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { getAdminSettingNumber as getSetting } from './admin-settings.service';

export type ResourceType = 'device' | 'ip' | 'kyc' | 'phone' | 'wallet' | 'email_domain_ip' | 'referral';

export const RESOURCE_STRENGTH: Record<ResourceType, number> = {
  kyc: 1.0,
  device: 0.8,
  wallet: 0.8,
  phone: 0.7,
  email_domain_ip: 0.5,
  ip: 0.4,
  referral: 0.3,
};

export interface ResourceEdge {
  id: string;
  accountA: string;
  accountB: string;
  resourceType: ResourceType;
  resourceHash: string;
  strength: number;
  detectedAt: Date;
  clusterId: string | null;
}

export interface FraudCluster {
  id: string;
  clusterLabel: string;
  memberUserIds: string[];
  detectedAt: Date;
  signalTypes: string[];
  totalStrength: number;
  memberCount: number;
  status: 'pending' | 'confirmed' | 'dismissed';
}

// ── Edge writer ────────────────────────────────────────────────

/**
 * Record that `accountA` and `accountB` share a resource. Idempotent
 * via UNIQUE(account_a, account_b, resource_type, resource_hash).
 *
 * The pair is canonically ordered (smaller UUID first) so duplicate
 * calls from either direction land on the same row.
 *
 * Returns the edge row (new or pre-existing), or null if A == B.
 */
export async function addEdge(
  accountA: string,
  accountB: string,
  resourceType: ResourceType,
  resourceHash: string,
  strength?: number,
): Promise<ResourceEdge | null> {
  if (accountA === accountB) return null;
  if (!resourceHash || resourceHash.length < 4) return null;

  const [a, b] = accountA < accountB ? [accountA, accountB] : [accountB, accountA];
  const s = Math.max(0.01, Math.min(1, strength ?? RESOURCE_STRENGTH[resourceType]));

  const r = await query(
    `INSERT INTO account_resource_links
       (account_a, account_b, resource_type, resource_hash, strength)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::decimal)
     ON CONFLICT (account_a, account_b, resource_type, resource_hash)
     DO UPDATE SET strength = EXCLUDED.strength
     RETURNING id, account_a, account_b, resource_type, resource_hash, strength, detected_at, cluster_id`,
    [a, b, resourceType, resourceHash, s],
  );
  const row = r.rows[0] as {
    id: string;
    account_a: string;
    account_b: string;
    resource_type: ResourceType;
    resource_hash: string;
    strength: string | number;
    detected_at: Date;
    cluster_id: string | null;
  };
  return {
    id: row.id,
    accountA: row.account_a,
    accountB: row.account_b,
    resourceType: row.resource_type,
    resourceHash: row.resource_hash,
    strength: Number(row.strength),
    detectedAt: new Date(row.detected_at),
    clusterId: row.cluster_id,
  };
}

/**
 * Add all edges that arise from a single (userId, resource) usage.
 * Convenience wrapper when the caller already has a list of accounts.
 */
export async function addEdgesFromResource(
  userId: string,
  otherUserIds: string[],
  resourceType: ResourceType,
  resourceHash: string,
): Promise<ResourceEdge[]> {
  const out: ResourceEdge[] = [];
  for (const other of otherUserIds) {
    if (other === userId) continue;
    const edge = await addEdge(userId, other, resourceType, resourceHash);
    if (edge) out.push(edge);
  }
  return out;
}

// ── Graph walker: connected components via union-find ──────────

/**
 * Load all edges (or all edges touching a single user) and compute
 * connected components in memory. Cheaper than SQL recursive CTEs
 * for the typical graph size (~thousands of accounts).
 */
async function loadEdges(scope?: { userId?: string; sinceDays?: number }): Promise<ResourceEdge[]> {
  const params: unknown[] = [];
  const wheres: string[] = [];
  if (scope?.userId) {
    params.push(scope.userId);
    wheres.push(`(account_a = $${params.length}::uuid OR account_b = $${params.length}::uuid)`);
  }
  if (scope?.sinceDays !== undefined) {
    params.push(scope.sinceDays);
    wheres.push(`detected_at > NOW() - ($${params.length}::int || ' days')::interval`);
  }
  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const r = await query(
    `SELECT id, account_a, account_b, resource_type, resource_hash,
            strength, detected_at, cluster_id
       FROM account_resource_links
       ${whereClause}`,
    params,
  );
  return (r.rows as Array<{
    id: string; account_a: string; account_b: string;
    resource_type: ResourceType; resource_hash: string;
    strength: string | number; detected_at: Date; cluster_id: string | null;
  }>).map((row) => ({
    id: row.id,
    accountA: row.account_a,
    accountB: row.account_b,
    resourceType: row.resource_type,
    resourceHash: row.resource_hash,
    strength: Number(row.strength),
    detectedAt: new Date(row.detected_at),
    clusterId: row.cluster_id,
  }));
}

class UnionFind {
  parent = new Map<string, string>();
  rank = new Map<string, number>();
  make(x: string) { if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); } }
  find(x: string): string {
    this.make(x);
    let r = this.parent.get(x)!;
    while (r !== this.parent.get(r)) {
      const p = this.parent.get(r)!;
      this.parent.set(x, this.parent.get(p)!);
      r = this.parent.get(x)!;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a); const rb = this.find(b);
    if (ra === rb) return;
    const rkA = this.rank.get(ra)!; const rkB = this.rank.get(rb)!;
    if (rkA < rkB) this.parent.set(ra, rb);
    else if (rkA > rkB) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, rkA + 1); }
  }
}

/**
 * Compute connected components over the edges table (optionally scoped).
 * Returns map of representative → member set.
 */
export async function buildConnectedComponents(scope?: { userId?: string; sinceDays?: number }):
  Promise<Map<string, Set<string>>> {
  const edges = await loadEdges(scope);
  const uf = new UnionFind();
  for (const e of edges) {
    uf.union(e.accountA, e.accountB);
  }
  const components = new Map<string, Set<string>>();
  for (const e of edges) {
    const repA = uf.find(e.accountA);
    if (!components.has(repA)) components.set(repA, new Set());
    components.get(repA)!.add(e.accountA);
    components.get(repA)!.add(e.accountB);
  }
  return components;
}

// ── Cluster detection & persistence ────────────────────────────

interface ComponentStats {
  userIds: string[];
  edges: ResourceEdge[];
  totalStrength: number;
  signalTypes: Set<ResourceType>;
}

async function componentStatsFromEdges(
  edges: ResourceEdge[],
): Promise<Map<string, ComponentStats>> {
  const uf = new UnionFind();
  for (const e of edges) uf.union(e.accountA, e.accountB);

  const stats = new Map<string, ComponentStats>();
  for (const e of edges) {
    const rep = uf.find(e.accountA);
    if (!stats.has(rep)) {
      stats.set(rep, {
        userIds: [],
        edges: [],
        totalStrength: 0,
        signalTypes: new Set(),
      });
    }
    const s = stats.get(rep)!;
    s.edges.push(e);
    s.totalStrength += e.strength;
    s.signalTypes.add(e.resourceType);
    s.userIds.push(e.accountA, e.accountB);
  }
  for (const s of stats.values()) {
    s.userIds = [...new Set(s.userIds)];
  }
  return stats;
}

/**
 * Recompute all fraud clusters. Idempotent: existing clusters for the
 * same membership are updated (not duplicated). New clusters are inserted.
 * Clusters whose members changed beyond the threshold are revoked.
 *
 * Returns the list of cluster IDs created or updated.
 */
export async function detectAndPersistClusters(): Promise<string[]> {
  const minMembers = await getSetting('fraud_ring_detection_min_accounts', 2, true);
  const minStrength = await getSetting('fraud_ring_min_strength', 1.0, false);

  const edges = await loadEdges();
  const stats = await componentStatsFromEdges(edges);

  const touched: string[] = [];

  for (const [rep, s] of stats.entries()) {
    if (s.userIds.length < minMembers && s.totalStrength < minStrength) continue;

    const label = `cluster_${rep.slice(0, 8)}_${s.userIds.length}m_${s.signalTypes.size}s`;

    // Look for an existing cluster with same member set (overlap >= 80%).
    const existing = await query(
      `SELECT id, member_user_ids FROM fraud_clusters
        WHERE status = 'pending'
          AND cardinality(member_user_ids) > 0
        ORDER BY detected_at DESC
        LIMIT 100`,
    );

    let clusterId: string | null = null;
    for (const row of existing.rows as Array<{ id: string; member_user_ids: string[] }>) {
      const existingSet = new Set(row.member_user_ids);
      const overlap = s.userIds.filter((u) => existingSet.has(u)).length;
      const smaller = Math.min(s.userIds.length, existingSet.size);
      if (smaller > 0 && overlap / smaller >= 0.8) {
        clusterId = row.id;
        break;
      }
    }

    if (clusterId) {
      await query(
        `UPDATE fraud_clusters
            SET member_user_ids = $1::uuid[],
                member_count    = $2::int,
                signal_types    = $3::text[],
                total_strength  = $4::decimal,
                cluster_label   = $5
          WHERE id = $6::uuid`,
        [s.userIds, s.userIds.length, [...s.signalTypes], s.totalStrength, label, clusterId],
      );
      // Re-stamp edges with this cluster_id.
      await query(
        `UPDATE account_resource_links
            SET cluster_id = $1::uuid
          WHERE (account_a = ANY($2::uuid[]) OR account_b = ANY($2::uuid[]))
            AND cluster_id IS DISTINCT FROM $1::uuid`,
        [clusterId, s.userIds],
      );
    } else {
      clusterId = uuidv4();
      await query(
        `INSERT INTO fraud_clusters
           (id, cluster_label, member_user_ids, signal_types, total_strength, member_count, status)
         VALUES ($1::uuid, $2, $3::uuid[], $4::text[], $5::decimal, $6::int, 'pending')`,
        [clusterId, label, s.userIds, [...s.signalTypes], s.totalStrength, s.userIds.length],
      );
      await query(
        `UPDATE account_resource_links
            SET cluster_id = $1::uuid
          WHERE (account_a = ANY($2::uuid[]) OR account_b = ANY($2::uuid[]))
            AND cluster_id IS NULL`,
        [clusterId, s.userIds],
      );
    }
    touched.push(clusterId);
  }

  return touched;
}

/**
 * Get all clusters that a given user is a member of.
 */
export async function getClustersForUser(userId: string): Promise<FraudCluster[]> {
  const r = await query(
    `SELECT id, cluster_label, member_user_ids, detected_at, signal_types,
            total_strength, member_count, status
       FROM fraud_clusters
      WHERE $1::uuid = ANY(member_user_ids)
      ORDER BY detected_at DESC`,
    [userId],
  );
  return (r.rows as Array<{
    id: string; cluster_label: string; member_user_ids: string[];
    detected_at: Date; signal_types: string[];
    total_strength: string | number; member_count: number;
    status: FraudCluster['status'];
  }>).map((row) => ({
    id: row.id,
    clusterLabel: row.cluster_label,
    memberUserIds: row.member_user_ids,
    detectedAt: new Date(row.detected_at),
    signalTypes: row.signal_types,
    totalStrength: Number(row.total_strength),
    memberCount: row.member_count,
    status: row.status,
  }));
}

/**
 * Find what other users are connected to `userId` via any shared
 * resource. Returns a map of otherUserId → list of edge types.
 */
export interface ClusterGraph {
  nodes: Array<{
    id: string;
    username: string;
    riskScore: number;
    riskTier: string;
    isFlagged: boolean;
    createdAt: Date;
  }>;
  edges: Array<{
    id: string;
    a: string;
    b: string;
    resourceType: ResourceType;
    resourceHash: string;
    strength: number;
  }>;
}

/**
 * Build the full node+edge graph for a fraud cluster. Walks the
 * connected component of every member so the visualization shows
 * indirect edges (A-B via C) too.
 */
export async function buildClusterGraph(memberUserIds: string[]): Promise<ClusterGraph> {
  if (memberUserIds.length === 0) return { nodes: [], edges: [] };

  // Use ANY($1) so the query stays simple regardless of count.
  const userRows = await query(
    `SELECT id, username, risk_score, risk_tier, is_flagged, created_at
       FROM users
      WHERE id = ANY($1::uuid[])`,
    [memberUserIds],
  );
  const nodes = (userRows.rows as Array<{
    id: string; username: string; risk_score: number; risk_tier: string;
    is_flagged: boolean; created_at: Date;
  }>).map((r) => ({
    id: r.id, username: r.username, riskScore: r.risk_score, riskTier: r.risk_tier,
    isFlagged: r.is_flagged, createdAt: new Date(r.created_at),
  }));

  const edgeRows = await query(
    `SELECT id, account_a, account_b, resource_type, resource_hash, strength
       FROM account_resource_links
      WHERE account_a = ANY($1::uuid[]) AND account_b = ANY($1::uuid[])`,
    [memberUserIds],
  );
  const edges = (edgeRows.rows as Array<{
    id: string; account_a: string; account_b: string;
    resource_type: ResourceType; resource_hash: string; strength: string | number;
  }>).map((r) => ({
    id: r.id, a: r.account_a, b: r.account_b,
    resourceType: r.resource_type,
    resourceHash: r.resource_hash.slice(0, 8) + '…',
    strength: Number(r.strength),
  }));

  return { nodes, edges };
}

export async function getConnectedUsers(userId: string): Promise<Map<string, ResourceType[]>> {
  const r = await query(
    `SELECT
        CASE WHEN account_a = $1::uuid THEN account_b ELSE account_a END AS other_user,
        resource_type
       FROM account_resource_links
      WHERE account_a = $1::uuid OR account_b = $1::uuid`,
    [userId],
  );
  const out = new Map<string, ResourceType[]>();
  for (const row of r.rows as Array<{ other_user: string; resource_type: ResourceType }>) {
    if (!out.has(row.other_user)) out.set(row.other_user, []);
    out.get(row.other_user)!.push(row.resource_type);
  }
  return out;
}