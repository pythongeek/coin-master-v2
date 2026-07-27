/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET LIFECYCLE — connection, auth, disconnect, online count
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14. Owns the per-socket setup that EVERY other domain depends
 *  on:
 *    - JWT auth (`io.use` middleware, `auth:token` event)
 *    - Online user tracking (Map inserts/deletes)
 *    - Initial `init` payload (onlineCount + chatHistory)
 *    - `online:count` broadcasts
 *    - `disconnect` cleanup
 *
 *  Returns a `socket.data` shape that downstream domain handlers
 *  can read safely.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, AuthPayload } from '../middleware/auth';
import { onlineUsers, chatHistory } from './socket-shared';

/**
 * Per-socket session context. Set by the JWT middleware (`io.use`)
 * and updated by the `auth:token` event. Downstream handlers read
 * `socket.data.user` to know who's calling.
 */
export interface SocketData {
  user: AuthPayload | null;
  isGuest: boolean;
}

export function registerLifecycleHandlers(io: SocketIOServer): void {
  // JWT auth middleware — runs BEFORE every connection.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      // Guest mode — can view but not play.
      (socket.data as SocketData).user = null;
      (socket.data as SocketData).isGuest = true;
      return next();
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload;
      (socket.data as SocketData).user = decoded;
      (socket.data as SocketData).isGuest = false;
      next();
    } catch {
      (socket.data as SocketData).user = null;
      (socket.data as SocketData).isGuest = true;
      next();
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const user = data.user;
    const displayName = user
      ? user.username
      : `Guest_${socket.id.slice(0, 4)}`;

    // Allow re-authenticating on an existing socket without reconnecting.
    socket.on('auth:token', (payload: { token?: string }) => {
      if (!payload?.token) {
        data.user = null;
        data.isGuest = true;
        return;
      }
      try {
        const decoded = jwt.verify(payload.token, JWT_SECRET) as AuthPayload;
        data.user = decoded;
        data.isGuest = false;
        onlineUsers.set(socket.id, {
          userId: decoded.userId,
          username: decoded.username,
          socketId: socket.id,
        });
      } catch {
        data.user = null;
        data.isGuest = true;
      }
    });

    // Add to online list if authenticated.
    if (user) {
      onlineUsers.set(socket.id, {
        userId: user.userId,
        username: user.username,
        socketId: socket.id,
      });
    }

    // eslint-disable-next-line no-console
    console.log(`Connected: ${displayName} (${socket.id})`);

    // Send initial state to the new client.
    socket.emit('init', {
      onlineCount: onlineUsers.size,
      chatHistory: chatHistory.slice(-30),
      isGuest: data.isGuest,
    });

    // Broadcast online count to everyone.
    io.emit('online:count', onlineUsers.size);

    // Cleanup on disconnect.
    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id);
      io.emit('online:count', onlineUsers.size);
    });
  });
}
