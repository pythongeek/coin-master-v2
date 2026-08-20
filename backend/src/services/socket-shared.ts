/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET SHARED STATE — connection-scoped helpers
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14 split the original 698-line `socket-manager.ts` into
 *  domain modules (game, scatter, chat, rain, squad, streak,
 *  lifecycle). All handlers shared three pieces of state:
 *
 *   1. **`onlineUsers`** — Map of currently-connected users
 *   2. **`chatHistory`** — Last 50 chat/win/rain messages
 *   3. **`helpers`** — delay, addToChatHistory, getActiveRain
 *
 *  This module exports the SHARED state object + helpers so each
 *  domain module can operate on them without circular imports.
 *
 *  The split keeps:
 *    - `onlineUsers` / `chatHistory` as MODULE-LEVEL state (shared
 *      across all socket connections — necessary for cross-client
 *      events like `online:count`).
 *    - `delay` / `addToChatHistory` / `getActiveRain` as PURE helpers.
 *
 *  `socket-manager.ts` is now a thin orchestrator that initializes
 *  the state and dispatches to each domain handler module.
 */

import { query } from '../config/database';

export interface OnlineUser {
  userId: string;
  username: string;
  socketId: string;
}

/** Map of currently-connected sockets to their user info. */
export const onlineUsers = new Map<string, OnlineUser>();

/** Chat message shape — used by chat:message, win broadcasts, and rain broadcasts. */
export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  message: string;
  timestamp: number;
  type: 'message' | 'win' | 'rain';
}

/** Last 50 messages (rolling buffer for new joiners). */
export const chatHistory: Array<ChatMessage> = [];

/** Pause for N ms — used by game:bet to wait for the coin animation. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append a message and trim to the rolling 50-message window. */
export function addToChatHistory(msg: ChatMessage): void {
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift();
}

/** Look up the currently-active crypto rain event (most recent unexpired). */
export async function getActiveRain(): Promise<any | null> {
  const result = await query(
    `SELECT * FROM crypto_rain_events
     WHERE status = 'active' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0] || null;
}
