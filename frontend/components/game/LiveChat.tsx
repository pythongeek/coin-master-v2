'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  LIVE CHAT — রিয়েল-টাইম চ্যাট ও ক্রিপ্টো রেইন
 * ═══════════════════════════════════════════════════════════════
 *
 *  Socket.io দিয়ে চালিত লাইভ চ্যাট।
 *  Crypto Rain ট্রিগার হলে এখানে ক্লেইম বাটন দেখায়।
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useRef, useEffect } from 'react';
import { Users, CloudRain, Check, Loader2, Send, CheckCheck } from 'lucide-react';
import { useGameStore, ChatMessage } from '@/lib/store';
import { getSocket } from '@/lib/socket';

export default function LiveChat() {
  const {
    chatMessages, onlineCount, activeRain,
    hasClaimedRain, setHasClaimedRain, user,
  } = useGameStore();

  const [message, setMessage]   = useState('');
  const [claiming, setClaiming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // নতুন বার্তা আসলে নিচে স্ক্রোল করো
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── বার্তা পাঠাও ───────────────────────────────────────────
  const sendMessage = () => {
    if (!message.trim()) return;
    const socket = getSocket(undefined);
    socket.emit('chat:message', { message: message.trim() });
    setMessage('');
  };

  // ── Crypto Rain ক্লেইম করো ──────────────────────────────────
  const claimRain = async () => {
    if (!activeRain || hasClaimedRain || !user) return;
    setClaiming(true);

    const socket = getSocket(undefined);
    socket.emit('rain:claim', { rainId: activeRain.rainId });
    setHasClaimedRain(true);
    setClaiming(false);
  };

  // ── বার্তার রঙ ─────────────────────────────────────────────
  const msgColor = (type: ChatMessage['type']) => {
    if (type === 'win')  return 'text-brand-green';
    if (type === 'rain') return 'text-brand-gold';
    return 'text-text-primary';
  };

  const msgBg = (type: ChatMessage['type']) => {
    if (type === 'win')  return 'bg-brand-green/5 border-l-2 border-brand-green';
    if (type === 'rain') return 'bg-brand-gold/5 border-l-2 border-brand-gold';
    return '';
  };

  return (
    <div className="glass-card flex flex-col h-full" style={{ minHeight: '460px' }}>

      {/* ── হেডার ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse" />
          <span className="heading-display text-xs text-brand-green">LIVE CHAT</span>
        </div>
        <div className="flex items-center gap-1.5 text-text-muted text-xs font-mono">
          <Users size={13} />
          <span>{onlineCount.toLocaleString()} অনলাইন</span>
        </div>
      </div>

      {/* ── Crypto Rain ব্যানার ────────────────────────────── */}
      {activeRain && (
        <div className="mx-3 mt-3 rounded-xl border border-brand-gold/50 bg-brand-gold/10 p-3
                        animate-pulse-soft">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="heading-display text-xs text-brand-gold flex items-center gap-1.5">
                <CloudRain size={13} />
                CRYPTO RAIN চলছে
              </p>
              <p className="text-text-muted text-xs font-mono mt-0.5">
                মোট ${activeRain.totalAmount.toFixed(2)} |{' '}
                {activeRain.claimCount ?? 0}/{activeRain.maxClaims} ক্লেইম
              </p>
            </div>

            {user ? (
              hasClaimedRain ? (
                <span className="flex items-center gap-1 text-brand-green text-xs font-mono shrink-0">
                  <CheckCheck size={13} /> ক্লেইম হয়েছে
                </span>
              ) : (
                <button
                  onClick={claimRain}
                  disabled={claiming}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-gold text-void
                             font-display font-semibold text-xs hover:bg-brand-gold-dim
                             disabled:opacity-50 transition-all"
                >
                  {claiming ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  ক্লেইম করুন
                </button>
              )
            ) : (
              <span className="text-text-muted text-xs font-mono shrink-0">লগইন করুন</span>
            )}
          </div>

          {/* প্রগ্রেস বার */}
          <div className="mt-2 h-1 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-gold transition-all duration-500"
              style={{
                width: `${Math.min(
                  ((activeRain.claimCount ?? 0) / activeRain.maxClaims) * 100,
                  100
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* ── বার্তার তালিকা ─────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
        {chatMessages.length === 0 && (
          <p className="text-center text-text-muted text-xs font-mono py-8">
            চ্যাট শুরু করুন...
          </p>
        )}

        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`px-2 py-1 rounded text-xs leading-relaxed ${msgBg(msg.type)}`}
          >
            <span className="font-mono font-bold text-brand-info">{msg.username}: </span>
            <span className={`font-mono ${msgColor(msg.type)}`}>{msg.message}</span>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* ── বার্তা ইনপুট ───────────────────────────────────── */}
      <div className="px-3 pb-3 pt-2 border-t border-border">
        {user ? (
          <div className="flex gap-2">
            <input
              className="input-cyber flex-1 text-sm py-2"
              placeholder="বার্তা লিখুন..."
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 200))}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              maxLength={200}
              aria-label="চ্যাট বার্তা"
            />
            <button
              onClick={sendMessage}
              disabled={!message.trim()}
              className="px-3 py-2 rounded-lg bg-brand-green/15 border border-brand-green/30
                         text-brand-green hover:bg-brand-green/25 transition-all
                         disabled:opacity-40 flex items-center justify-center"
              aria-label="বার্তা পাঠান"
            >
              <Send size={15} />
            </button>
          </div>
        ) : (
          <p className="text-center text-text-muted text-xs font-mono py-1">
            চ্যাট করতে লগইন করুন
          </p>
        )}
      </div>
    </div>
  );
}
