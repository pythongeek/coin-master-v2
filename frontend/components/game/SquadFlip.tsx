'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  SQUAD FLIP — সামাজিক পুল বেটিং ফিচার
 * ═══════════════════════════════════════════════════════════════
 *
 *  বন্ধুরা মিলে একসাথে বেট করার ইউনিক ফিচার।
 *
 *  ফ্লো:
 *  ──────────────────────────────────────────────────────────────
 *  ১. কেউ একজন স্কোয়াড তৈরি করে (বেট পরিমাণ + পছন্দ ঠিক করে)
 *  ২. একটি ইনভাইট কোড/লিংক জেনারেট হয়
 *  ৩. বন্ধুরা সেই লিংকে ক্লিক করে যোগ দেয়
 *  ৪. ২+ জন হলে স্কোয়াড "রেডি" হয়ে যায়
 *  ৫. ক্রিয়েটর "ফ্লিপ" চাপলে কয়েন ঘোরে
 *  ৬. জিতলে সবার মধ্যে সমান ভাগে টাকা বণ্টন হয়
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useGameStore } from '@/lib/store';
import { getSocket } from '@/lib/socket';

interface SquadInfo {
  squadId:         string;
  creatorUsername?: string;
  betAmount:       number;
  choice?:         'heads' | 'tails';
  memberCount:     number;
  maxMembers:      number;
  isReady?:        boolean;
}

interface SquadResult {
  squadId:         string;
  result:          'heads' | 'tails';
  won:              boolean;
  totalPool:        number;
  perPersonPayout:  number;
  memberCount:      number;
}

export default function SquadFlip() {
  const { user, betAmount: defaultBet, currentChoice, updateBalance } = useGameStore();

  const [activeSquad, setActiveSquad] = useState<SquadInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [squadResult, setSquadResult] = useState<SquadResult | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [squadBetAmount, setSquadBetAmount] = useState(defaultBet);
  const [squadChoice, setSquadChoice] = useState<'heads' | 'tails'>(currentChoice);
  const [copied, setCopied] = useState(false);

  // ── সকেট ইভেন্ট শোনো ────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket(undefined);

    socket.on('squad:created', (info: SquadInfo) => {
      setActiveSquad(info);
      setCreating(false);
    });

    socket.on('squad:update', (info: SquadInfo) => {
      setActiveSquad(prev => prev ? { ...prev, ...info } : info);
    });

    socket.on('game:spinning', () => {
      if (activeSquad) setFlipping(true);
    });

    socket.on('squad:result', (result: SquadResult) => {
      setFlipping(false);
      setSquadResult(result);
    });

    socket.on('balance:update', (data: { balance: number }) => {
      updateBalance(data.balance);
    });

    return () => {
      socket.off('squad:created');
      socket.off('squad:update');
      socket.off('squad:result');
    };
  }, [activeSquad, updateBalance]);

  // ── নতুন স্কোয়াড তৈরি করো ───────────────────────────────────
  const createSquad = () => {
    if (!user) return;
    setCreating(true);
    const socket = getSocket(undefined);
    socket.emit('squad:create', { betAmount: squadBetAmount, choice: squadChoice });
  };

  // ── স্কোয়াডে যোগ দাও ────────────────────────────────────────
  const joinSquad = () => {
    if (!user || !joinCode.trim()) return;
    const socket = getSocket(undefined);
    socket.emit('squad:join', { squadId: joinCode.trim() });
  };

  // ── ইনভাইট লিংক কপি করো ────────────────────────────────────
  const copyInviteLink = () => {
    if (!activeSquad) return;
    const link = `${window.location.origin}/game?squad=${activeSquad.squadId}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── স্কোয়াড ফ্লিপ শুরু করো (শুধু ক্রিয়েটর) ───────────────────
  const startFlip = () => {
    if (!activeSquad || flipping) return;
    const socket = getSocket(undefined);
    socket.emit('squad:flip', { squadId: activeSquad.squadId });
  };

  // ── স্কোয়াড ছেড়ে দাও ───────────────────────────────────────
  const leaveSquad = () => {
    setActiveSquad(null);
    setSquadResult(null);
  };

  if (!user) {
    return (
      <div className="glass-card p-5 text-center border-neon-purple/20">
        <span className="text-3xl mb-2 block">👥</span>
        <p className="text-text-muted text-xs font-mono">স্কোয়াড ফ্লিপ খেলতে লগইন করুন</p>
      </div>
    );
  }

  // ── সক্রিয় স্কোয়াড থাকলে তার স্ট্যাটাস দেখাও ───────────────
  if (activeSquad) {
    const perPersonPayout = (activeSquad.betAmount * activeSquad.memberCount * 0.99 / activeSquad.memberCount).toFixed(2);

    // ── রেজাল্ট এসে গেলে আলাদা কার্ড দেখাও ──────────────────
    if (squadResult) {
      return (
        <div className={`glass-card p-6 text-center border-2 ${
          squadResult.won ? 'border-neon-green bg-neon-green/10' : 'border-neon-red bg-neon-red/10'
        }`}>
          <div className="text-5xl mb-2">{squadResult.won ? '🎉' : '😔'}</div>
          <div className={`heading-display text-xl mb-1 ${squadResult.won ? 'text-neon-green' : 'text-neon-red'}`}>
            {squadResult.won ? 'স্কোয়াড জিতেছে!' : 'স্কোয়াড হেরেছে!'}
          </div>
          <div className="text-text-secondary font-mono text-sm mb-3">
            {squadResult.result === 'heads' ? '👑 HEADS' : '🦅 TAILS'} | {squadResult.memberCount} জন সদস্য
          </div>
          {squadResult.won && (
            <div className="text-neon-green font-mono font-bold text-2xl mb-1">
              +${squadResult.perPersonPayout.toFixed(2)} <span className="text-sm">/ জন</span>
            </div>
          )}
          <button
            onClick={leaveSquad}
            className="mt-4 px-5 py-2 rounded-lg bg-neon-purple/20 border border-neon-purple/50
                       text-neon-purple text-sm font-mono hover:bg-neon-purple/30 transition-all"
          >
            🔄 নতুন স্কোয়াড তৈরি করুন
          </button>
        </div>
      );
    }

    return (
      <div className="glass-card p-5 border-neon-purple/30 bg-squad-gradient/5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="heading-display text-sm text-neon-purple">👥 স্কোয়াড ফ্লিপ</h3>
          <button onClick={leaveSquad} className="text-text-muted hover:text-neon-red text-xs">
            ✕ ছেড়ে দিন
          </button>
        </div>

        {/* মেম্বার প্রগ্রেস */}
        <div className="mb-4">
          <div className="flex justify-between text-xs font-mono text-text-muted mb-1">
            <span>সদস্য</span>
            <span>{activeSquad.memberCount} / {activeSquad.maxMembers}</span>
          </div>
          <div className="h-2 bg-void rounded-full overflow-hidden">
            <div
              className="h-full bg-squad-gradient transition-all duration-500"
              style={{ width: `${(activeSquad.memberCount / activeSquad.maxMembers) * 100}%` }}
            />
          </div>
        </div>

        {/* অবতার গ্রিড */}
        <div className="flex gap-2 mb-4">
          {Array.from({ length: activeSquad.maxMembers }).map((_, i) => (
            <div
              key={i}
              className={`w-10 h-10 rounded-full border-2 flex items-center justify-center text-lg
                ${i < activeSquad.memberCount
                  ? 'border-neon-purple bg-neon-purple/20'
                  : 'border-dashed border-border text-text-muted'
                }`}
            >
              {i < activeSquad.memberCount ? '👤' : '+'}
            </div>
          ))}
        </div>

        {/* পুল তথ্য */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-void rounded-lg p-2 text-center">
            <div className="text-text-muted text-xs font-mono">প্রতিজনের বেট</div>
            <div className="text-neon-purple font-mono font-bold">${activeSquad.betAmount.toFixed(2)}</div>
          </div>
          <div className="bg-void rounded-lg p-2 text-center">
            <div className="text-text-muted text-xs font-mono">মোট পুল</div>
            <div className="text-neon-gold font-mono font-bold">
              ${(activeSquad.betAmount * activeSquad.memberCount).toFixed(2)}
            </div>
          </div>
        </div>

        {/* জিতলে পাবে */}
        {activeSquad.memberCount >= 2 && (
          <div className="bg-neon-green/10 border border-neon-green/30 rounded-lg p-2 text-center mb-4">
            <span className="text-text-muted text-xs font-mono">জিতলে প্রতিজন পাবে: </span>
            <span className="text-neon-green font-mono font-bold">${perPersonPayout}</span>
          </div>
        )}

        {/* ইনভাইট লিংক */}
        <button
          onClick={copyInviteLink}
          className="w-full py-2 rounded-lg border border-neon-purple/40 text-neon-purple
                     text-xs font-mono hover:bg-neon-purple/10 transition-all mb-3"
        >
          {copied ? '✅ কপি হয়েছে!' : '🔗 ইনভাইট লিংক কপি করুন'}
        </button>

        {/* ফ্লিপ বাটন — ২+ জন হলেই সক্রিয় */}
        <button
          onClick={startFlip}
          disabled={activeSquad.memberCount < 2 || flipping}
          className="w-full py-3 rounded-xl bg-squad-gradient text-void font-display font-black
                     text-sm tracking-widest hover:scale-[1.02] transition-all
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {flipping
            ? '⏳ কয়েন ঘুরছে...'
            : activeSquad.memberCount < 2
            ? '⏳ আরো সদস্যের অপেক্ষায়...'
            : '🪙 স্কোয়াড ফ্লিপ শুরু করুন!'}
        </button>
      </div>
    );
  }

  // ── স্কোয়াড তৈরি বা যোগ দেওয়ার ফর্ম ───────────────────────
  return (
    <div className="glass-card p-5 border-neon-purple/20">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xl">👥</span>
        <h3 className="heading-display text-sm text-neon-purple">স্কোয়াড ফ্লিপ</h3>
      </div>
      <p className="text-text-muted text-xs font-mono mb-4">
        বন্ধুদের সাথে একসাথে বেট করুন — জিতলে সমান ভাগ!
      </p>

      <div className="space-y-3">
        {/* নতুন স্কোয়াড তৈরি */}
        <div className="bg-void rounded-lg p-3">
          <p className="text-text-secondary text-xs font-mono mb-2">নতুন স্কোয়াড তৈরি করুন</p>
          <div className="flex gap-2 mb-2">
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={squadBetAmount}
              onChange={(e) => setSquadBetAmount(parseFloat(e.target.value) || 0)}
              className="input-cyber flex-1 text-sm py-2"
              placeholder="বেট পরিমাণ ($)"
            />
            <select
              value={squadChoice}
              onChange={(e) => setSquadChoice(e.target.value as 'heads' | 'tails')}
              className="input-cyber text-sm py-2 w-28"
            >
              <option value="heads">👑 Heads</option>
              <option value="tails">🦅 Tails</option>
            </select>
          </div>
          <button
            onClick={createSquad}
            disabled={creating || squadBetAmount <= 0}
            className="w-full py-2 rounded-lg bg-neon-purple/20 border border-neon-purple/50
                       text-neon-purple text-sm font-mono hover:bg-neon-purple/30 transition-all
                       disabled:opacity-40"
          >
            {creating ? '⏳ তৈরি হচ্ছে...' : '+ স্কোয়াড তৈরি করুন'}
          </button>
        </div>

        {/* বিভাজক */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-border" />
          <span className="text-text-muted text-xs font-mono">অথবা</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* কোড দিয়ে যোগ দাও */}
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            className="input-cyber flex-1 text-sm py-2"
            placeholder="স্কোয়াড কোড পেস্ট করুন..."
          />
          <button
            onClick={joinSquad}
            disabled={!joinCode.trim()}
            className="px-4 py-2 rounded-lg border border-neon-blue/50 text-neon-blue text-sm
                       font-mono hover:bg-neon-blue/10 transition-all disabled:opacity-40"
          >
            যোগ দিন
          </button>
        </div>
      </div>
    </div>
  );
}
