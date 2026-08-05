/**
 * ════════════════════════════════════════════════════════════════
 *  useGroupBetSocket — multiplayer room event subscription (Phase 1 / Day 7)
 *  ════════════════════════════════════════════════════════════════
 *
 *  React hook for consuming the 10 server → room socket events emitted
 *  by the group-bet backend (see backend/src/services/socket-group-bet.ts).
 *
 *  Two modes:
 *    1. **Member** — auto-joined to the room on connect (via the
 *       backend's auth handshake + `socket.data.user` presence). Listen
 *       for all 10 events with `useGroupBetSocket({ groupId })`.
 *
 *    2. **Spectator** — non-member joins the room via `group:spectate`
 *       client emit. Listen with `useGroupBetSocket({ groupId, spectator: true })`.
 *       The hook calls `socket.emit('group:spectate', { groupId })` on mount
 *       and `socket.emit('group:unspectate', { groupId })` on unmount.
 *
 *  Server → client events consumed (10):
 *    group:created   group:join        group:leave
 *    group:ready      group:flip_start  group:resolved
 *    group:cancelled  group:expired     group:frozen
 *    group:updated
 *
 *  Client → server events emitted (3):
 *    group:spectate      (mount, only when `spectator: true`)
 *    group:unspectate    (unmount, only when `spectator: true`)
 *    group:invite_share  (via `shareInvite()` return)
 *
 *  The hook returns the LAST received payload per event + a list of
 *  history entries (capped at 50) for the spectator/UI. Re-renders are
 *  guarded with a shallow-equal check so non-mutating events don't
 *  thrash the UI.
 * ════════════════════════════════════════════════════════════════
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getSocket } from './socket';

// ─── Event payload shapes ───────────────────────────────────────
// All 18 server events (v1 + Gap-1 v2). The hook attaches handlers
// for every event name regardless of which one the consumer actually
// uses, so adding new events is a single-line change here.
export type GroupBetEventName =
  | 'group:created'
  | 'group:join'
  | 'group:leave'
  | 'group:ready'
  | 'group:flip_start'
  | 'group:resolved'
  | 'group:cancelled'
  | 'group:expired'
  | 'group:frozen'
  | 'group:updated'
  | 'group:state_changed'
  | 'group:member_joined'
  | 'group:member_left'
  | 'group:pool_updated'
  | 'group:flip_started'
  | 'group:flip_result'
  | 'group:invite_created'
  | 'group:expiry_warning';

export interface GroupBetEventPayload {
  groupId: string;
  shortCode?: string;
  status?: string;
  currentMembers?: number;
  maxMembers?: number;
  totalPool?: number;
  winningSide?: 'heads' | 'tails';
  actorUserId?: string;
  meta?: Record<string, unknown>;
  ts?: string;
  [k: string]: unknown;
}

export interface GroupBetHistoryEntry {
  event: GroupBetEventName;
  payload: GroupBetEventPayload;
  receivedAt: number;
}

export interface UseGroupBetSocketOptions {
  groupId: string;
  spectator?: boolean;
  /** Maximum history entries to retain (default 50). */
  historyCap?: number;
  /** Optional callback fired for every event (in addition to state update). */
  onEvent?: (event: GroupBetEventName, payload: GroupBetEventPayload) => void;
  /** Disable hook (e.g., while route is unmounting). Default false. */
  disabled?: boolean;
}

export interface UseGroupBetSocketResult {
  /** Last payload received for each event type (null until first emit). */
  lastByEvent: Partial<Record<GroupBetEventName, GroupBetEventPayload>>;
  /** Most recent event (regardless of type). */
  latest: GroupBetHistoryEntry | null;
  /** Rolling history, newest first, capped at historyCap. */
  history: GroupBetHistoryEntry[];
  /** Live status (latest status string from any event). */
  liveStatus: string | null;
  /** Last known total pool (number). */
  liveTotalPool: number | null;
  /** Last known currentMembers (number). */
  liveCurrentMembers: number | null;
  /** Emit `group:invite_share` with a channel tag. Returns boolean (true if socket connected). */
  shareInvite: (channel: 'whatsapp' | 'telegram' | 'twitter' | 'email' | 'copy' | 'qr' | 'link') => boolean;
}

const ALL_EVENTS: GroupBetEventName[] = [
  'group:created',
  'group:join',
  'group:leave',
  'group:ready',
  'group:flip_start',
  'group:resolved',
  'group:cancelled',
  'group:expired',
  'group:frozen',
  'group:updated',
  // Gap 1 fine-grained events:
  'group:state_changed',
  'group:member_joined',
  'group:member_left',
  'group:pool_updated',
  'group:flip_started',
  'group:flip_result',
  'group:invite_created',
  'group:expiry_warning',
];

export function useGroupBetSocket(opts: UseGroupBetSocketOptions): UseGroupBetSocketResult {
  const { groupId, spectator = false, historyCap = 50, onEvent, disabled = false } = opts;

  const [lastByEvent, setLastByEvent] = useState<Partial<Record<GroupBetEventName, GroupBetEventPayload>>>({});
  const [latest, setLatest] = useState<GroupBetHistoryEntry | null>(null);
  const [history, setHistory] = useState<GroupBetHistoryEntry[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveTotalPool, setLiveTotalPool] = useState<number | null>(null);
  const [liveCurrentMembers, setLiveCurrentMembers] = useState<number | null>(null);

  // Keep latest callback in a ref so we don't re-subscribe on every render.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (disabled || !groupId) return;
    const socket = getSocket();

    const handler = (event: GroupBetEventName) => (payload: GroupBetEventPayload) => {
      if (!payload || payload.groupId !== groupId) return;
      const entry: GroupBetHistoryEntry = { event, payload, receivedAt: Date.now() };

      setLastByEvent(prev => {
        const cur = prev[event];
        // Shallow-equal guard: skip re-render if payload unchanged.
        if (cur && JSON.stringify(cur) === JSON.stringify(payload)) return prev;
        return { ...prev, [event]: payload };
      });
      setLatest(entry);
      setHistory(prev => [entry, ...prev].slice(0, historyCap));
      if (typeof payload.status === 'string') setLiveStatus(payload.status);
      if (typeof payload.totalPool === 'number') setLiveTotalPool(payload.totalPool);
      if (typeof payload.currentMembers === 'number') setLiveCurrentMembers(payload.currentMembers);

      onEventRef.current?.(event, payload);
    };

    // Attach one listener per event name.
    const handlers: Array<{ event: string; fn: any }> = [];
    for (const ev of ALL_EVENTS) {
      const fn = handler(ev);
      socket.on(ev, fn);
      handlers.push({ event: ev, fn });
    }

    // Member mode: the backend auto-joins the user to group_<id> room
    // when they connect (because the auth handshake sets socket.data.user
    // AND the joinGroupBet socket-side hook calls socket.join on join).
    // Spectator mode: emit group:spectate to opt in explicitly.
    if (spectator) {
      socket.emit('group:spectate', { groupId });
    }

    return () => {
      for (const { event, fn } of handlers) socket.off(event, fn);
      if (spectator) {
        socket.emit('group:unspectate', { groupId });
      }
    };
  }, [groupId, spectator, historyCap, disabled]);

  const shareInvite = useCallback((channel: 'whatsapp' | 'telegram' | 'twitter' | 'email' | 'copy' | 'qr' | 'link') => {
    const socket = getSocket();
    if (!socket.connected) return false;
    socket.emit('group:invite_share', { groupId, channel });
    return true;
  }, [groupId]);

  return {
    lastByEvent,
    latest,
    history,
    liveStatus,
    liveTotalPool,
    liveCurrentMembers,
    shareInvite,
  };
}