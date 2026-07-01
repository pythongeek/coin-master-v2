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
  /**
   * Stake-style multiplier (1.01x–1000x).
   * Server-validated in routes/game.ts; client derives win chance + house edge from it.
   * Higher multiplier = lower win chance, higher payout.
   */
  multiplier: number;
  /**
   * House edge as a percent (e.g. 2 means 2%). Fetched from /api/admin/config/public
   * on mount; defaults to 2% so the UI works offline / before the fetch lands.
   */
  houseEdgePercent: number;
  lastResult: BetResult | null;
  betHistory: BetResult[];

  setGameStatus: (status: GameStatus) => void;
  setCurrentChoice: (choice: FlipChoice) => void;
  setBetAmount: (amount: number) => void;
  setMultiplier: (multiplier: number) => void;
  setHouseEdgePercent: (pct: number) => void;
  setLastResult: (result: BetResult) => void;
  addToBetHistory: (result: BetResult) => void;
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
}

// ── স্টোর তৈরি ─────────────────────────────────────────────────
//
// Persisted to localStorage under `cf_game_store` so that:
//   (1) the navbar shows the logged-in user after a reload,
//   (2) the socket reconnects with the JWT instead of guest,
//   (3) the FLIP button stays enabled without re-login.
//
// Only auth fields are persisted — game state (currentChoice,
// betAmount, gameStatus, lastResult, etc.) is intentionally NOT
// persisted because resuming a spinning coin flip mid-animation
// after a reload would be confusing and out-of-sync with the
// server's lastResult.
//
// We keep writing the legacy `cf_token` and `cf_user` keys too
// because admin/dashboard pages still read them directly via
// `localStorage.getItem('cf_token')`. Duplicating the source of
// truth for ~1 KB is cheaper than a refactor.
export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
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

      gameStatus: 'idle',
      currentChoice: 'heads',
      betAmount: 1.00,
      multiplier: 2.00,
      houseEdgePercent: 2.0,
      lastResult: null,
      betHistory: [],

      setGameStatus:   (status) => set({ gameStatus: status }),
      setCurrentChoice: (choice) => set({ currentChoice: choice }),
      setBetAmount:    (amount) => set({ betAmount: amount }),
      setMultiplier:   (m) => set({ multiplier: m }),
      setHouseEdgePercent: (pct) => set({ houseEdgePercent: pct }),
      setLastResult:   (result) => set({ lastResult: result }),

      addToBetHistory: (result) =>
        set((state) => ({
          betHistory: [result, ...state.betHistory].slice(0, 50),
        })),

      resetGame: () =>
        set({ gameStatus: 'idle', lastResult: null }),

      chatMessages: [],
      onlineCount: 0,

      addChatMessage: (msg) =>
        set((state) => ({
          chatMessages: [...state.chatMessages, msg].slice(-100),
        })),

      setChatHistory: (msgs) => set({ chatMessages: msgs }),
      setOnlineCount: (count) => set({ onlineCount: count }),

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
    }),
    {
      name: 'cf_game_store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        token: state.token,
      }),
    },
  ),
);