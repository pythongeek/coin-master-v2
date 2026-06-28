'use client';

import { useGameStore } from '@/lib/store';
import { useTranslation } from '@/hooks/useTranslation';
import { Globe, Check } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'bn', name: 'বাংলা', flag: '🇧🇩' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' }
];

export default function LanguageSelector() {
  const { locale, setLocale } = useGameStore();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeLang = LANGUAGES.find(l => l.code === locale) || LANGUAGES[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative z-50 font-mono text-xs" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-surface hover:border-brand-green/40 text-text-secondary hover:text-text-primary transition-all"
        aria-label="Select Language"
      >
        <span className="text-sm shrink-0">{activeLang.flag}</span>
        <span className="hidden md:inline">{activeLang.name}</span>
        <Globe size={13} className="text-text-muted shrink-0" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-36 rounded-lg border border-border bg-[#090D16] p-1 shadow-xl animate-lift-in">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => {
                setLocale(lang.code as any);
                setOpen(false);
              }}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md transition-colors text-left
                ${locale === lang.code
                  ? 'bg-brand-green/10 text-brand-green font-semibold'
                  : 'text-text-muted hover:bg-white/5 hover:text-text-primary'
                }`}
            >
              <span className="flex items-center gap-1.5">
                <span>{lang.flag}</span>
                <span>{lang.name}</span>
              </span>
              {locale === lang.code && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
