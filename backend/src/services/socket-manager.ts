/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET MANAGER — thin orchestrator (P2-14)
 *  ─────────────────────────────────────────────────────────────
 *
 *  Prior to P2-14, this file was a 698-line monolith containing all
 *  socket event handlers inline. P2-14 split the handlers into
 *  domain modules:
 *
 *    - `socket-shared.ts`    — shared state (onlineUsers, chatHistory,
 *                              delay, addToChatHistory, getActiveRain)
 *    - `socket-lifecycle.ts` — connection, auth, disconnect, online count
 *    - `socket-game.ts`      — game:bet, scatter:pick, chat:message
 *    - `socket-rain.ts`      — rain:claim
 *    - `socket-squad.ts`     — squad:create, squad:join, squad:flip
 *    - `socket-streak.ts`    — streak:bank
 *
 *  `socket-manager.ts` is now a 30-line orchestrator that wires the
 *  lifecycle handlers to the io instance, and per-socket domain
 *  handlers when each connection is established.
 *
 *  Why split?
 *    - Each file is now < 600 lines (the limit specified by P2-14).
 *    - Domain logic is co-located — a change to the squad flow
 *      doesn't accidentally affect chat.
 *    - Easier to reason about, test, and reason about dependencies.
 *    - The shared state module documents the cross-cutting
 *      concerns (online presence, chat history) that any new
 *      domain module must respect.
 *
 *  Backward compatibility:
 *    - The exported `setupSocketHandlers(io)` signature is unchanged.
 *      No consumer of this module needs to change.
 *    - All socket event names and payload shapes are unchanged.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AuthPayload } from '../middleware/auth';
import { registerLifecycleHandlers, type SocketData } from './socket-lifecycle';
import { registerGameHandlers } from './socket-game';
import { registerRainHandlers } from './socket-rain';
import { registerSquadHandlers } from './socket-squad';
import { registerStreakHandlers } from './socket-streak';
import { registerGroupBetHandlers, setGroupBetIo } from './socket-group-bet';

export function setupSocketHandlers(io: SocketIOServer): void {
  // Register the io singleton so domain services (createGroupBet, joinGroupBet,
  // flipGroup, groupBetExpiry, groupBetLeave) can emit room events without
  // importing the io instance directly.
  setGroupBetIo(io);

  // Set up connection lifecycle (auth middleware + disconnect cleanup).
  // This MUST run before per-socket handlers below so socket.data.user
  // is populated by the time domain handlers read it.
  registerLifecycleHandlers(io);

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const user = data.user;
    const displayName = user
      ? user.username
      : `Guest_${socket.id.slice(0, 4)}`;

    // Register domain handlers for this socket. Each handler module
    // owns its own events and emits via the shared `io` instance.
    registerGameHandlers(io, socket, user, displayName);
    registerRainHandlers(io, socket, user);
    registerSquadHandlers(io, socket, user);
    registerStreakHandlers(socket, user);
    registerGroupBetHandlers(io, socket, user);
  });
}
