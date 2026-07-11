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

import { useEffect, useRef } from 'react';
import { getSocket } from './socket';
import { useGameStore, BetResult, ChatMessage, ActiveRain, ScatterResult } from './store';
import { useSound } from '@/hooks/useSound';

export function useSocketEvents() {
  const { play } = useSound();
  const store = useGameStore();
  const storeRef = useRef(store);
  storeRef.current = store;

  // Subscribe once on mount. Token changes are pushed via refreshSocketToken(),
  // so the socket singleton never disconnects/reconnects just because auth changes.
  useEffect(() => {
    const socket = getSocket();

    const onInit = (data: { onlineCount: number; chatHistory: ChatMessage[] }) => {
      storeRef.current.setOnlineCount(data.onlineCount);
      storeRef.current.setChatHistory(data.chatHistory);
    };

    const onOnlineCount = (count: number) => {
      storeRef.current.setOnlineCount(count);
    };

    const onSpinning = () => {
      storeRef.current.setGameStatus('spinning');
    };

    const onResult = (result: BetResult) => {
      storeRef.current.setGameStatus('result');
      storeRef.current.setLastResult(result);
      storeRef.current.addToBetHistory(result);
      storeRef.current.updateBalance(result.newBalance);
      storeRef.current.addNotification(result.message, result.won ? 'win' : 'lose');
      play(result.won ? 'win' : 'lose');
      if (result.scatter?.triggered) {
        storeRef.current.setPendingScatter(result);
      }
    };

    const onScatterResult = (scatter: ScatterResult) => {
      storeRef.current.setActiveScatter(scatter);
      storeRef.current.setPendingScatter(null);
      storeRef.current.updateBalance(scatter.newBalance);
      storeRef.current.addNotification(scatter.message, 'win');
      play('win');
    };

    const onBalanceUpdate = (data: { balance: number }) => {
      storeRef.current.updateBalance(data.balance);
    };

    const onError = (data: { message: string }) => {
      storeRef.current.setGameStatus('idle');
      storeRef.current.addNotification(`❌ ${data.message}`, 'info');
    };

    const onChatMessage = (msg: ChatMessage) => {
      storeRef.current.addChatMessage(msg);
    };

    const onRainStarted = (rain: ActiveRain) => {
      storeRef.current.setActiveRain(rain);
      storeRef.current.addNotification('🌧️ CRYPTO RAIN! দ্রুত ক্লেইম করুন!', 'rain');
      play('rain');
    };

    const onRainUpdate = (data: { claimCount: number }) => {
      storeRef.current.updateRainClaims(data.claimCount);
    };

    const onRainClaimed = (data: { amount: number }) => {
      storeRef.current.addNotification(`💸 +$${data.amount.toFixed(2)} রেইন থেকে পেয়েছেন!`, 'rain');
    };

    socket.on('init', onInit);
    socket.on('online:count', onOnlineCount);
    socket.on('game:spinning', onSpinning);
    socket.on('game:result', onResult);
    socket.on('scatter:result', onScatterResult);
    socket.on('balance:update', onBalanceUpdate);
    socket.on('game:error', onError);
    socket.on('chat:message', onChatMessage);
    socket.on('rain:started', onRainStarted);
    socket.on('rain:update', onRainUpdate);
    socket.on('rain:claimed', onRainClaimed);

    return () => {
      socket.off('init', onInit);
      socket.off('online:count', onOnlineCount);
      socket.off('game:spinning', onSpinning);
      socket.off('game:result', onResult);
      socket.off('scatter:result', onScatterResult);
      socket.off('balance:update', onBalanceUpdate);
      socket.off('game:error', onError);
      socket.off('chat:message', onChatMessage);
      socket.off('rain:started', onRainStarted);
      socket.off('rain:update', onRainUpdate);
      socket.off('rain:claimed', onRainClaimed);
    };
  }, [play]);
}
