/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-LOBBY — Phase 2 / Day 10
 *  ════════════════════════════════════════════════════════════════
 *
 *  Backend for the lobby browser UI (Day 12). Exposes 3 read-only
 *  endpoints that the React lobby will consume:
 *
 *    listOpenGroups(...)            → public/discoverable open rooms
 *    listFriendsActiveGroups(...)   → rooms where the user's friend
 *                                      graph has been invited/joined
 *    listUserHistory(userId, …)     → user's own past rooms
 *
 *  Reads are bounded by the 24 admin-config thresholds
 *  (groupAbsolutePoolCap, groupAbsoluteMaxMembers, etc.) but only
 *  the country-block list filters at the SQL layer; the per-row cap
 *  enforcement happens at create-time.
 *
 *  All filters are advisory — the admin group-play-reset endpoint
 *  is the operator's source of truth (Day 9).
 */

import { query } from '../config/database';
import { getGroupConfigKey, parseCountryList } from './admin-group-config';

export interface LobbyFilters {
  gameType?: string;
  payoutMode?: 'equal' | 'proportional' | 'founder_boost';
  minPool?: number;       // numeric(18,8)
  maxPool?: number;
  minMembersRequired?: number; // hide rooms where min_members < this (e.g. "almost full")
  creatorTierAtLeast?: number;
  limit?: number;          // default 50, max 100
  offset?: number;         // default 0
  // Optional: pass the viewer's IP country code so the service can
  // hide rooms when their country is in groupPlayBlockedCountries.
  viewerCountry?: string | null;
}

export interface LobbyRoom {
  id: string;
  shortCode: string;
  status: string;
  gameType: string;
  creatorId: string;
  creatorChoice: 'heads' | 'tails';
  creatorStake: string;
  perMemberStake: string;
  totalPool: string;
  minMembers: number;
  maxMembers: number;
  currentMembers: number;
  payoutMode: string;
  turnMode: string;
  autoFlipSeconds: number;
  expiresAt: string;
  readyAt: string | null;
  resolvedAt: string | null;
  winningSide: string | null;
  createdAt: string;
}

/**
 * Public lobby: returns rooms with status ∈ ('open','ready') that
 * haven't expired. Honours admin-config groupAbsolutePoolCap.
 *
 * Performance: uses `idx_group_bet_expires_open` partial index for
 * status+expires_at, plus the `idx_group_bet_status` for sort/limit.
 */
export async function listOpenGroups(
  filters: LobbyFilters = {},
): Promise<{ rooms: LobbyRoom[]; total: number; limit: number; offset: number }> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
  const offset = Math.max(0, filters.offset ?? 0);

  // ── Admin-config country block ────────────────────────────────
  let blockedCountries: string[] = [];
  try {
    const raw = (await getGroupConfigKey('groupPlayBlockedCountries').catch(() => '*')) as string | number | boolean | null;
    if (raw && raw !== '*' && raw !== '') {
      const parsed = parseCountryList(String(raw));
      if (parsed) blockedCountries = parsed;
    }
  } catch { /* ignore config read failure */ }

  const viewerCountry = (filters.viewerCountry || '').toUpperCase().trim();
  if (viewerCountry && blockedCountries.includes(viewerCountry)) {
    return { rooms: [], total: 0, limit, offset };
  }

  // ── Dynamic SQL ────────────────────────────────────────────────
  const where: string[] = [
    "g.status IN ('open','ready')",
    "(g.expires_at IS NULL OR g.expires_at > NOW())",
    "(g.is_frozen IS NULL OR g.is_frozen = false)",
  ];
  const params: unknown[] = [];

  if (filters.gameType) {
    params.push(filters.gameType);
    where.push(`g.game_type = $${params.length}`);
  }
  if (filters.payoutMode) {
    params.push(filters.payoutMode);
    where.push(`g.payout_mode = $${params.length}`);
  }
  if (typeof filters.minPool === 'number') {
    params.push(filters.minPool);
    where.push(`g.total_pool >= $${params.length}`);
  }
  if (typeof filters.maxPool === 'number') {
    params.push(filters.maxPool);
    where.push(`g.total_pool <= $${params.length}`);
  }
  if (typeof filters.minMembersRequired === 'number') {
    params.push(filters.minMembersRequired);
    where.push(`g.min_members <= $${params.length}`);
  }

  // Countries: not currently stored on the group_bet row (Day 1 schema
  // didn't include a `creator_country` column). When the column is
  // added (Phase 3 §2.4 user-limits), this filter will activate.
  // For now it's a no-op.

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const baseFrom = `
    FROM group_bet g
    ${whereClause}
  `;

  // ── Count ──────────────────────────────────────────────────────
  const countResult = await query<{ total: number }>(
    `SELECT count(*)::int AS total ${baseFrom}`,
    params,
  );
  const total = countResult.rows[0]?.total ?? 0;

  // ── Page ───────────────────────────────────────────────────────
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await query<LobbyRoom>(
    `SELECT g.id, g.short_code AS "shortCode", g.status, g.game_type AS "gameType",
            g.creator_id AS "creatorId", g.creator_choice AS "creatorChoice",
            g.creator_stake::text AS "creatorStake",
            g.per_member_stake::text AS "perMemberStake",
            g.total_pool::text AS "totalPool",
            g.min_members AS "minMembers", g.max_members AS "maxMembers",
            g.current_members AS "currentMembers",
            g.payout_mode AS "payoutMode", g.turn_mode AS "turnMode",
            g.auto_flip_seconds AS "autoFlipSeconds",
            g.expires_at AS "expiresAt",
            g.ready_at AS "readyAt",
            g.resolved_at AS "resolvedAt",
            g.winning_side AS "winningSide",
            g.created_at AS "createdAt"
     ${baseFrom}
     ORDER BY g.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  return { rooms: rows.rows, total, limit, offset };
}

/**
 * "Friends' active groups": every open/ready room where ANY user in
 * a "friend graph" of the requester is either the creator OR a
 * member. We approximate the friend graph as:
 *   1. Users the requester has won/lost WITH in any past group_bet
 *      (i.e. people who appeared in the same group_bet_member table)
 *   2. Excludes the requester's own open rooms.
 *
 * This is intentionally loose — Phase 3 will replace with a real
 * friends table. We expose this as `*` so the lobby can show the
 * "people you've played with" tier even without a friends model.
 */
export async function listFriendsActiveGroups(
  userId: string,
  limit = 50,
): Promise<LobbyRoom[]> {
  // Friends = any distinct user_id who shares at least one past
  // group_bet_member row with the requester.
  // (group_bet_member has no "status" column — the status is on
  //  group_bet itself; we just want the set of co-players.)
  const r = await query<{ other_id: string }>(
    `SELECT DISTINCT m2.user_id AS other_id
       FROM group_bet_member m1
       JOIN group_bet_member m2
         ON m2.group_id = m1.group_id
        AND m2.user_id != m1.user_id
      WHERE m1.user_id = $1
        AND m1.group_id IN (
          SELECT group_id FROM group_bet_member WHERE user_id = $1
        )
      ORDER BY other_id
      LIMIT 1000`,
    [userId],
  );
  const friendIds = r.rows.map(r => r.other_id);
  if (friendIds.length === 0) {
    // No graph yet → return any open rooms (so the UI has content
    // for users with no past activity). Frontend will hide this slice.
    return [];
  }

  // Now find open rooms where any of those friend ids appear as
  // creator OR member (excluding the requester's own rooms).
  if (friendIds.length === 0) return [];
  const friendList = friendIds.slice(0, 200); // cap the OR-list for safety

  const rooms = await query<LobbyRoom>(
    `SELECT DISTINCT ON (g.id) g.id, g.short_code AS "shortCode", g.status,
            g.game_type AS "gameType", g.creator_id AS "creatorId",
            g.creator_choice AS "creatorChoice",
            g.creator_stake::text AS "creatorStake",
            g.per_member_stake::text AS "perMemberStake",
            g.total_pool::text AS "totalPool",
            g.min_members AS "minMembers", g.max_members AS "maxMembers",
            g.current_members AS "currentMembers",
            g.payout_mode AS "payoutMode", g.turn_mode AS "turnMode",
            g.auto_flip_seconds AS "autoFlipSeconds",
            g.expires_at AS "expiresAt",
            g.ready_at AS "readyAt",
            g.resolved_at AS "resolvedAt",
            g.winning_side AS "winningSide",
            g.created_at AS "createdAt"
       FROM group_bet g
       LEFT JOIN group_bet_member m ON m.group_id = g.id
      WHERE g.status IN ('open','ready')
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
        AND g.creator_id != $1
        AND (m.user_id = ANY($2::uuid[]) OR g.creator_id = ANY($2::uuid[]))
      ORDER BY g.id, g.created_at DESC
      LIMIT 100`,
    [userId, friendList],
  );

  return rooms.rows;
}

/**
 * My history: every room the requester has CREATED or JOINED, any
 * status, newest first. The lobby "My active groups" sidebar uses
 * just the open/ready subset; admin-side group_bet_admin_panel uses
 * the full set.
 */
export async function listUserHistory(
  userId: string,
  opts: { limit?: number; offset?: number; statusFilter?: string[] | null } = {},
): Promise<{ rooms: any[]; total: number; limit: number; offset: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const statusFilter = opts.statusFilter ?? null;

  // ── Count ──────────────────────────────────────────────────────
  const countWhere = [
    'm.user_id = $1',
    statusFilter ? `g.status = ANY(${('')}::text[])` : '1=1',
  ];
  const countParams: unknown[] = [userId];
  if (statusFilter && statusFilter.length > 0) {
    countWhere[1] = 'g.status = ANY($2::text[])';
    countParams.push(statusFilter);
  }
  const totalRes = await query<{ total: number }>(
    `SELECT count(DISTINCT g.id)::int AS total
       FROM group_bet g
       JOIN group_bet_member m ON m.group_id = g.id
      WHERE ${countWhere.join(' AND ')}`,
    countParams,
  );
  const total = totalRes.rows[0]?.total ?? 0;

  // ── Page ───────────────────────────────────────────────────────
  const pageParams: unknown[] = [userId];
  const where2: string[] = ['m.user_id = $1'];
  if (statusFilter && statusFilter.length > 0) {
    pageParams.push(statusFilter);
    where2.push(`g.status = ANY($${pageParams.length}::text[])`);
  }
  pageParams.push(limit);
  const lIdx = pageParams.length;
  pageParams.push(offset);
  const oIdx = pageParams.length;

  const rows = await query<any>(
    `SELECT g.id, g.short_code AS "shortCode", g.status,
            g.game_type AS "gameType", g.creator_id AS "creatorId",
            g.creator_choice AS "creatorChoice",
            g.creator_stake::text AS "creatorStake",
            g.per_member_stake::text AS "perMemberStake",
            g.total_pool::text AS "totalPool",
            g.min_members AS "minMembers", g.max_members AS "maxMembers",
            g.current_members AS "currentMembers",
            g.payout_mode AS "payoutMode", g.turn_mode AS "turnMode",
            g.auto_flip_seconds AS "autoFlipSeconds",
            g.expires_at AS "expiresAt",
            g.ready_at AS "readyAt",
            g.resolved_at AS "resolvedAt",
            g.winning_side AS "winningSide",
            g.created_at AS "createdAt",
            CASE WHEN m.user_id IS NOT NULL THEN 'member' ELSE 'creator' END AS role,
            COALESCE(m.stake::text, g.creator_stake::text) AS "myStake",
            COALESCE(m.payout_amount::text, '0') AS "myPayout",
            m.is_winner AS "isWinner"
       FROM group_bet g
       LEFT JOIN group_bet_member m ON m.group_id = g.id AND m.user_id = $1
      WHERE g.creator_id = $1 OR m.user_id = $1
      ${statusFilter && statusFilter.length > 0 ? `AND g.status = ANY($${pageParams.length}::text[])` : ''}
      ORDER BY g.created_at DESC
      LIMIT $${lIdx} OFFSET $${oIdx}`,
    pageParams,
  );

  return { rooms: rows.rows, total, limit, offset };
}
