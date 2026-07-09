/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME STORE — পুরো অ্যাপের গ্লোবাল স্টেট (Zustand)
 * ═══════════════════════════════════════════════════════════════
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  scatter?: {
    triggered: boolean;
    multiplier?: number;
    payout?: number;
    scatterHash?: string;
  };
  streak?: {
    currentStreak: number;
    rungMultiplier: number;
    ladderBonus: number;
    atRisk: number;
    banked?: number;
    lost?: number;
  };
  lightning?: {
    triggered: boolean;
    multiplier: number;
    extraPayout: number;
    durationSeconds: number;
  };
  verification: {
    serverSeedHash: string;
    serverSeed: string;
    clientSeed: string;
    nonce: number;
    rawHash: string;
  };
  message: string;
}

export interface ScatterResult {
  betId: string;
  pickIndex: number;
  multiplier: number;
  payout: number;
  newBalance: number;
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
  login: (payload: { user: User; token: string }) => void;
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
  activeScatter: ScatterResult | null;
  pendingScatter: BetResult | null;

  setGameStatus: (status: GameStatus) => void;
  setCurrentChoice: (choice: FlipChoice) => void;
  setBetAmount: (amount: number) => void;
  setLastResult: (result: BetResult) => void;
  addToBetHistory: (result: BetResult) => void;
  setIsAutoPlayRunning: (running: boolean) => void;
  setTargetMultiplier: (multiplier: number) => void;
  resetGame: () => void;
  setActiveScatter: (scatter: ScatterResult | null) => void;
  setPendingScatter: (bet: BetResult | null) => void;

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

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      // ── অথ ──────────────────────────────────────────────────────
      user: null,
      token: null,

      setUser: (user) => set({ user }),
      setToken: (token) => set({ token }),

      login: ({ user, token }: { user: User; token: string }) =>
        set({ user, token }),

      updateBalance: (balance) =>
        set((state) => ({
          user: state.user ? { ...state.user, balance } : null,
        })),

      logout: () => {
        set({ user: null, token: null, lastResult: null, activeScatter: null, pendingScatter: null });
        if (typeof window !== 'undefined') {
          localStorage.removeItem('cf_token');
          import('@/lib/socket').then(({ clearToken }) => clearToken());
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
      activeScatter: null,
      pendingScatter: null,

      setGameStatus: (status) => set({ gameStatus: status }),
      setCurrentChoice: (choice) => set({ currentChoice: choice }),
      setBetAmount: (amount) => set({ betAmount: amount }),
      setLastResult: (result) => set({ lastResult: result }),
      setIsAutoPlayRunning: (running) => set({ isAutoPlayRunning: running }),
      setTargetMultiplier: (multiplier) => set({ targetMultiplier: multiplier }),
      setActiveScatter: (scatter) => set({ activeScatter: scatter }),
      setPendingScatter: (bet) => set({ pendingScatter: bet }),

      addToBetHistory: (result) =>
        set((state) => ({
          betHistory: [result, ...state.betHistory].slice(0, 50),
        })),

      resetGame: () =>
        set({ gameStatus: 'idle', lastResult: null, isAutoPlayRunning: false, activeScatter: null, pendingScatter: null }),

      // ── চ্যাট ──────────────────────────────────────────────────
      chatMessages: [],
      onlineCount: 0,

      addChatMessage: (msg) =>
        set((state) => ({
          chatMessages: [...state.chatMessages, msg].slice(-100),
        })),

      setChatHistory: (msgs) => set({ chatMessages: msgs }),
      setOnlineCount: (count) => set({ onlineCount: count }),

      // ── ক্রিপ্টো রেইন ──────────────────────────────────────────
      activeRain: null,
      hasClaimedRain: false,

      setActiveRain: (rain) => set({ activeRain: rain, hasClaimedRain: false }),
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
        // Settings + locale are now persisted via the persist middleware
      },

      updateSettings: (newSettings) => {
        const updated = { ...get().settings, ...newSettings };
        set({ settings: updated });
      },

      toggleSettings: () => set((state) => ({ showSettings: !state.showSettings })),

      // ── ভাষা (Language / i18n) ──
      locale: 'en',
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'cf_game_store',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : (undefined as unknown as Storage)
      ),
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        settings: state.settings,
        locale: state.locale,
      }),
      skipHydration: false,
      version: 2,
      onRehydrateStorage: () => {
        // Some login flows (legacy + manual token injection) only write
        // cf_token. Make sure the Zustand store picks it up, but never
        // trust client-side isAdmin — the backend validates role on every
        // request.
        // This callback returns a patch merged after hydration. The merged
        // state runs inside the store, so we must avoid calling setState
        // directly here (circular init error).
        if (typeof window === 'undefined') return;
        return (state: GameStore | undefined) => {
          if (state?.user && state?.token) return;
          try {
            const token = localStorage.getItem('cf_token');
            if (token) {
              const payload = JSON.parse(atob(token.split('.')[1]));
              const parsedUser: User = {
                userId: payload.userId || payload.sub,
                username: payload.username || 'player',
                email: payload.email || null,
                balance: payload.balance || 0,
                isAdmin: false,
                walletAddress: payload.walletAddress || null,
                isFlagged: payload.isFlagged || false,
              };
              return { user: parsedUser, token } as Partial<GameStore>;
            }
          } catch (e) {
            console.warn('[store] rehydrate from cf_token failed', e);
          }
        };
      },
      migrate: (persistedState, version) => {
        if (version < 1 && typeof window !== 'undefined') {
          try {
            const legacyToken = localStorage.getItem('cf_token');
            if (legacyToken) {
              // Decode JWT to derive the user instead of trusting a stale
              // cf_user blob that may have been tampered with.
              const payload = JSON.parse(atob(legacyToken.split('.')[1]));
              const state = (persistedState ?? {}) as Partial<GameStore>;
              return {
                ...state,
                token: legacyToken,
                user: {
                  userId: payload.userId || payload.sub,
                  username: payload.username || 'player',
                  email: payload.email || null,
                  balance: payload.balance || 0,
                  // NEVER trust client-side isAdmin; the backend validates role.
                  isAdmin: false,
                  walletAddress: payload.walletAddress || null,
                },
              } as GameStore;
            }
          } catch (e) {
            console.warn('[store] migration from cf_token failed', e);
          }
        }
        return persistedState as GameStore;
      },
    }
  )
);
