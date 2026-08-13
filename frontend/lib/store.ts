/**
 * ═══════════════════════════════════════════════════════════════
 *  GAME STORE — পুরো অ্যাপের গ্লোবাল স্টেট (Zustand)
 * ═══════════════════════════════════════════════════════════════
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { apiGet, apiPost } from './api'; // PR-1B: auth flows through httpOnly cookie + /api/auth/me only

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
  /** In-memory only — NEVER persisted to localStorage. Socket.IO uses
   *  this token until the next page refresh re-hydrates via /api/auth/me. */
  token: string | null;
  /** Mirrors whether /api/auth/me returned 200 — used by UI guards. */
  isAuthenticated: boolean;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  login: (payload: { user: User; token: string }) => void;
  /** PR-1B — hydrate user from server using httpOnly cookie. Called
   *  once on app mount and after login. Replaces the old
   *  localStorage-based rehydrate. */
  initialize: () => Promise<void>;
  updateBalance: (balance: number) => void;
  /** PR-1B — async; calls POST /api/auth/logout to clear the cookie
   *  server-side, then clears the in-memory store. */
  logout: () => Promise<void>;

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
      isAuthenticated: false,

      setUser: (user) => set({ user }),
      setToken: (token) => {
        set({ token });
        import('@/lib/socket').then(({ refreshSocketToken }) => refreshSocketToken(token || undefined));
      },

      login: ({ user, token }: { user: User; token: string }) => {
        set({ user, token, isAuthenticated: true });
        import('@/lib/socket').then(({ refreshSocketToken }) => refreshSocketToken(token));
      },

      // PR-1B: hydrate user from /api/auth/me. The httpOnly cookie is
      // attached automatically by the browser for same-origin requests
      // (and via the Next.js /api/[...path] proxy). On success we set
      // user + isAuthenticated; on 401/403/network error we clear both
      // so the UI shows the logged-out state.
      initialize: async () => {
        try {
          const res = await apiGet('/api/auth/me');
          if (res.ok) {
            const payload = await res.json();
            // Backend /api/auth/me returns both `data` (canonical) and
            // `user` (legacy shape). Prefer `data`, fall back to `user`.
            const user = (payload?.data ?? payload?.user ?? null) as User | null;
            if (user) set({ user, isAuthenticated: true });
            else set({ user: null, isAuthenticated: false, token: null });
          } else {
            set({ user: null, isAuthenticated: false, token: null });
          }
        } catch {
          set({ user: null, isAuthenticated: false, token: null });
        }
      },

      updateBalance: (balance) =>
        set((state) => ({
          user: state.user ? { ...state.user, balance } : null,
        })),

      // PR-1B: async. Tells the server to clear the httpOnly cookie,
      // then clears the in-memory store. We do NOT touch localStorage
      // here — there is no auth-related data there anymore.
      logout: async () => {
        try {
          await apiPost('/api/auth/logout');
        } catch {
          // Even if the network call fails, still clear the local
          // store so the UI reflects logged-out.
        }
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          lastResult: null,
          activeScatter: null,
          pendingScatter: null,
        });
        if (typeof window !== 'undefined') {
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
        // PR-1B: `token` is intentionally NOT persisted — the raw JWT
        // never crosses into localStorage. We still cache `user` so
        // the UI paints instantly on the next visit; `initialize()`
        // reconciles with the server on mount and after login.
        user: state.user,
        settings: state.settings,
        locale: state.locale,
      }),
      skipHydration: false,
      version: 2,
      // PR-1B: removed the legacy onRehydrateStorage block that
      // decoded the JWT from localStorage — there is no token there
      // to decode. The persist middleware still rehydrates `user`,
      // `settings`, `locale` automatically.
      // PR-1B: removed the legacy `migrate` callback that walked
      // version < 1 states and decoded a token from localStorage.
      // The first user after this PR ships will have version=2 state
      // (or no state at all), so no migration is required. If a
      // future schema change needs migration, write a new `migrate`
      // callback here.
    }
  )
);
