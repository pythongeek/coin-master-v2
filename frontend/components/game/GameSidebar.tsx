'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME SIDEBAR — Accessible tabbed panel for Play / Fair / Affiliate / Promos
 * ═══════════════════════════════════════════════════════════════
 *
 *  Replaces the stacked accordion widgets on the left side with
 *  a single tabbed container. Each major section gets full space,
 *  clear keyboard navigation, and proper ARIA roles.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useRef, useEffect } from 'react';
import { Dices, ShieldCheck, Users, Gift, AlertTriangle } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import BetControls from './BetControls';
import ProvablyFairWidget from './ProvablyFair';
import AffiliatePanel from './AffiliatePanel';
import PromoWidget from './PromoWidget';
import SquadFlip from './SquadFlip';
import { useTranslation } from '@/hooks/useTranslation';

type TabId = 'play' | 'fair' | 'affiliate' | 'promos';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ElementType;
}

const TABS: TabDef[] = [
  { id: 'play', label: 'Play', icon: Dices },
  { id: 'fair', label: 'Provably Fair', icon: ShieldCheck },
  { id: 'affiliate', label: 'Affiliate', icon: Users },
  { id: 'promos', label: 'Promos', icon: Gift },
];

export default function GameSidebar() {
  const { t } = useTranslation();
  const { user } = useGameStore();
  const [activeTab, setActiveTab] = useState<TabId>('play');
  const [showSquad, setShowSquad] = useState(false);
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    play: null,
    fair: null,
    affiliate: null,
    promos: null,
  });

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (index + 1) % TABS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = TABS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const nextId = TABS[nextIndex].id;
    setActiveTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  const tabPanelId = (id: TabId) => `sidebar-panel-${id}`;
  const tabId = (id: TabId) => `sidebar-tab-${id}`;

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Mode toggle: single bet vs squad flip */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowSquad(false)}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all ${
            !showSquad
              ? 'bg-brand-green/15 text-brand-green border border-brand-green/35'
              : 'border border-border text-text-muted hover:border-brand-green/30'
          }`}
          aria-pressed={!showSquad}
        >
          <Dices size={14} />
          {t('singleBet')}
        </button>
        <button
          onClick={() => setShowSquad(true)}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-mono transition-all ${
            showSquad
              ? 'bg-brand-maroon/15 text-brand-maroon border border-brand-maroon/35'
              : 'border border-border text-text-muted hover:border-brand-maroon/30'
          }`}
          aria-pressed={showSquad}
        >
          <Users size={14} />
          {t('squadFlip')}
        </button>
      </div>

      {/* Tab list */}
      <div
        role="tablist"
        aria-label="Game sidebar sections"
        className="grid grid-cols-4 bg-surface rounded-xl p-1 border border-border"
      >
        {TABS.map((tab, index) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[tab.id] = el; }}
              role="tab"
              id={tabId(tab.id)}
              aria-selected={isActive}
              aria-controls={tabPanelId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`
                flex flex-col items-center justify-center gap-1 py-2 rounded-lg text-[10px] font-mono font-semibold transition-all
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-green focus-visible:outline-offset-[-2px]
                ${isActive
                  ? 'bg-surface2 text-brand-green shadow-elevate-sm border border-border'
                  : 'text-text-muted hover:text-text-primary'
                }
              `}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={tabPanelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            hidden={activeTab !== tab.id}
            className={activeTab === tab.id ? 'space-y-3' : 'hidden'}
          >
            {tab.id === 'play' && (
              <>
                <div className="relative">
                  {showSquad ? <SquadFlip /> : (
                    <div className="glass-card p-5">
                      <BetControls />
                    </div>
                  )}
                  {user?.isFlagged && (
                    <div className="absolute inset-0 bg-void/80 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center border border-brand-red/30 rounded-xl z-20">
                      <div className="w-12 h-12 rounded-full bg-brand-red/10 flex items-center justify-center text-brand-red mb-3 animate-pulse">
                        <AlertTriangle size={24} />
                      </div>
                      <h4 className="heading-display text-sm text-brand-red mb-1">Account Suspended</h4>
                      <p className="text-[11px] font-mono text-text-secondary leading-relaxed">
                        Your account has been temporarily suspended due to unusual activity. Please contact customer support to reactivate.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
            {tab.id === 'fair' && <ProvablyFairWidget />}
            {tab.id === 'affiliate' && <AffiliatePanel />}
            {tab.id === 'promos' && <PromoWidget />}
          </div>
        ))}
      </div>
    </div>
  );
}

