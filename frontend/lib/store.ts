/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME STORE — পুরো অ্যাপের গ্লোবাল স্টেট (Zustand)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Zustand React-এর useState-এর মতোই, কিন্তু যেকোনো
 *  কম্পোনেন্ট থেকে সরাসরি অ্যাক্সেস করা যায়।
 *  Context বা Props drilling দরকার নেই।
 * ═══════════════════════════════════════════════════════════════
 */

import { create } from 'zustand';

// ── ধরনগুলো ────────────────────────────────────────────────────
export type GameStatus = 'idle' | 'spinning' | 'result';
export type FlipChoice = 'heads' | 'tails';

export interface User {
  userId: string;
  username: string;
  balance: number;
  isAdmin: boolean;
  walletAddress?: string;
  isFlagged?: boolean;
  email?: string;
}

export interface BetResult {
  betId: string;
  result: FlipChoice;
  choice: FlipChoice;
  won: boolean;
  betAmount: number;
  payout: number;
  houseEdge: number;
  newBalance: number;
  winStreak: number;
  cryptoRainTriggered: boolean;
  verification: {
    serverSeedHash: string;
    serverSeed: string;
    clientSeed: string;
    nonce: number;
    rawHash: string;
  };
  message: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  message: string;
  timestamp: number;
  type: 'message' | 'win' | 'rain';
}

export interface ActiveRain {
  rainId: string;
  totalAmount: number;
  maxClaims: number;
  expiresAt: string;
  claimCount?: number;
}

// ── স্টেট ইন্টারফেস ────────────────────────────────────────────
interface GameStore {
  // ── অথ ──────────────────────────────────────────────────────
  user: User | null;
  token: string | null;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  updateBalance: (balance: number) => void;
  logout: () => void;

  // ── গেম স্টেট ────────────────────────────────────────────────
  gameStatus: GameStatus;
  currentChoice: FlipChoice;
  betAmount: number;
  lastResult: BetResult | null;
  betHistory: BetResult[];
  isAutoPlayRunning: boolean;
  targetMultiplier: number;

  setGameStatus: (status: GameStatus) => void;
  setCurrentChoice: (choice: FlipChoice) => void;
  setBetAmount: (amount: number) => void;
  setLastResult: (result: BetResult) => void;
  addToBetHistory: (result: BetResult) => void;
  setIsAutoPlayRunning: (running: boolean) => void;
  setTargetMultiplier: (multiplier: number) => void;
  resetGame: () => void;

  // ── চ্যাট ──────────────────────────────────────────────────
  chatMessages: ChatMessage[];
  onlineCount: number;
  addChatMessage: (msg: ChatMessage) => void;
  setChatHistory: (msgs: ChatMessage[]) => void;
  setOnlineCount: (count: number) => void;

  // ── ক্রিপ্টো রেইন ──────────────────────────────────────────
  activeRain: ActiveRain | null;
  hasClaimedRain: boolean;
  setActiveRain: (rain: ActiveRain | null) => void;
  setHasClaimedRain: (claimed: boolean) => void;
  updateRainClaims: (claimCount: number) => void;

  // ── নোটিফিকেশন ─────────────────────────────────────────────
  notifications: Array<{ id: string; message: string; type: 'win' | 'lose' | 'rain' | 'info' }>;
  addNotification: (msg: string, type: 'win' | 'lose' | 'rain' | 'info') => void;
  removeNotification: (id: string) => void;

  // ── সেটিংস ────────────────────────────────────────────────
  settings: { sound: boolean; animationSpeed: 'normal' | 'fast' };
  showSettings: boolean;
  loadSettings: () => void;
  updateSettings: (settings: Partial<{ sound: boolean; animationSpeed: 'normal' | 'fast' }>) => void;
  toggleSettings: () => void;

  // ── ভাষা (Language / i18n) ──
  locale: string;
  setLocale: (locale: string) => void;
}

// ── স্টোর তৈরি ─────────────────────────────────────────────────
export const useGameStore = create<GameStore>((set, get) => ({

  // ── অথ ──────────────────────────────────────────────────────
  user: null,
  token: null,

  setUser: (user) => set({ user }),
  setToken: (token) => set({ token }),

  updateBalance: (balance) =>
    set((state) => ({
      user: state.user ? { ...state.user, balance } : null,
    })),

  logout: () => {
    set({ user: null, token: null, lastResult: null });
    if (typeof window !== 'undefined') {
      localStorage.removeItem('cf_token');
      localStorage.removeItem('cf_user');
    }
  },

  // ── গেম স্টেট ────────────────────────────────────────────────
  gameStatus: 'idle',
  currentChoice: 'heads',
  betAmount: 1.00,
  lastResult: null,
  betHistory: [],
  isAutoPlayRunning: false,
  targetMultiplier: 2.0,

  setGameStatus:   (status) => set({ gameStatus: status }),
  setCurrentChoice: (choice) => set({ currentChoice: choice }),
  setBetAmount:    (amount) => set({ betAmount: amount }),
  setLastResult:   (result) => set({ lastResult: result }),
  setIsAutoPlayRunning: (running) => set({ isAutoPlayRunning: running }),
  setTargetMultiplier: (multiplier) => set({ targetMultiplier: multiplier }),

  addToBetHistory: (result) =>
    set((state) => ({
      betHistory: [result, ...state.betHistory].slice(0, 50), // শেষ ৫০টি রাখো
    })),

  resetGame: () =>
    set({ gameStatus: 'idle', lastResult: null, isAutoPlayRunning: false }),

  // ── চ্যাট ──────────────────────────────────────────────────
  chatMessages: [],
  onlineCount: 0,

  addChatMessage: (msg) =>
    set((state) => ({
      chatMessages: [...state.chatMessages, msg].slice(-100), // শেষ ১০০টি
    })),

  setChatHistory: (msgs) => set({ chatMessages: msgs }),
  setOnlineCount: (count) => set({ onlineCount: count }),

  // ── ক্রিপ্টো রেইন ──────────────────────────────────────────
  activeRain: null,
  hasClaimedRain: false,

  setActiveRain:     (rain) => set({ activeRain: rain, hasClaimedRain: false }),
  setHasClaimedRain: (claimed) => set({ hasClaimedRain: claimed }),

  updateRainClaims: (claimCount) =>
    set((state) => ({
      activeRain: state.activeRain
        ? { ...state.activeRain, claimCount }
        : null,
    })),

  // ── নোটিফিকেশন ─────────────────────────────────────────────
  notifications: [],

  addNotification: (message, type) => {
    const id = `notif_${Date.now()}`;
    set((state) => ({
      notifications: [...state.notifications, { id, message, type }],
    }));
    // ৩ সেকেন্ড পর নিজে নিজে সরে যাবে
    setTimeout(() => get().removeNotification(id), 3000);
  },

  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  // ── সেটিংস ────────────────────────────────────────────────
  settings: {
    sound: true,
    animationSpeed: 'normal',
  },
  showSettings: false,

  loadSettings: () => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('cf_settings');
        if (stored) {
          set({ settings: { ...get().settings, ...JSON.parse(stored) } });
        }
        const storedLocale = localStorage.getItem('cf_locale');
        if (storedLocale) {
          set({ locale: storedLocale });
        }
      } catch (e) {
        console.error('Failed to load settings', e);
      }
    }
  },

  updateSettings: (newSettings) => {
    const updated = { ...get().settings, ...newSettings };
    set({ settings: updated });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('cf_settings', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save settings', e);
      }
    }
  },

  toggleSettings: () => set((state) => ({ showSettings: !state.showSettings })),

  // ── ভাষা (Language / i18n) ──
  locale: 'en',
  setLocale: (locale) => {
    set({ locale });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('cf_locale', locale);
      } catch (e) {
        console.error('Failed to save locale', e);
      }
    }
  },
}));
