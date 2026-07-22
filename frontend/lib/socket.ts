'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET CLIENT — true singleton, never recreated per token
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. One global Socket.IO instance for the whole browser session.
 *  2. The token is sent on connect via `auth.token` and refreshed by
 *     calling `refreshSocketToken()` without disconnecting.
 *  3. Components never import getSocket() to attach ad-hoc listeners;
 *     they use useSocketEvents() or the exported emit helpers.
 * ═══════════════════════════════════════════════════════════════
 */

import { io, Socket } from 'socket.io-client';
import { getTokenFromStorage } from './store';

let socket: Socket | null = null;
let currentToken: string | undefined;

function getSocketUrl(): string {
  if (typeof window === 'undefined') return '';

  const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isDev) {
    // Local dev: talk to backend directly on :4000
    return process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
  }

  // Production: connect directly to the backend's socket.io endpoint.
  // The Next.js /api catch-all proxy does HTTP fine but CANNOT proxy
  // WebSocket upgrades, so the browser must connect to port 4000
  // (which is publicly exposed at 46.62.247.167:4000 per
  // docker-compose.yml). The CSP allows it (see
  // backend/src/middleware/security.ts: helmetConfig.connectSrc).
  //
  // NEXT_PUBLIC_SOCKET_URL lets ops override the host (e.g. if you
  // put nginx in front and route /socket.io/* there). When unset we
  // derive http(s):// from the current page hostname + port 4000.
  const override = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SOCKET_URL) || '';
  if (override) return override;
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'https' : 'http';
  return `${proto}://${loc.hostname}:4000`;
}

function createSocket(): Socket {
  const url = getSocketUrl();
  currentToken = getTokenFromStorage() || undefined;

  const instance = io(url, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: { token: currentToken },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 20000,
    withCredentials: true,
  });

  instance.on('connect', () => {
    console.log('✅ Socket connected:', instance.id);
  });

  instance.on('disconnect', (reason) => {
    console.log('❌ Socket disconnected:', reason);
  });

  instance.on('connect_error', (err) => {
    console.error('Socket connect error:', err.message);
  });

  return instance;
}

export function getSocket(): Socket {
  if (!socket) {
    socket = createSocket();
  }
  return socket;
}

/** Update the auth token without tearing down the socket. */
export function refreshSocketToken(token?: string) {
  currentToken = token;
  if (socket?.connected) {
    socket.emit('auth:token', { token });
  }
}

export function clearSocketToken() {
  refreshSocketToken(undefined);
}

// Re-export a simple emit helper for components that only need to send events.
export function emitSocket(event: string, ...args: any[]) {
  getSocket().emit(event, ...args);
}


// Backward-compatible aliases for legacy imports.
export function storeToken(_token: string) {
  // Tokens are now refreshed via refreshSocketToken(); this alias is a no-op.
}

export function reconnectWithToken(token?: string) {
  refreshSocketToken(token);
}

export function clearToken() {
  clearSocketToken();
}
