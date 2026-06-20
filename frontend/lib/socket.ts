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

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4000';

// সিঙ্গেলটন সকেট ইন্সট্যান্স — শুধু একটিই থাকবে
let socket: Socket | null = null;

export function getSocket(token?: string): Socket {
  if (!socket || !socket.connected) {
    socket = io(SOCKET_URL, {
      auth: { token: token || getStoredToken() },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      console.log('✅ Socket কানেক্টেড:', socket?.id);
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
  }
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
