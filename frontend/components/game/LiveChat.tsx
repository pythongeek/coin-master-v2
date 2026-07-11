'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  LIVE CHAT — রিয়েল-টাইম চ্যাট ও লাইভ উইন স্ট্যাটস
 * ═══════════════════════════════════════════════════════════════
 *
 *  Socket.io দিয়ে চালিত লাইভ চ্যাট ও বিগ উইন ট্র্যাকার।
 *  Crypto Rain ক্লেইম করার প্যানেল এবং বিগ উইনস ফিল্টার।
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useRef, useEffect } from 'react';
import { Users, CloudRain, Check, Loader2, Send, CheckCheck, Trophy } from 'lucide-react';
import { useGameStore, ChatMessage } from '@/lib/store';
import { emitSocket } from '@/lib/socket';

export default function LiveChat() {
  const {
    chatMessages, onlineCount, activeRain,
    hasClaimedRain, setHasClaimedRain, user,
  } = useGameStore();

  const [activeTab, setActiveTab] = useState<'chat' | 'stats'>('chat');
  const [message, setMessage]   = useState('');
  const [claiming, setClaiming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // নতুন বার্তা আসলে নিচে স্ক্রোল করো
  useEffect(() => {
    if (activeTab === 'chat') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, activeTab]);

  // ── বার্তা পাঠাও ───────────────────────────────────────────
  const sendMessage = () => {
    if (!message.trim()) return;
    emitSocket('chat:message', { message: message.trim() });
    setMessage('');
  };

  // ── Crypto Rain ক্লেইম করো ──────────────────────────────────
  const claimRain = async () => {
    if (!activeRain || hasClaimedRain || !user) return;
    setClaiming(true);

    emitSocket('rain:claim', { rainId: activeRain.rainId });
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

  // ফিল্টার করা উইন মেসেজ সমূহ
  const winMessages = chatMessages.filter(
    (msg) => msg.type === 'win' || msg.type === 'rain'
  );

  return (
    <div className="glass-card flex flex-col h-full" style={{ minHeight: '460px', height: '100%' }}>

      {/* ── হেডার ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface/50">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse" />
          <span className="heading-display text-xs text-brand-green">COMMUNITY</span>
        </div>
        <div className="flex items-center gap-1.5 text-text-muted text-xs font-mono">
          <Users size={13} />
          <span>{onlineCount.toLocaleString()} online</span>
        </div>
      </div>

      {/* ── ট্যাবস ─────────────────────────────────────────── */}
      <div className="flex bg-surface2 border-b border-border p-1">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex-1 py-1.5 text-center text-xs font-display font-semibold rounded-lg transition-all ${
            activeTab === 'chat'
              ? 'bg-surface text-brand-green border border-border shadow-elevate-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          LIVE CHAT
        </button>
        <button
          onClick={() => setActiveTab('stats')}
          className={`flex-1 py-1.5 text-center text-xs font-display font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
            activeTab === 'stats'
              ? 'bg-surface text-brand-green border border-border shadow-elevate-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Trophy size={12} />
          BIG WINS
        </button>
      </div>

      {/* ── Crypto Rain ব্যানার (চ্যাট ট্যাব সক্রিয় থাকলেই দেখাবে) ── */}
      {activeRain && activeTab === 'chat' && (
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
                  Claim
                </button>
              )
            ) : (
              <span className="text-text-muted text-xs font-mono shrink-0">Log in</span>
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

      {/* ── কন্টেন্ট এরিয়া ───────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 min-h-0">
        
        {/* চ্যাট মোড */}
        {activeTab === 'chat' && (
          <>
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
          </>
        )}

        {/* উইন স্ট্যাটস মোড */}
        {activeTab === 'stats' && (
          <div className="space-y-2 py-1 animate-fade-in">
            {winMessages.length === 0 ? (
              <p className="text-center text-text-muted text-xs font-mono py-8">
                কোনো বিগ উইন রেকর্ড পাওয়া যায়নি।
              </p>
            ) : (
              winMessages.slice().reverse().map((msg) => (
                <div 
                  key={msg.id} 
                  className={`p-3 border rounded-xl flex items-center justify-between gap-3 shadow-elevate-sm transition-all ${
                    msg.type === 'win' 
                      ? 'border-brand-green/20 bg-brand-green/[0.02]' 
                      : 'border-brand-gold/20 bg-brand-gold/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${
                      msg.type === 'win' 
                        ? 'border-brand-green/25 bg-brand-green/10 text-brand-green' 
                        : 'border-brand-gold/25 bg-brand-gold/10 text-brand-gold'
                    }`}>
                      {msg.type === 'win' ? <Trophy size={14} /> : <CloudRain size={14} />}
                    </div>
                    <div>
                      <p className="font-mono text-xs font-bold text-text-primary">{msg.username}</p>
                      <p className="text-[9px] text-text-muted font-mono">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`font-mono text-xs font-bold ${
                      msg.type === 'win' ? 'text-brand-green' : 'text-brand-gold'
                    }`}>
                      {msg.type === 'win' ? 'WIN' : 'RAIN'}
                    </p>
                    <p className="text-[10px] text-text-secondary font-mono leading-none">
                      {msg.message.replace(/🎉|💸/g, '').trim()}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Chat message ইনপুট (শুধুমাত্র চ্যাট ট্যাব সক্রিয় থাকলেই দেখাবে) ── */}
      {activeTab === 'chat' && (
        <div className="px-3 pb-3 pt-2 border-t border-border bg-surface/50">
          {user ? (
            <div className="flex gap-2">
              <input
                className="input-cyber flex-1 text-sm py-2"
                placeholder="বার্তা লিখুন..."
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 200))}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                maxLength={200}
                aria-label="Chat message"
              />
              <button
                onClick={sendMessage}
                disabled={!message.trim()}
                className="px-3 py-2 rounded-lg bg-brand-green/15 border border-brand-green/30
                           text-brand-green hover:bg-brand-green/25 transition-all
                           disabled:opacity-40 flex items-center justify-center shrink-0"
                aria-label="Send"
              >
                <Send size={15} />
              </button>
            </div>
          ) : (
            <p className="text-center text-text-muted text-xs font-mono py-1">
              Log in to chat
            </p>
          )}
        </div>
      )}
    </div>
  );
}
