/**
 * ═══════════════════════════════════════════════════════════════
 *  useSocketEvents — সকেট ইভেন্ট হুক
 * ═══════════════════════════════════════════════════════════════
 *
 *  এই হুক সকেট ইভেন্টগুলো Zustand স্টোরে ম্যাপ করে।
 *  গেম পেজে একবার মাউন্ট হলে সব ইভেন্ট চালু হয়।
 * ═══════════════════════════════════════════════════════════════
 */

'use client';

import { useEffect } from 'react';
import { getSocket } from './socket';
import { useGameStore, BetResult, ChatMessage, ActiveRain } from './store';
import { useSound } from '@/hooks/useSound';

export function useSocketEvents() {
  const { play } = useSound();
  const {
    token,
    setGameStatus, setLastResult, addToBetHistory,
    updateBalance, addChatMessage, setChatHistory,
    setOnlineCount, setActiveRain, updateRainClaims,
    addNotification,
  } = useGameStore();

  // In a tab or cross-page navigation the token may be in localStorage
  // but the active socket may still be a stale guest. Normalize by
  // always creating the socket with the latest token whenever the
  // token value changes (or on first mount).
  useEffect(() => {
    const socket = getSocket(token || undefined);

    // ── সার্ভার থেকে ইনিশিয়াল ডেটা ─────────────────────────────
    socket.on('init', (data: { onlineCount: number; chatHistory: ChatMessage[] }) => {
      setOnlineCount(data.onlineCount);
      setChatHistory(data.chatHistory);
    });

    // ── অনলাইন সংখ্যা আপডেট ─────────────────────────────────────
    socket.on('online:count', (count: number) => {
      setOnlineCount(count);
    });

    // ── কয়েন ঘুরছে ──────────────────────────────────────────────
    socket.on('game:spinning', () => {
      setGameStatus('spinning');
    });

    // ── গেম রেজাল্ট এসেছে ───────────────────────────────────────
    socket.on('game:result', (result: BetResult) => {
      setGameStatus('result');
      setLastResult(result);
      addToBetHistory(result);
      updateBalance(result.newBalance);
      addNotification(result.message, result.won ? 'win' : 'lose');
      play(result.won ? 'win' : 'lose');
    });

    // ── ব্যালেন্স আপডেট ──────────────────────────────────────────
    socket.on('balance:update', (data: { balance: number }) => {
      updateBalance(data.balance);
    });

    // ── এরর ───────────────────────────────────────────────────
    socket.on('game:error', (data: { message: string }) => {
      setGameStatus('idle');
      addNotification(`❌ ${data.message}`, 'info');
    });

    // ── চ্যাট বার্তা ─────────────────────────────────────────────
    socket.on('chat:message', (msg: ChatMessage) => {
      addChatMessage(msg);
    });

    // ── Crypto Rain শুরু ──────────────────────────────────────────
    socket.on('rain:started', (rain: ActiveRain) => {
      setActiveRain(rain);
      addNotification('🌧️ CRYPTO RAIN! দ্রুত ক্লেইম করুন!', 'rain');
      play('rain');
    });

    // ── Rain আপডেট ───────────────────────────────────────────────
    socket.on('rain:update', (data: { claimCount: number }) => {
      updateRainClaims(data.claimCount);
    });

    // ── Rain ক্লেইম সফল ───────────────────────────────────────────
    socket.on('rain:claimed', (data: { amount: number }) => {
      addNotification(`💸 +$${data.amount.toFixed(2)} রেইন থেকে পেয়েছেন!`, 'rain');
    });

    // Cleanup: কম্পোনেন্ট আনমাউন্ট হলে ইভেন্ট সরাও
    return () => {
      socket.off('init');
      socket.off('online:count');
      socket.off('game:spinning');
      socket.off('game:result');
      socket.off('balance:update');
      socket.off('game:error');
      socket.off('chat:message');
      socket.off('rain:started');
      socket.off('rain:update');
      socket.off('rain:claimed');
    };
  }, [token]);
}
