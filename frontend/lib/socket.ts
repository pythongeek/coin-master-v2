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

function getSocketUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  const host = window.location.host;
  if (host.startsWith('localhost:') || host === 'localhost') {
    return 'http://localhost:4000';
  }
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

// Expose for debugging / console smoke tests
if (typeof window !== 'undefined') {
  (window as any).__getSocket = getSocket;
}
