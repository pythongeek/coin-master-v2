/**
 * ════════════════════════════════════════════════════════════════
 *  SOCKET-GROUP-BET — Real-time events for multiplayer rooms
 *  ════════════════════════════════════════════════════════════════
 *
 *  Implements the 11 socket events listed in Phase 1 §7:
 *
 *    Client → server:                  Server → room:
 *    ─────────────────                 ────────────────
 *    group:spectate   join by id       group:created        (room broadcast)
 *    group:invite_share log a share    group:join           (room broadcast)
 *                                     group:leave          (room broadcast)
 *                                     group:ready          (room broadcast)
 *                                     group:flip_start     (room broadcast)
 *                                     group:resolved       (room broadcast)
 *                                     group:cancelled      (room broadcast)
 *                                     group:expired        (room broadcast)
 *                                     group:frozen         (room broadcast)
 *                                     group:updated        (room broadcast)
 *
 *  Architecture:
 *    - `emitGroupBetEvent(eventName, payload)` is the SERVER-side
 *      emit helper that domain services call (createGroupBet, joinGroupBet,
 *      flipGroup, groupBetExpiry, groupBetLeave). It broadcasts to
 *      `group_<groupId>` room.
 *    - `registerGroupBetHandlers(io, socket, user)` is the client-side
 *      handler registration that runs on each socket.io connection.
 *      It registers `group:spectate` and `group:invite_share` listeners.
 *
 *  No domain service imports this file directly — domain services use
 *  the singleton `getGroupBetIo()` accessor pattern via emitGroupBetEvent.
 *
 *  Room name convention: `group_<groupId>` (matches squad's `squad_<id>`).
 * ════════════════════════════════════════════════════════════════
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { query } from '../config/database';
import { AuthPayload } from '../middleware/auth';

// ─── Singleton IO accessor ────────────────────────────────────
let _io: SocketIOServer | null = null;

export function setGroupBetIo(io: SocketIOServer): void {
  _io = io;
}

export function getGroupBetIo(): SocketIOServer | null {
  return _io;
}

// ─── Event taxonomy (server → room) ────────────────────────────
export type GroupBetServerEvent =
  | 'group:created'
  | 'group:join'
  | 'group:leave'
  | 'group:ready'
  | 'group:flip_start'
  | 'group:resolved'
  | 'group:cancelled'
  | 'group:expired'
  | 'group:frozen'
  | 'group:updated';

export interface GroupBetEventPayload {
  groupId: string;
  shortCode?: string;
  status?: string;
  currentMembers?: number;
  maxMembers?: number;
  totalPool?: number;
  winningSide?: 'heads' | 'tails';
  actorUserId?: string;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

// ─── Server-side emit helper (called by domain services) ──────
export function emitGroupBetEvent(
  eventName: GroupBetServerEvent,
  payload: GroupBetEventPayload,
): boolean {
  if (!_io) {
    // Socket.io not initialized yet (e.g., during boot or test).
    // Domain services should not crash on this — return false so the
    // caller can decide whether to log a warning.
    return false;
  }
  const room = `group_${payload.groupId}`;
  _io.to(room).emit(eventName, { ...payload, ts: new Date().toISOString() });
  return true;
}

// ─── Client-side handler registration ──────────────────────────
export function registerGroupBetHandlers(
  io: SocketIOServer,
  socket: Socket,
  user: AuthPayload | null,
): void {
  // ── group:spectate — non-member joins the room for live updates ─
  // Auth required (so we know who is watching for rate-limit / fraud).
  socket.on('group:spectate', async (data: { groupId?: string; shortCode?: string }) => {
    if (!user) {
      socket.emit('group:error', { code: 'AUTH_REQUIRED', message: 'Login required to spectate.' });
      return;
    }
    const groupId = data?.groupId;
    const shortCode = data?.shortCode;
    if (!groupId && !shortCode) {
      socket.emit('group:error', { code: 'BAD_REQUEST', message: 'groupId or shortCode required.' });
      return;
    }

    try {
      // Resolve shortCode → groupId if needed
      let gid = groupId;
      if (!gid && shortCode) {
        const r = await query<{ id: string }>(`SELECT id FROM group_bet WHERE short_code = $1 LIMIT 1`, [shortCode]);
        if (!r.rows.length) {
          socket.emit('group:error', { code: 'GROUP_NOT_FOUND', message: 'Group not found.' });
          return;
        }
        gid = r.rows[0].id;
      }

      const room = `group_${gid}`;
      socket.join(room);

      // Send a snapshot to the spectator so their UI can render immediately
      const g = await query<any>(
        `SELECT id, short_code, status, current_members, max_members,
                total_pool::text AS total_pool, payout_mode, turn_mode,
                creator_choice, expires_at, is_frozen, fraud_score
           FROM group_bet WHERE id = $1`,
        [gid],
      );
      if (g.rows.length) {
        socket.emit('group:joined', {
          groupId: gid,
          shortCode: g.rows[0].short_code,
          status: g.rows[0].status,
          currentMembers: g.rows[0].current_members,
          maxMembers: g.rows[0].max_members,
          totalPool: parseFloat(g.rows[0].total_pool),
          payoutMode: g.rows[0].payout_mode,
          turnMode: g.rows[0].turn_mode,
          creatorChoice: g.rows[0].creator_choice,
          expiresAt: g.rows[0].expires_at,
          isFrozen: g.rows[0].is_frozen,
          fraudScore: g.rows[0].fraud_score,
          spectator: true,
          ts: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error('[socket-group-bet] spectate failed:', err?.message);
      socket.emit('group:error', { code: 'INTERNAL', message: 'Spectate failed.' });
    }
  });

  // ── group:invite_share — log when a user shares the invite link ─
  socket.on('group:invite_share', async (data: { groupId?: string; channel?: string }) => {
    if (!user) {
      socket.emit('group:error', { code: 'AUTH_REQUIRED', message: 'Login required.' });
      return;
    }
    const groupId = data?.groupId;
    const channel = (data?.channel || 'unknown').slice(0, 20);
    if (!groupId) {
      socket.emit('group:error', { code: 'BAD_REQUEST', message: 'groupId required.' });
      return;
    }
    try {
      await query(
        `INSERT INTO group_bet_invite
           (group_id, inviter_id, channel, ip_address, user_agent)
         VALUES ($1, $2, $3, $4::inet, $5)`,
        [
          groupId,
          user.userId,
          channel,
          (typeof socket.handshake?.address === 'string' ? socket.handshake.address : null),
          (socket.handshake?.headers?.['user-agent'] as string | undefined)?.slice(0, 200) ?? null,
        ],
      );
      socket.emit('group:invite_logged', { groupId, channel, ts: new Date().toISOString() });
    } catch (err: any) {
      console.error('[socket-group-bet] invite_share failed:', err?.message);
      socket.emit('group:error', { code: 'INTERNAL', message: 'Failed to log invite share.' });
    }
  });

  // ── group:unspectate — leave the room when done watching ───────
  socket.on('group:unspectate', (data: { groupId?: string }) => {
    if (!data?.groupId) return;
    socket.leave(`group_${data.groupId}`);
  });
}

// ─── Cleanup on disconnect ──────────────────────────────────────
export function leaveAllGroupBetRooms(socket: Socket): void {
  for (const room of socket.rooms) {
    if (room.startsWith('group_')) socket.leave(room);
  }
}