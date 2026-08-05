'use client';

/**
 * ════════════════════════════════════════════════════════════════
 *  useGroupStore — Zustand store for group-bet live state (Gap 1)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Backing store for the 8 new Gap-1 socket events. The hook
 *  `useGroupBetSocket` accepts an optional `onEvent` callback; the
 *  recommended pattern is to wire one hook per room and dispatch
 *  every event into this store via:
 *
 *     useGroupBetSocket({
 *       groupId,
 *       onEvent: (ev, payload) => {
 *         switch (ev) {
 *           case 'group:state_changed': useGroupStore.getState().setState(payload); break;
 *           case 'group:member_joined': useGroupStore.getState().setMember(payload); break;
 *           case 'group:member_left':   useGroupStore.getState().setMemberLeft(payload); break;
 *           case 'group:pool_updated':  useGroupStore.getState().setPool(payload); break;
 *           case 'group:flip_started':  useGroupStore.getState().setFlipStarted(payload); break;
 *           case 'group:flip_result':   useGroupStore.getState().setFlipResult(payload); break;
 *           case 'group:invite_created': useGroupStore.getState().setInvite(payload); break;
 *           case 'group:expiry_warning': useGroupStore.getState().setExpiryWarning(payload); break;
 *         }
 *       },
 *     });
 *
 *  Storage is in-memory only (no persist middleware) — the store is
 *  reset on every page reload, which is the right behavior for a
 *  live-room state. A new groupId resets the per-room slice so
 *  multiple rooms don't cross-pollute.
 *
 *  Components subscribe via `useGroupStore(state => state.pool)`
 *  for fine-grained re-renders.
 */

import { create } from 'zustand';

export interface GroupStoreState {
  /** Currently observed groupId. */
  groupId: string | null;
  /** Live status from the latest `group:state_changed` event. */
  status: string | null;
  /** Most recent total pool (number). */
  totalPool: number | null;
  /** Most recent currentMembers count. */
  currentMembers: number | null;
  /** Most recent maxMembers. */
  maxMembers: number | null;
  /** Whether the room is currently flipping (count-down UI). */
  flipStarted: boolean;
  /** Flip result details (when present). */
  flipResult: {
    winningSide?: 'heads' | 'tails';
    resultHash?: string;
    serverSeedHash?: string;
    serverSeedReveal?: string;
    clientSeed?: string;
    nonce?: number;
    roll?: number;
  } | null;
  /** Last invite metadata (if any). */
  lastInvite: {
    inviteId?: string;
    tokenPrefix?: string;
    maxRedemptions?: number;
    expiresAt?: string;
  } | null;
  /** Expiry warning state (seconds left). */
  expiryWarning: { secondsLeft: number; expiresAt: string } | null;
  /** Rolling history of the 8 Gap-1 events (capped at 50). */
  history: Array<{ event: string; payload: any; at: number }>;

  // ─── actions (called from the hook's onEvent) ────────────────
  reset: (groupId: string) => void;
  setState: (payload: any) => void;
  setMember: (payload: any) => void;
  setMemberLeft: (payload: any) => void;
  setPool: (payload: any) => void;
  setFlipStarted: (payload: any) => void;
  setFlipResult: (payload: any) => void;
  setInvite: (payload: any) => void;
  setExpiryWarning: (payload: any) => void;
}

const HISTORY_CAP = 50;

export const useGroupStore = create<GroupStoreState>((set, get) => ({
  groupId: null,
  status: null,
  totalPool: null,
  currentMembers: null,
  maxMembers: null,
  flipStarted: false,
  flipResult: null,
  lastInvite: null,
  expiryWarning: null,
  history: [],

  reset: (groupId) => set({
    groupId,
    status: null,
    totalPool: null,
    currentMembers: null,
    maxMembers: null,
    flipStarted: false,
    flipResult: null,
    lastInvite: null,
    expiryWarning: null,
    history: [],
  }),

  setState: (payload) => set((state) => ({
    status: payload.status ?? payload.newStatus ?? state.status,
    currentMembers: payload.currentMembers ?? state.currentMembers,
    maxMembers: payload.maxMembers ?? state.maxMembers,
    totalPool: typeof payload.totalPool === 'number' ? payload.totalPool : state.totalPool,
    history: [{ event: 'group:state_changed', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setMember: (payload) => set((state) => ({
    currentMembers: payload.currentMembers ?? state.currentMembers,
    totalPool: typeof payload.totalPool === 'number' ? payload.totalPool : state.totalPool,
    history: [{ event: 'group:member_joined', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setMemberLeft: (payload) => set((state) => ({
    currentMembers: payload.currentMembers ?? state.currentMembers,
    history: [{ event: 'group:member_left', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setPool: (payload) => set((state) => ({
    totalPool: typeof payload.totalPool === 'number' ? payload.totalPool : state.totalPool,
    currentMembers: payload.currentMembers ?? state.currentMembers,
    history: [{ event: 'group:pool_updated', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setFlipStarted: (payload) => set((state) => ({
    flipStarted: true,
    status: payload.status ?? 'flipping',
    history: [{ event: 'group:flip_started', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setFlipResult: (payload) => set((state) => ({
    flipStarted: false,
    status: payload.status ?? 'resolved',
    flipResult: {
      winningSide: payload.winningSide,
      resultHash: payload.meta?.resultHash ?? payload.meta?.rawHash,
      serverSeedHash: payload.meta?.serverSeedHash,
      serverSeedReveal: payload.meta?.serverSeedReveal,
      clientSeed: payload.meta?.clientSeed,
      nonce: payload.meta?.nonce,
      roll: payload.meta?.roll,
    },
    history: [{ event: 'group:flip_result', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setInvite: (payload) => set((state) => ({
    lastInvite: {
      inviteId: payload.meta?.inviteId,
      tokenPrefix: payload.meta?.tokenPrefix,
      maxRedemptions: payload.meta?.maxRedemptions,
      expiresAt: payload.meta?.expiresAt,
    },
    history: [{ event: 'group:invite_created', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),

  setExpiryWarning: (payload) => set((state) => ({
    expiryWarning: {
      secondsLeft: payload.meta?.secondsLeft,
      expiresAt: payload.meta?.expiresAt,
    },
    history: [{ event: 'group:expiry_warning', payload, at: Date.now() }, ...state.history].slice(0, HISTORY_CAP),
  })),
}));

/**
 * Convenience: subscribe to a group room and pipe every event into
 * the store. Use this hook from the room page so the live group
 * state stays in sync without manual subscription bookkeeping.
 */
export function useGroupRoomSocket(groupId: string): void {
  // Lazy import to avoid bundling socket into the SSR critical path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useGroupBetSocket } = require('./useGroupBetSocket');
  const { reset, setState, setMember, setMemberLeft, setPool, setFlipStarted, setFlipResult, setInvite, setExpiryWarning } = useGroupStore.getState();
  reset(groupId);
  useGroupBetSocket({
    groupId,
    onEvent: (ev: string, payload: any) => {
      switch (ev) {
        case 'group:state_changed': setState(payload); break;
        case 'group:member_joined': setMember(payload); break;
        case 'group:member_left': setMemberLeft(payload); break;
        case 'group:pool_updated': setPool(payload); break;
        case 'group:flip_started': setFlipStarted(payload); break;
        case 'group:flip_result': setFlipResult(payload); break;
        case 'group:invite_created': setInvite(payload); break;
        case 'group:expiry_warning': setExpiryWarning(payload); break;
      }
    },
  });
}
