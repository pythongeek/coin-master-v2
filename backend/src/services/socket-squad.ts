/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET SQUAD — squad:create, squad:join, squad:flip
 *  ─────────────────────────────────────────────────────────────
 *
 *  P2-14. Owns the squad-flip flow:
 *    - `squad:create` — Creator opens a squad with a bet amount + choice
 *    - `squad:join` — Other users join (up to maxSquadSize)
 *    - `squad:flip` — Creator flips the coin; provably-fair result
 *      is computed and broadcast to all members
 *
 *  The squad-flip handler is the largest single block (180 lines)
 *  because it does:
 *    - Atomic balance debit (FOR UPDATE locks)
 *    - Provably-fair random generation
 *    - Per-member payout credit
 *    - Chat broadcast on win
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import crypto from 'crypto';
import { query, db } from '../config/database';
import { getConfig } from './admin-config';
import { generateServerSeed, hashServerSeed, computeFlip } from './provably-fair';
import { delay, addToChatHistory, onlineUsers, type ChatMessage } from './socket-shared';
import { AuthPayload } from '../middleware/auth';

export function registerSquadHandlers(
  io: SocketIOServer,
  socket: Socket,
  user: AuthPayload | null,
): void {
  // ── squad:create — open a new squad ─────────────────────────
  socket.on('squad:create', async (data: { betAmount: number; choice: 'heads' | 'tails' }) => {
    if (!user) {
      return socket.emit('game:error', { message: 'Please log in to create a squad.' });
    }

    try {
      const config = await getConfig();
      if (!config.squadEnabled) {
        return socket.emit('game:error', { message: 'Squad feature is currently disabled.' });
      }

      const userResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
      if (!userResult.rows.length || parseFloat(userResult.rows[0].balance) < data.betAmount) {
        return socket.emit('game:error', { message: 'Insufficient balance.' });
      }

      const squadId = crypto.randomUUID();
      const roomName = `squad_${squadId}`;

      await query(
        `INSERT INTO squads (id, creator_id, bet_amount_each, total_pool, choice, status)
         VALUES ($1, $2, $3, $3, $4, 'waiting')`,
        [squadId, user.userId, data.betAmount, data.choice],
      );

      await query(
        'INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)',
        [squadId, user.userId],
      );

      socket.join(roomName);

      socket.emit('squad:created', {
        squadId,
        creatorUsername: user.username,
        betAmount: data.betAmount,
        choice: data.choice,
        memberCount: 1,
        maxMembers: config.maxSquadSize,
      });
    } catch (err: unknown) {
      socket.emit('game:error', { message: String(err) });
    }
  });

  // ── squad:join — join an open squad ───────────────────────────
  socket.on('squad:join', async (data: { squadId: string }) => {
    if (!user) {
      return socket.emit('game:error', { message: 'Please log in to join a squad.' });
    }

    try {
      const squad = await query(
        `SELECT s.*, COUNT(sm.user_id) as member_count
         FROM squads s LEFT JOIN squad_members sm ON s.id = sm.squad_id
         WHERE s.id = $1 AND s.status = 'waiting'
         GROUP BY s.id`,
        [data.squadId],
      );

      if (!squad.rows.length) {
        return socket.emit('game:error', {
          message: 'Squad not found or already started.',
        });
      }

      const sq = squad.rows[0];
      const config = await getConfig();

      if (parseInt(sq.member_count) >= config.maxSquadSize) {
        return socket.emit('game:error', { message: 'Squad is full.' });
      }

      const userResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
      if (
        !userResult.rows.length ||
        parseFloat(userResult.rows[0].balance) < parseFloat(sq.bet_amount_each)
      ) {
        return socket.emit('game:error', { message: 'Insufficient balance.' });
      }

      await query('INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)', [
        data.squadId,
        user.userId,
      ]);

      socket.join(`squad_${data.squadId}`);

      const updatedCount = parseInt(sq.member_count) + 1;
      const squadInfo = {
        squadId: data.squadId,
        betAmount: parseFloat(sq.bet_amount_each),
        memberCount: updatedCount,
        maxMembers: config.maxSquadSize,
        isReady: updatedCount >= 2,
      };

      io.to(`squad_${data.squadId}`).emit('squad:update', squadInfo);

      // Mark ready when minimum reached.
      if (updatedCount >= 2) {
        await query('UPDATE squads SET status = $1 WHERE id = $2', ['ready', data.squadId]);
      }
    } catch (err: unknown) {
      socket.emit('game:error', { message: String(err) });
    }
  });

  // ── squad:flip — creator flips the coin ───────────────────────
  socket.on('squad:flip', async (data: { squadId: string }) => {
    if (!user) {
      return socket.emit('game:error', { message: 'Please log in.' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const squad = await client.query(
        `SELECT s.*, COUNT(sm.user_id) as member_count
         FROM squads s LEFT JOIN squad_members sm ON s.id = sm.squad_id
         WHERE s.id = $1 GROUP BY s.id`,
        [data.squadId],
      );

      if (!squad.rows.length) {
        throw new Error('Squad not found.');
      }

      const sq = squad.rows[0];

      if (sq.creator_id !== user.userId) {
        throw new Error('Only the squad creator can flip.');
      }

      if (sq.status !== 'ready' && sq.status !== 'waiting') {
        throw new Error('This squad has already started or finished.');
      }

      const memberCount = parseInt(sq.member_count);
      if (memberCount < 2) {
        throw new Error('At least 2 members required.');
      }

      // Lock member user rows to check and deduct balances atomically.
      const membersResult = await client.query(
        `SELECT u.id, u.balance FROM users u
         JOIN squad_members sm ON u.id = sm.user_id
         WHERE sm.squad_id = $1 FOR UPDATE`,
        [data.squadId],
      );

      const betAmountEach = parseFloat(sq.bet_amount_each);

      for (const member of membersResult.rows) {
        if (parseFloat(member.balance) < betAmountEach) {
          throw new Error(`Member has insufficient balance. Game cancelled.`);
        }
      }

      // Deduct balances immediately and commit.
      for (const member of membersResult.rows) {
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [
          betAmountEach,
          member.id,
        ]);
      }

      await client.query(`UPDATE squads SET status = 'playing' WHERE id = $1`, [data.squadId]);

      await client.query('COMMIT');

      const roomName = `squad_${data.squadId}`;
      io.to(roomName).emit('game:spinning', { message: 'Squad coin spinning...' });

      // Push immediate-debit balance updates.
      for (const member of membersResult.rows) {
        const balResult = await query('SELECT balance FROM users WHERE id = $1', [member.id]);
        const memberSocketId = [...onlineUsers.entries()]
          .find(([, v]) => v.userId === member.id)?.[0];
        if (memberSocketId) {
          io.to(memberSocketId).emit('balance:update', {
            balance: parseFloat(balResult.rows[0].balance),
          });
        }
      }

      const config = await getConfig();

      // ── Compute provably-fair result ──────────────────────────
      const serverSeed = generateServerSeed();
      const serverSeedHash = hashServerSeed(serverSeed);
      const clientSeed = `squad_${data.squadId}`;
      const { result } = computeFlip(serverSeed, clientSeed, memberCount);

      const won = result === sq.choice;
      const totalPool = betAmountEach * memberCount;
      const houseEdge = config.squadHouseEdgePercent;
      const totalPayout = won
        ? parseFloat((totalPool * (1 - houseEdge / 100)).toFixed(8))
        : 0;
      const perPersonPayout = won
        ? parseFloat((totalPayout / memberCount).toFixed(8))
        : 0;

      await delay(config.coinSpinDurationMs);

      // Credit payouts and finalize status in a second atomic tx.
      await client.query('BEGIN');

      const finalMembers = await client.query(
        `SELECT u.id, u.balance FROM users u
         JOIN squad_members sm ON u.id = sm.user_id
         WHERE sm.squad_id = $1 FOR UPDATE`,
        [data.squadId],
      );

      if (won) {
        for (const member of finalMembers.rows) {
          await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [
            perPersonPayout,
            member.id,
          ]);
        }
      }

      for (const member of finalMembers.rows) {
        await client.query(
          'UPDATE squad_members SET payout = $1 WHERE squad_id = $2 AND user_id = $3',
          [won ? perPersonPayout : 0, data.squadId, member.id],
        );
      }

      await client.query(
        `UPDATE squads SET status = 'finished', result = $1, finished_at = NOW() WHERE id = $2`,
        [result, data.squadId],
      );

      await client.query('COMMIT');

      // ── Broadcast result to all members ─────────────────────
      io.to(roomName).emit('squad:result', {
        squadId: data.squadId,
        result,
        won,
        totalPool,
        perPersonPayout,
        memberCount,
        verification: { serverSeed, serverSeedHash, clientSeed, nonce: memberCount },
      });

      // ── Push per-member balance updates ───────────────────
      for (const member of finalMembers.rows) {
        const balResult = await query('SELECT balance FROM users WHERE id = $1', [member.id]);
        const memberSocketId = [...onlineUsers.entries()]
          .find(([, v]) => v.userId === member.id)?.[0];
        if (memberSocketId) {
          io.to(memberSocketId).emit('balance:update', {
            balance: parseFloat(balResult.rows[0].balance),
          });
        }
      }

      // ── Chat broadcast on win ──────────────────────────────
      if (won) {
        const winMsg: ChatMessage = {
          id: `squad_win_${Date.now()}`,
          userId: 'system',
          username: '👥 SQUAD',
          message: `🎉 ${memberCount}-player squad won! +$${perPersonPayout.toFixed(2)} each!`,
          timestamp: Date.now(),
          type: 'win',
        };
        addToChatHistory(winMsg);
        io.emit('chat:message', winMsg);
      }
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      socket.emit('game:error', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  });
}
