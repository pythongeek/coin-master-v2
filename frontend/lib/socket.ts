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
import { setTokenCookie, clearTokenCookie } from './auth-cookies';

function getSocketUrl(): string {
  if (typeof window === 'undefined') {
    if (!process.env.NEXT_PUBLIC_SOCKET_URL) {
      throw new Error('NEXT_PUBLIC_SOCKET_URL is required for server-side socket URL resolution');
    }
    return process.env.NEXT_PUBLIC_SOCKET_URL;
  }
  // Allow NEXT_PUBLIC_SOCKET_URL to override (e.g. staging).
  if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
  // Production: use same origin so nginx proxies /socket.io
  return window.location.origin;
}

// সিঙ্গেলটন সকেট ইন্সট্যান্স — শুধু একটিই থাকবে
let socket: Socket | null = null;
let currentToken: string | null = null;

/**
 * Return the singleton socket. If the socket doesn't exist, is disconnected,
 * or the requested token differs from the token used to create the current
 * connection, a new socket is created with the correct auth token.
 */
export function getSocket(token?: string): Socket {
  const targetToken = token ?? getStoredToken();
  const tokenChanged = currentToken !== targetToken;

  if (!socket || !socket.connected || tokenChanged) {
    if (socket) {
      socket.disconnect();
      socket = null;
    }

    currentToken = targetToken;
    const socketUrl = getSocketUrl();
    socket = io(socketUrl, {
      auth: targetToken ? { token: targetToken } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.5,
      timeout: 20000,
      // Use same path the backend expects; path is automatically /socket.io
      withCredentials: true,
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

export function reconnectWithToken(token: string) {
  return getSocket(token);
}

// LocalStorage থেকে token পড়ো
function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cf_token');
}

// Token সেভ করো (localStorage + cookie so SSR can read it)
export function storeToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('cf_token', token);
    setTokenCookie(token);
  }
}

export function clearToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('cf_token');
    clearTokenCookie();
  }
}


