'use client';

import { useGameStore } from '@/lib/store';
import { X, Volume2, Gauge, RotateCcw } from 'lucide-react';

export default function SettingsModal() {
  const { settings, updateSettings, toggleSettings, resetGame } = useGameStore();

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md mx-4 shadow-elevate-lg p-5">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <h2 className="text-lg font-display font-bold text-text-primary">Settings</h2>
          <button 
            onClick={toggleSettings}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-all"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="py-4 space-y-5">
          {/* Sound Toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-surface2 flex items-center justify-center border border-border">
                <Volume2 className="w-4 h-4 text-text-secondary" />
              </div>
              <div>
                <p className="text-sm font-semibold text-text-primary">Sound</p>
                <p className="text-xs text-text-muted">Turn game sound on or off</p>
              </div>
            </div>
            <button 
              onClick={() => updateSettings({ sound: !settings.sound })}
              className={`w-12 h-6 rounded-full transition-all duration-200 relative ${
                settings.sound ? 'bg-brand-green' : 'bg-surface2 border border-border'
              }`}
              aria-label={settings.sound ? 'শব্দ বন্ধ করুন' : 'শব্দ চালু করুন'}
            >
              <div 
                className={`w-5 h-5 rounded-full bg-void absolute top-0.5 transition-all duration-200 ${
                  settings.sound ? 'left-6 bg-void' : 'left-0.5 bg-text-muted'
                }`} 
              />
            </button>
          </div>

          {/* Animation Speed Option */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-surface2 flex items-center justify-center border border-border">
                <Gauge className="w-4 h-4 text-text-secondary" />
              </div>
              <div>
                <p className="text-sm font-semibold text-text-primary">Animation speed</p>
                <p className="text-xs text-text-muted">Make coin spin speed dynamic</p>
              </div>
            </div>
            <div className="flex bg-surface2 rounded-lg p-0.5 border border-border">
              {(['normal', 'fast'] as const).map((spd) => (
                <button 
                  key={spd} 
                  onClick={() => updateSettings({ animationSpeed: spd })}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold font-display transition-all ${
                    settings.animationSpeed === spd 
                      ? 'bg-surface border border-border text-brand-green shadow-elevate-sm' 
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {spd === 'normal' ? 'NORMAL' : 'FAST'}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Reset Button */}
          <button 
            onClick={() => { resetGame(); toggleSettings(); }}
            className="w-full flex items-center justify-center gap-2 py-3 bg-brand-red/10 hover:bg-brand-red/20 border border-brand-red/25 rounded-xl text-sm font-semibold text-brand-red transition-all"
          >
            <RotateCcw className="w-4 h-4" />
            গেম স্টেট Reset করুন
          </button>
        </div>
      </div>
    </div>
  );
}
