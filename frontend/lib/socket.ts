/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET CLIENT — ফ্রন্টএন্ড সকেট কানেকশন ম্যানেজার
 * ═══════════════════════════════════════════════════════════════
 *
 *  একটিমাত্র সকেট কানেকশন পুরো অ্যাপে শেয়ার হয়।
 *  কম্পোনেন্ট মাউন্ট/আনমাউন্টে কানেকশন নষ্ট হয় না।
 * ═══════════════════════════════════════════════════════════════
 */

import { io, Socket } from 'socket.io-client';

// SOCKET_URL uses NEXT_PUBLIC_SOCKET_URL (defaults to localhost:4000).
// For local-dev (browser on cx23): the bundle talks to the backend
// directly. For tunnel users (browser hits the cloudflare quick
// tunnel): the browser tries ws://localhost:4000/socket.io/ which
// fails because localhost from the browser's perspective is THEIR
// own machine, not cx23. Tunnel-mode WebSocket proxy would require
// a custom server.js (rewrites() in next.config.js doesn't reliably
// pass through WebSocket upgrades in dev mode) — deferred to a
// future commit. The current code matches what was on disk before
// this session.
// Hardcoded public socket endpoint for cx23 production host.
// The dev-server env var was unreliable, so we match the actual host.
const getSocketUrl = (): string => {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  const host = window.location.host;
  if (host.startsWith('localhost:') || host === 'localhost') {
    return process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4000';
  }
  // Production VM: always use port 3003 where nginx proxies /socket.io
  return 'http://46.62.247.167:3003';
};

const SOCKET_URL = getSocketUrl();

console.log('[socket] SOCKET_URL=', SOCKET_URL, 'host=', typeof window !== 'undefined' ? window.location.host : 'ssr');

// সিঙ্গেলটন সকেট ইন্সট্যান্স — শুধু একটিই থাকবে
let socket: Socket | null = null;
let currentToken: string | null = null;

/**
 * Return the singleton socket. If the socket doesn't exist, is disconnected,
 * or the requested token differs from the token used to create the current
 * connection, a new socket is created with the correct auth token.
 *
 * This prevents the "logged in but socket still guest" bug that happens
 * when a guest socket is created before login and then reused after login.
 */
export function getSocket(token?: string): Socket {
  const targetToken = token ?? getStoredToken();

  // Force reconnect when the token changes so the server sees the new auth.
  const tokenChanged = currentToken !== targetToken;

  if (!socket || !socket.connected || tokenChanged) {
    // Disconnect any stale socket before creating a new one.
    if (socket) {
      socket.disconnect();
      socket = null;
    }

    currentToken = targetToken;
    socket = io(SOCKET_URL, {
      auth: targetToken ? { token: targetToken } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      const id = socket?.id ?? null;
      console.log('✅ Socket কানেক্টেড:', id, 'authed:', !!targetToken);
    });

    socket.on('disconnect', (reason) => {
      console.log('❌ Socket ডিসকানেক্টেড:', reason);
    });

    socket.on('connect_error', (err) => {
      console.error('🔌 Socket কানেক্ট এরর:', err.message);
    });
  }

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
    currentToken = null;
  }
}

/**
 * Reconnect the singleton socket with a specific token.
 * Used after login to upgrade an existing guest socket to an authed one.
 */
export function reconnectWithToken(token: string) {
  return getSocket(token);
}

// LocalStorage থেকে token পড়ো
function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cf_token');
}

// Token সেভ করো
export function storeToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('cf_token', token);
  }
}

export function clearToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('cf_token');
    localStorage.removeItem('cf_user');
  }
}
