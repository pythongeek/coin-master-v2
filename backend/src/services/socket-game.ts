/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET GAME — game:bet, scatter:pick, chat:message
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14. Owns the game-flow socket events:
 *    - `game:bet` — place a coin-flip bet (spinning -> result)
 *    - `scatter:pick` — claim the pick-a-coin scatter bonus on a bet
 *    - `chat:message` — send a chat message (with spam protection)
 *
 *  Also emits win/rain broadcasts via `io.emit('chat:message', ...)`
 *  and `io.emit('rain:started', ...)`.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { placeBet } from './game-engine';
import { getConfig } from './admin-config';
import { getActiveSeed } from './server-seed';
import { query, db } from '../config/database';
import { redis } from '../config/redis';
import { AuthPayload } from '../middleware/auth';
import {
  delay,
  addToChatHistory,
  getActiveRain,
  type ChatMessage,
} from './socket-shared';

const MAX_CHAT_LENGTH = 200;
const CHAT_SPAM_LIMIT_PER_SECOND = 2;

export function registerGameHandlers(
  io: SocketIOServer,
  socket: Socket,
  user: AuthPayload | null,
  displayName: string,
): void {
  // ── game:bet — place a coin-flip bet ──────────────────────────
  socket.on('game:bet', async (data: {
    choice: 'heads' | 'tails';
    amount: number;
    clientSeed?: string;
    targetMultiplier?: number;
  }) => {
    if (!user) {
      return socket.emit('game:error', { message: 'Please log in to place a bet.' });
    }

    try {
      // Step 1: tell client the spin has started (with seed hash
      // for provably-fair verification).
      const activeSeed = await getActiveSeed();
      socket.emit('game:spinning', {
        message: 'Coin spinning...',
        timestamp: Date.now(),
        serverSeedHash: activeSeed?.serverSeedHash || null,
        seedId: activeSeed?.id || null,
      });

      // Step 2: run the bet through the game engine.
      const result = await placeBet({
        userId: user.userId,
        choice: data.choice,
        amount: data.amount,
        clientSeed: data.clientSeed,
        targetMultiplier: data.targetMultiplier,
      });

      // Step 3: wait for the coin-spin animation to play on the client.
      const config = await getConfig();
      await delay(config.coinSpinDurationMs);

      // Step 4: send the result.
      socket.emit('game:result', result);

      // Step 5: send the new balance.
      socket.emit('balance:update', { balance: result.newBalance });

      // Step 6: if the user won, broadcast to chat.
      if (result.won) {
        const winMsg: ChatMessage = {
          id: `win_${Date.now()}`,
          userId: user.userId,
          username: user.username,
          message: `🎉 ${user.username} won! +$${result.payout.toFixed(2)} | ${result.winStreak > 1 ? `${result.winStreak}-win streak! 🔥` : ''}`,
          timestamp: Date.now(),
          type: 'win',
        };
        addToChatHistory(winMsg);
        io.emit('chat:message', winMsg);
      }

      // Step 7: if a crypto rain was triggered, broadcast.
      if (result.cryptoRainTriggered) {
        const rainEvent = await getActiveRain();
        if (rainEvent) {
          const rainMsg: ChatMessage = {
            id: `rain_${Date.now()}`,
            userId: 'system',
            username: '🌧️ SYSTEM',
            message: `💸 CRYPTO RAIN! ${user.username}'s ${result.winStreak}-win streak triggered $${rainEvent.total_amount}! Claim fast!`,
            timestamp: Date.now(),
            type: 'rain',
          };
          addToChatHistory(rainMsg);
          io.emit('chat:message', rainMsg);
          io.emit('rain:started', {
            rainId: rainEvent.id,
            totalAmount: parseFloat(rainEvent.total_amount),
            maxClaims: rainEvent.max_claims,
            expiresAt: rainEvent.expires_at,
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      socket.emit('game:error', { message });
    }
  });

  // ── scatter:pick — claim the pick-a-coin scatter bonus ─────────
  // Client shows 3 mystery coins; when user taps one, the server
  // validates the pre-committed multiplier and credits the payout.
  socket.on('scatter:pick', async (data: { betId: string; pickIndex: number }) => {
    if (!user) {
      return socket.emit('game:error', {
        message: 'Please log in to claim the scatter bonus.',
      });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const betResult = await client.query(
        `SELECT id, user_id, scatter_hash, scatter_multiplier, scatter_payout, scatter_picked
         FROM bets WHERE id = $1 FOR UPDATE`,
        [data.betId],
      );

      if (!betResult.rows.length) {
        throw new Error('Bet not found.');
      }
      const bet = betResult.rows[0];
      if (bet.user_id !== user.userId) {
        throw new Error('This bonus does not belong to you.');
      }
      if (bet.scatter_picked) {
        throw new Error('Scatter bonus already claimed.');
      }
      if (!bet.scatter_hash || !bet.scatter_multiplier || !bet.scatter_payout) {
        throw new Error('This bet has no scatter bonus.');
      }
      if (data.pickIndex < 0 || data.pickIndex > 2) {
        throw new Error('Invalid coin pick.');
      }

      // Credit the scatter payout as withdrawable (real money, no wagering).
      const creditAmount = parseFloat(bet.scatter_payout);
      await client.query(
        'UPDATE users SET withdrawable_balance_coins = withdrawable_balance_coins + $1, updated_at = NOW() WHERE id = $2',
        [creditAmount, user.userId],
      );

      // Mark the bet's scatter as picked.
      await client.query(
        'UPDATE bets SET scatter_picked = true WHERE id = $1',
        [data.betId],
      );

      // Record a transaction for the scatter bonus credit.
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount, currency, direction, status, metadata, completed_at)
         VALUES ($1, $2, 'scatter_bonus', $3, 'USD', 'credit', 'confirmed', $4, NOW())`,
        [
          uuidv4(),
          user.userId,
          creditAmount,
          JSON.stringify({ bet_id: data.betId, pick_index: data.pickIndex, multiplier: bet.scatter_multiplier }),
        ],
      );

      await client.query('COMMIT');

      const newBalanceResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
      const newBalance = parseFloat(newBalanceResult.rows[0].balance);

      socket.emit('scatter:result', {
        betId: data.betId,
        pickIndex: data.pickIndex,
        multiplier: parseFloat(bet.scatter_multiplier),
        payout: creditAmount,
        newBalance,
        message: `🪙 Scatter bonus! ${bet.scatter_multiplier}x = $${creditAmount.toFixed(2)}`,
      });

      socket.emit('balance:update', { balance: newBalance });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      socket.emit('game:error', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  });

  // ── chat:message — send a chat message (with spam protection) ──
  socket.on('chat:message', async (data: { message: string }) => {
    if (!data.message?.trim()) return;

    // Spam protection: max 2 messages per second per socket.
    const spamKey = `chat_spam:${socket.id}`;
    const spamCount = await redis.incr(spamKey);
    if (spamCount === 1) await redis.expire(spamKey, 1);
    if (spamCount > CHAT_SPAM_LIMIT_PER_SECOND) {
      return socket.emit('game:error', {
        message: 'Slow down — max 2 messages per second.',
      });
    }

    const chatMsg: ChatMessage = {
      id: `msg_${Date.now()}_${socket.id.slice(0, 4)}`,
      userId: user?.userId || socket.id,
      username: displayName,
      message: data.message.slice(0, MAX_CHAT_LENGTH).trim(),
      timestamp: Date.now(),
      type: 'message',
    };

    addToChatHistory(chatMsg);
    io.emit('chat:message', chatMsg);
  });
}
