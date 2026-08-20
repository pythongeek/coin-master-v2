/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET RAIN — rain:claim
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14. Handles the `rain:claim` event from clients who want to
 *  claim a share of an active crypto rain event. See
 *  `services/bonus.ts` for the matching `startCryptoRain` flow.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { query } from '../config/database';
import { getConfig } from './admin-config';
import { AuthPayload } from '../middleware/auth';

export function registerRainHandlers(
  io: SocketIOServer,
  socket: Socket,
  user: AuthPayload | null,
): void {
  socket.on('rain:claim', async (data: { rainId: string }) => {
    if (!user) {
      return socket.emit('game:error', {
        message: 'Please log in to claim.',
      });
    }

    try {
      const config = await getConfig();

      // Check that the rain event is still active.
      const rain = await query(
        `SELECT * FROM crypto_rain_events
         WHERE id = $1 AND status = 'active' AND expires_at > NOW()`,
        [data.rainId],
      );

      if (!rain.rows.length) {
        return socket.emit('game:error', {
          message: 'Rain has ended or the claim window expired.',
        });
      }

      const rainEvent = rain.rows[0];

      // Has this user already claimed?
      const alreadyClaimed = await query(
        'SELECT id FROM rain_claims WHERE rain_id = $1 AND user_id = $2',
        [data.rainId, user.userId],
      );
      if (alreadyClaimed.rows.length) {
        return socket.emit('game:error', {
          message: 'You already claimed this rain.',
        });
      }

      const claimAmount = config.rainClaimPerUserUsd;

      // Save the claim and credit the user's balance.
      await query(
        'INSERT INTO rain_claims (rain_id, user_id, amount) VALUES ($1, $2, $3)',
        [data.rainId, user.userId, claimAmount],
      );

      await query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [claimAmount, user.userId],
      );

      await query(
        `UPDATE crypto_rain_events
         SET claim_count = claim_count + 1,
             claimed_amount = claimed_amount + $1,
             status = CASE WHEN claim_count + 1 >= max_claims THEN 'exhausted' ELSE status END
         WHERE id = $2`,
        [claimAmount, data.rainId],
      );

      // Get the new balance.
      const balResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
      const newBalance = parseFloat(balResult.rows[0].balance);

      socket.emit('rain:claimed', { amount: claimAmount, newBalance });
      socket.emit('balance:update', { balance: newBalance });

      // Broadcast how many claims remain.
      io.emit('rain:update', {
        rainId: data.rainId,
        claimCount: rainEvent.claim_count + 1,
        maxClaims: rainEvent.max_claims,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      socket.emit('game:error', { message });
    }
  });
}
