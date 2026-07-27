/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET STREAK — streak:bank
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14. Owns the streak ladder "bank" event. Players can cash out
 *  their win streak's accumulated bonus at any time before they lose
 *  a bet. The `bankStreakBonus` call lives in `services/game-engine.ts`.
 */

import type { Socket } from 'socket.io';
import { AuthPayload } from '../middleware/auth';

export function registerStreakHandlers(
  socket: Socket,
  user: AuthPayload | null,
): void {
  socket.on('streak:bank', async (payload, callback) => {
    try {
      // The streak ladder is per-user; rely on socket.data.userId set
      // by the lifecycle JWT middleware (always present for authed sockets).
      const data = socket.data as { userId?: string };
      const userId = data?.userId;
      if (!userId && !user) {
        return callback?.({ ok: false, message: 'Please log in first.' });
      }

      const targetId = userId ?? user!.userId;
      const { bankStreakBonus } = await import('./game-engine');
      const result = await bankStreakBonus(targetId);
      socket.emit('balance:update', { balance: result.newBalance });
      callback?.({ ok: true, ...result });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('streak:bank error:', err);
      callback?.({ ok: false, message: err.message || 'Bank failed.' });
    }
  });
}
