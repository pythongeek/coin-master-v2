'use client';

import { useState, useEffect } from 'react';
import { MessageSquare, Trophy, SlidersHorizontal, X } from 'lucide-react';
import LiveChat from './LiveChat';
import BigWinsPanel from './BigWinsPanel';
import BetControls from './BetControls';
import PromoWidget from './PromoWidget';
import AffiliatePanel from './AffiliatePanel';
import ProvablyFairWidget from './ProvablyFair';
import SquadFlip from './SquadFlip';

type MobilePanel = 'left' | 'center' | 'right';

export default function MobileGamePanels() {
  const [activePanel, setActivePanel] = useState<MobilePanel>('center');
  const [showSquad, setShowSquad] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <>
      {/* Floating tab switcher */}
      <div className="lg:hidden fixed bottom-24 left-1/2 -translate-x-1/2 z-40">
        <div className="flex items-center gap-1 bg-bg-card/95 backdrop-blur border border-white/10 rounded-full p-1 shadow-2xl">
          <button
            onClick={() => setActivePanel('left')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activePanel === 'left' ? 'bg-brand-green text-void' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <SlidersHorizontal size={12} />
            Bet
          </button>
          <button
            onClick={() => setActivePanel('center')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              activePanel === 'center' ? 'bg-brand-gold text-void' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            Coin
          </button>
          <button
            onClick={() => setActivePanel('right')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activePanel === 'right' ? 'bg-brand-blue text-void' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <MessageSquare size={12} />
            Chat
          </button>
        </div>
      </div>

      {/* Left panel */}
      {activePanel === 'left' && (
        <div className="lg:hidden fixed inset-0 top-14 z-30 bg-void/95 p-3 overflow-y-auto pb-28">
          <button
            onClick={() => setActivePanel('center')}
            className="absolute top-2 right-2 p-2 rounded-full bg-bg-card border border-white/10 text-text-muted"
          >
            <X size={16} />
          </button>

          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setShowSquad(false)}
              className={`flex-1 py-2 rounded-lg text-xs font-mono border ${
                !showSquad
                  ? 'bg-brand-green/15 text-brand-green border-brand-green/35'
                  : 'border-border text-text-muted'
              }`}
            >
              Single Bet
            </button>
            <button
              onClick={() => setShowSquad(true)}
              className={`flex-1 py-2 rounded-lg text-xs font-mono border ${
                showSquad
                  ? 'bg-brand-maroon/15 text-brand-maroon border-brand-maroon/35'
                  : 'border-border text-text-muted'
              }`}
            >
              Squad Flip
            </button>
          </div>

          {showSquad ? <SquadFlip /> : (
            <div className="glass-card p-4">
              <BetControls />
            </div>
          )}

          <div className="mt-3">
            <ProvablyFairWidget />
          </div>
          <div className="mt-3">
            <AffiliatePanel />
          </div>
          <div className="mt-3">
            <PromoWidget />
          </div>
        </div>
      )}

      {/* Right panel */}
      {activePanel === 'right' && (
        <div className="lg:hidden fixed inset-0 top-14 z-30 bg-void/95 p-3 overflow-y-auto pb-28">
          <button
            onClick={() => setActivePanel('center')}
            className="absolute top-2 right-2 p-2 rounded-full bg-bg-card border border-white/10 text-text-muted"
          >
            <X size={16} />
          </button>

          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setActivePanel('right')}
              className="flex-1 py-2 rounded-lg text-xs font-mono bg-brand-blue/15 text-brand-blue border border-brand-blue/35 flex items-center justify-center gap-1"
            >
              <MessageSquare size={12} /> Live Chat
            </button>
            <button
              className="flex-1 py-2 rounded-lg text-xs font-mono border border-border text-text-muted flex items-center justify-center gap-1"
              disabled
            >
              <Trophy size={12} /> Big Wins
            </button>
          </div>
          <LiveChat />
        </div>
      )}
    </>
  );
}
