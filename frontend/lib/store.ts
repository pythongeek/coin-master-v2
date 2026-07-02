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
//
// persist middleware: persists user/token to localStorage so the
// user stays logged-in across page reloads. Storage key is
// `cf_game_store`. The previous main coin UI (pre-merge) had this
// working — when the user logged in, refreshing the page kept them
// logged in. The merged remote code removed the persist wrapper
// (it was a local-only addition), so reloads now show the user as
// logged out even though the localStorage `cf_token` and `cf_user`
// are still present.
//
// `partialize` chooses which slice of the store to persist. We
// exclude transient per-bet state (gameStatus, betHistory,
// chatMessages, notifications) so a reload doesn't restore stale
// UI like "spinning" or a phantom last result. We DO persist the
// user, token, settings, and locale — the things that should
// survive a page refresh.
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
        set({ user: null, token: null, lastResult: null });
        if (typeof window !== 'undefined') {
          // Keep the legacy keys for back-compat with anything
          // (LoginModal, other pages) that still reads them.
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
          betHistory: [result, ...state.betHistory].slice(0, 50),
        })),

      resetGame: () =>
        set({ gameStatus: 'idle', lastResult: null, isAutoPlayRunning: false }),

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
        // Settings + locale are now persisted via the persist
        // middleware below, so this is a no-op kept for
        // back-compat with anything that calls it.
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
        // Auth — these are what makes a reload keep the user logged in.
        user: state.user,
        token: state.token,
        // Settings + locale — should also survive a refresh.
        settings: state.settings,
        locale: state.locale,
      }),
      // Re-hydrate on the client. On the server (SSR / first render)
      // the initial state stays as defined in the store. Setting
      // skipHydration: true and calling useGameStore.persist.rehydrate()
      // from a client-only effect would also work; the default
      // (skipHydration: false) hydrates synchronously on first read
      // which is fine for a localStorage-backed store.
      skipHydration: false,
      // Migrate data from the pre-persist localStorage shape
      // (cf_token, cf_user) into the new persisted store. Runs once
      // on the first page load after this change ships. Without
      // this, every existing logged-in user would appear logged
      // out until they logged in again.
      version: 1,
      migrate: (persistedState, version) => {
        if (version < 1 && typeof window !== 'undefined') {
          try {
            const legacyToken = localStorage.getItem('cf_token');
            const legacyUserJson = localStorage.getItem('cf_user');
            if (legacyToken && legacyUserJson) {
              const legacyUser = JSON.parse(legacyUserJson);
              const state = (persistedState ?? {}) as Partial<GameStore>;
              return {
                ...state,
                token: legacyToken,
                user: {
                  userId: legacyUser.userId,
                  username: legacyUser.username,
                  email: legacyUser.email,
                  balance: legacyUser.balance,
                  isAdmin: legacyUser.isAdmin,
                },
              } as GameStore;
            }
          } catch (e) {
            console.warn('[store] migration from cf_token/cf_user failed', e);
          }
        }
        return persistedState as GameStore;
      },
    }
  )
);
