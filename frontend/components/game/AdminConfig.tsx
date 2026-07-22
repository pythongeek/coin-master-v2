'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ADMIN CONFIG PANEL — এডমিনের সম্পূর্ণ Control Panel UI
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import { Wallet, CloudRain, Users, Zap, ShieldCheck, Settings, RotateCcw, Calculator, Check, Loader2, type LucideIcon } from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import { getApiBase } from '@/lib/api/base';


const API = getApiBase();

// ── DEFAULT CONFIG (Backend থেকে না পেলে এটি ব্যবহার হবে) ────────
const DEFAULTS = {
  houseEdgePercent:       { value: 2.0,    label: 'House Edge', unit: '%',      desc: 'প্ল্যাটফর্মের কমিশন। ২% = ১০০ Betে জয় হলে ১৯৬ পাবে', min: 0.1,  max: 10,    category: 'Betিং', type: 'number' },
  minBetAmount:           { value: 0.01,   label: 'Min Bet', unit: '$',  desc: 'Min Betের পরিমাণ', min: 0.01, max: 100,   category: 'Betিং', type: 'number' },
  maxBetAmount:           { value: 1000,   label: 'Max Bet', unit: '$',  desc: 'একটি Betে সর্বোচ্চ পরিমাণ (রিস্ক কন্ট্রোল)', min: 10,   max: 100000,category: 'Betিং', type: 'number' },
  rainTriggerStreak:      { value: 5,      label: 'Rain Streak', unit: 'বার', desc: 'টানা কতবার জিতলে Crypto Rain ট্রিগার হবে', min: 2,    max: 20,    category: 'ক্রিপ্টো রেইন', type: 'number' },
  rainBudgetDailyUsd:     { value: 50,     label: 'Daily Rain Budget', unit: '$', desc: 'প্রতিদিন মোট রেইন বরাদ্দ', min: 1,    max: 10000, category: 'ক্রিপ্টো রেইন', type: 'number' },
  rainClaimPerUserUsd:    { value: 0.10,   label: 'Per Claim', unit: '$',  desc: 'একজন ইউজার একটি রেইনে সর্বোচ্চ কত পাবে', min: 0.01, max: 10,    category: 'ক্রিপ্টো রেইন', type: 'number' },
  rainDurationSeconds:    { value: 60,     label: 'Rain Duration', unit: 'সেকেন্ড', desc: 'রেইন ইভেন্ট কত সেকেন্ড চলবে', min: 10,   max: 300,   category: 'ক্রিপ্টো রেইন', type: 'number' },
  rainEnabled:            { value: true,   label: 'Rain Enabled', unit: '',      desc: 'Crypto Rain ফিচার বন্ধ/চালু', category: 'ক্রিপ্টো রেইন', type: 'boolean' },
  maxSquadSize:           { value: 5,      label: 'Squad Size', unit: 'জন', desc: 'Squad Flip-এ সর্বোচ্চ কতজন অংশ নিতে পারবে', min: 2,    max: 10,    category: 'স্কোয়াড', type: 'number' },
  squadEnabled:           { value: true,   label: 'Squad Enabled', unit: '',   desc: 'Squad Flip ফিচার বন্ধ/চালু', category: 'স্কোয়াড', type: 'boolean' },
  squadHouseEdgePercent:  { value: 1.0,    label: 'স্কোয়াড House Edge', unit: '%', desc: 'Squad Flip-এর জন্য আলাদা কমিশন', min: 0.1,  max: 5,     category: 'স্কোয়াড', type: 'number' },
  coinSpinDurationMs:     { value: 3000,   label: 'Coin Spin Time', unit: 'ms', desc: 'কয়েন কতক্ষণ ঘুরবে (টেনশন বিল্ড-আপ)', min: 1000, max: 10000, category: 'গেম স্পিড', type: 'number' },
  cooldownBetweenGamesMs: { value: 1500,   label: 'Game Cooldown', unit: 'ms', desc: 'দুই গেমের মধ্যে বিরতি', min: 500,  max: 10000, category: 'গেম স্পিড', type: 'number' },
  seedRotationAfterGames: { value: 100,    label: 'Seed Rotation', unit: 'গেম', desc: 'কত গেমের পর নতুন Server seed তৈরি হবে', min: 10,   max: 1000,  category: 'নিরাপত্তা', type: 'number' },
  maintenanceMode:        { value: false,  label: 'Maintenance Mode', unit: '', desc: 'চালু করলে কেউ গেম খেলতে পারবে না', category: 'সিস্টেম', type: 'boolean' },
};

type ConfigKey = keyof typeof DEFAULTS;

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'Betিং': Wallet,
  'ক্রিপ্টো রেইন': CloudRain,
  'স্কোয়াড': Users,
  'গেম স্পিড': Zap,
  'নিরাপত্তা': ShieldCheck,
  'সিস্টেম': Settings,
};

// NOTE: The upstream repo defined this as `useState(() => ...)` at module
// top level (line 40 of HEAD 28d3babd). That crashes `next build` static
// export with `Cannot read properties of null (reading 'useState')` because
// React's hooks are null during the prerender pass. Converted to a plain
// const initializer — the value is never mutated by setConfig outside the
// component (component state is recreated below).
const INITIAL_CONFIG: Record<string, string | number | boolean> =
  Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.value]));

export default function AdminConfigPanel() {
  const [config, setConfig] = useState<Record<string, string | number | boolean>>(INITIAL_CONFIG);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState('Betিং');
  const { addToast } = useToast();

  const categories = [...new Set(Object.values(DEFAULTS).map(d => d.category))];

  // ── একটি সেটিং আপডেট করো ──────────────────────────────────────
  const handleUpdate = async (key: ConfigKey, value: string | number | boolean) => {
    setSaving(key);
    setConfig(prev => ({ ...prev, [key]: value as any }));

    const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
    try {
      const res = await fetch(`${API}/admin/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (!data.success) {
        addToast(data.error || 'Failed to save config', 'error');
      } else {
        addToast(`${DEFAULTS[key].label || key} saved`, 'success');
      }
    } catch (err) {
      addToast('Config update failed', 'error');
    }

    setTimeout(() => {
      setSaving(null);
      setSaved(key);
      setTimeout(() => setSaved(null), 1500);
    }, 500);
  };

  // ── ডিফল্টে ফিরিয়ে দাও ────────────────────────────────────────
  const handleReset = async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
    try {
      const res = await fetch(`${API}/admin/config/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) {
        addToast(data.error || 'Failed to reset config', 'error');
      }
    } catch (err) {
      addToast('Config reset failed', 'error');
    }
    const defaults = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.value]));
    setConfig(defaults);
    setSaved('all');
    setTimeout(() => setSaved(null), 2000);
  };

  // ── বর্তমান ক্যাটাগরির কনফিগ ───────────────────────────────────
  const currentItems = Object.entries(DEFAULTS).filter(([, v]) => v.category === activeCategory);

  // ── Export current config to JSON ─────────────────────────────
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryptoflip-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('Config exported', 'success');
  };

  // ── Import config from JSON file ────────────────────────────────
  const importConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const validKeys = Object.keys(DEFAULTS);
        const filtered = Object.fromEntries(
          Object.entries(parsed).filter(([k]) => validKeys.includes(k))
        ) as Record<string, string | number | boolean>;
        setConfig((prev) => ({ ...prev, ...filtered }));
        const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
        const res = await fetch(`${API}/admin/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(filtered),
        });
        const data = await res.json();
        if (data.success) {
          addToast('Config imported and saved', 'success');
        } else {
          addToast(data.error || 'Import failed', 'error');
        }
      } catch {
        addToast('Invalid JSON file', 'error');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  // ── House Edge থেকে পেআউট ক্যালকুলেট করো ────────────────────────
  const houseEdge = config.houseEdgePercent as number;
  const payoutMultiplier = (2 * (1 - houseEdge / 100)).toFixed(4);
  const examplePayout = (100 * parseFloat(payoutMultiplier)).toFixed(2);

  return (
    <div className="space-y-6">
      {/* ─── হেডার ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="heading-display text-xl text-brand-maroon">Admin Control Panel</h2>
          <p className="text-text-muted text-xs font-mono mt-1">All changes take effect immediately</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-4 py-2 border border-brand-red/40 text-brand-red rounded-lg text-xs font-mono
                       hover:bg-brand-red/10 transition-all duration-150"
          >
            <RotateCcw size={13} />
            ডিফল্টে ফিরুন
          </button>
          <button
            onClick={exportConfig}
            className="flex items-center gap-1.5 px-4 py-2 border border-brand-info/40 text-brand-info rounded-lg text-xs font-mono hover:bg-brand-info/10 transition-all"
          >
            Export
          </button>
          <label className="flex items-center gap-1.5 px-4 py-2 border border-brand-green/40 text-brand-green rounded-lg text-xs font-mono hover:bg-brand-green/10 transition-all cursor-pointer">
            Import
            <input type="file" accept=".json" onChange={importConfig} className="hidden" />
          </label>
        </div>
      </div>

      {/* ─── House Edge ক্যালকুলেটর ─────────────────────────────────── */}
      <div className="glass-card p-4 border border-brand-gold/30 bg-brand-gold/5">
        <div className="flex items-center gap-2 mb-3">
          <Calculator size={16} className="text-brand-gold" />
          <span className="heading-display text-sm text-brand-gold">Payout Calculator</span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-void rounded-lg p-3">
            <div className="text-text-muted text-xs font-mono">House Edge</div>
            <div className="text-brand-gold font-mono font-bold text-lg">{houseEdge}%</div>
          </div>
          <div className="bg-void rounded-lg p-3">
            <div className="text-text-muted text-xs font-mono">মাল্টিপ্লায়ার</div>
            <div className="text-brand-green font-mono font-bold text-lg">{payoutMultiplier}×</div>
          </div>
          <div className="bg-void rounded-lg p-3">
            <div className="text-text-muted text-xs font-mono">Win on $100 bet</div>
            <div className="text-brand-info font-mono font-bold text-lg">${examplePayout}</div>
          </div>
        </div>
        <p className="text-text-muted text-xs font-mono mt-2 text-center">
          নেট লাভ: ${(parseFloat(examplePayout) - 100).toFixed(2)} | প্ল্যাটফর্মের লাভ: ${(200 - parseFloat(examplePayout)).toFixed(2)}
        </p>
      </div>

      {/* ─── ক্যাটাগরি ট্যাব ──────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {categories.map(cat => {
          const CatIcon = CATEGORY_ICONS[cat];
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono transition-all duration-150 ${
                activeCategory === cat
                  ? 'bg-brand-maroon text-white font-medium shadow-brand-maroon'
                  : 'border border-border text-text-secondary hover:border-brand-maroon/50'
              }`}
            >
              <CatIcon size={13} />
              {cat}
            </button>
          );
        })}
      </div>

      {/* ─── সেটিং কার্ডগুলো ──────────────────────────────────────── */}
      <div className="grid gap-3">
        {currentItems.map(([key, meta]) => {
          const configKey = key as ConfigKey;
          const currentValue = config[key];
          const isModified = currentValue !== meta.value;
          const isSaving = saving === key;
          const isSaved = saved === key || saved === 'all';

          return (
            <div
              key={key}
              className={`glass-card p-4 border transition-all duration-300 ${
                isModified ? 'border-brand-maroon/40' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                {/* লেবেল ও বর্ণনা */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="heading-display text-sm text-text-primary">{meta.label}</span>
                    {isModified && (
                      <span className="text-xs font-mono text-brand-maroon px-2 py-0.5 border border-brand-maroon/30 rounded">
                        পরিবর্তিত
                      </span>
                    )}
                    {isSaved && (
                      <span className="flex items-center gap-1 text-xs font-mono text-brand-green animate-float-up">
                        <Check size={11} /> সেভ হয়েছে
                      </span>
                    )}
                  </div>
                  <p className="text-text-muted text-xs font-mono mt-1">{meta.desc}</p>
                  {isModified && (
                    <p className="text-text-muted text-xs font-mono mt-0.5">
                      Default: <span className="text-brand-info">{String(meta.value)}{meta.unit}</span>
                    </p>
                  )}
                </div>

                {/* ইনপুট কন্ট্রোল */}
                <div className="flex items-center gap-2 shrink-0">
                  {meta.type === 'boolean' ? (
                    /* টগল সুইচ */
                    <button
                      onClick={() => handleUpdate(configKey, !currentValue)}
                      className={`relative w-14 h-7 rounded-full transition-all duration-300 ${
                        currentValue ? 'bg-brand-green shadow-brand-green' : 'bg-border'
                      }`}
                    >
                      <span className={`absolute top-1 w-5 h-5 bg-void rounded-full transition-all duration-300 ${
                        currentValue ? 'left-8' : 'left-1'
                      }`} />
                    </button>
                  ) : (
                    /* নম্বর ইনপুট */
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={currentValue as number}
                        min={(meta as { min?: number }).min}
                        max={(meta as { max?: number }).max}
                        step={String(meta.value).includes('.') ? 0.01 : 1}
                        onChange={e => setConfig(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
                        onBlur={e => handleUpdate(configKey, parseFloat(e.target.value) || 0)}
                        className="w-28 px-3 py-2 bg-void border border-border rounded-lg text-right
                                   font-mono text-sm text-text-primary focus:outline-none focus:border-brand-maroon
                                   transition-colors"
                      />
                      {meta.unit && (
                        <span className="text-text-muted text-xs font-mono w-10">{meta.unit}</span>
                      )}
                    </div>
                  )}
                  {isSaving && <Loader2 size={13} className="text-brand-info animate-spin" />}
                </div>
              </div>

              {/* রেঞ্জ স্লাইডার (শুধু নম্বরের জন্য) */}
              {meta.type === 'number' && (meta as { min?: number }).min !== undefined && (
                <div className="mt-3">
                  <input
                    type="range"
                    min={(meta as { min?: number }).min}
                    max={(meta as { max?: number }).max}
                    step={String(meta.value).includes('.') ? 0.01 : 1}
                    value={currentValue as number}
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      setConfig(p => ({ ...p, [key]: val }));
                      handleUpdate(configKey, val);
                    }}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #A8395C ${
                        (((currentValue as number) - ((meta as { min?: number }).min || 0)) /
                          (((meta as { max?: number }).max || 100) - ((meta as { min?: number }).min || 0))) * 100
                      }%, #262C36 0%)`,
                    }}
                  />
                  <div className="flex justify-between text-text-muted text-xs font-mono mt-1">
                    <span>{(meta as { min?: number }).min}{meta.unit}</span>
                    <span>{(meta as { max?: number }).max}{meta.unit}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
