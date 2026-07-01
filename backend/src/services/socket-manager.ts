/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCKET MANAGER — রিয়েল-টাইম গেম ইঞ্জিন
 * ═══════════════════════════════════════════════════════════════
 *
 *  Socket.io দিয়ে ফ্রন্টএন্ড ও ব্যাকএন্ডের মধ্যে
 *  তাৎক্ষণিক যোগাযোগ পরিচালনা করে।
 *
 *  ইভেন্টের তালিকা:
 *  ──────────────────────────────────────────────────────────────
 *  ক্লায়েন্ট → সার্ভার:
 *    game:bet          → বেট ধরো
 *    game:verify       → রেজাল্ট যাচাই করো
 *    chat:message      → চ্যাটে বার্তা পাঠাও
 *    rain:claim        → Crypto Rain ক্লেইম করো
 *    squad:create      → নতুন স্কোয়াড তৈরি করো
 *    squad:join        → স্কোয়াডে যোগ দাও
 *    squad:flip        → স্কোয়াড ফ্লিপ শুরু করো
 *
 *  সার্ভার → ক্লায়েন্ট:
 *    game:spinning     → কয়েন ঘুরছে (অ্যানিমেশন শুরু)
 *    game:result       → রেজাল্ট এসেছে
 *    game:error        → কোনো সমস্যা হয়েছে
 *    balance:update    → ব্যালেন্স পরিবর্তন হয়েছে
 *    chat:message      → সবার কাছে চ্যাট বার্তা
 *    rain:started      → Crypto Rain শুরু হয়েছে
 *    rain:claimed      → ক্লেইম সফল
 *    squad:update      → স্কোয়াড স্ট্যাটাস আপডেট
 *    online:count      → লাইভ অনলাইন ইউজার সংখ্যা
 * ═══════════════════════════════════════════════════════════════
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { placeBet } from './game-engine';
import { generateServerSeed, hashServerSeed, computeFlip } from './provably-fair';
import { getConfig } from './admin-config';
import { query, db } from '../config/database';
import { redis } from '../config/redis';
import { AuthPayload } from '../middleware/auth';

// অনলাইন ইউজার ট্র্যাক করা
const onlineUsers = new Map<string, { userId: string; username: string; socketId: string }>();

// চ্যাট বার্তার ইতিহাস (শেষ ৫০টি মেমোরিতে)
const chatHistory: Array<{
  id: string; userId: string; username: string;
  message: string; timestamp: number; type: 'message' | 'win' | 'rain';
}> = [];

export function setupSocketHandlers(io: SocketIOServer) {

  // ── কানেকশনের আগে JWT যাচাই ──────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      // গেস্ট মোড — লগইন ছাড়া শুধু দেখতে পারবে, খেলতে পারবে না
      socket.data.user = null;
      socket.data.isGuest = true;
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret') as AuthPayload;
      socket.data.user = decoded;
      socket.data.isGuest = false;
      next();
    } catch {
      socket.data.user = null;
      socket.data.isGuest = true;
      next();
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AuthPayload | null;
    const displayName = user ? user.username : `অতিথি_${socket.id.slice(0, 4)}`;

    // অনলাইন তালিকায় যোগ করো
    if (user) {
      onlineUsers.set(socket.id, { userId: user.userId, username: user.username, socketId: socket.id });
    }

    console.log(`🔌 কানেক্টেড: ${displayName} (${socket.id})`);

    // সংযোগ হওয়া মাত্র অনলাইন সংখ্যা ও চ্যাট ইতিহাস পাঠাও
    socket.emit('init', {
      onlineCount: onlineUsers.size,
      chatHistory: chatHistory.slice(-30),
      isGuest: socket.data.isGuest,
    });

    // সবাইকে অনলাইন সংখ্যা জানাও
    io.emit('online:count', onlineUsers.size);

    // ══════════════════════════════════════════════════════════
    //  গেম ইভেন্ট: বেট ধরো
    // ══════════════════════════════════════════════════════════
    socket.on('game:bet', async (data: { choice: 'heads' | 'tails'; amount: number; clientSeed?: string; targetMultiplier?: number }) => {
      if (!user) {
        return socket.emit('game:error', { message: 'বেট ধরতে লগইন করুন।' });
      }

      try {
        // ধাপ ১: ব্যাকএন্ডে স্পিনিং সিগন্যাল পাঠাও (অ্যানিমেশন শুরু)
        socket.emit('game:spinning', {
          message: 'কয়েন ঘুরছে...',
          timestamp: Date.now(),
        });

        // ── ধাপ ২: গেম ইঞ্জিনে বেট প্রসেস করো ──
        const result = await placeBet({
          userId: user.userId,
          choice: data.choice,
          amount: data.amount,
          clientSeed: data.clientSeed,
          targetMultiplier: data.targetMultiplier,
        });

        // ধাপ ৩: কয়েন স্পিনের সময় অপেক্ষা করো (ফ্রন্টএন্ড অ্যানিমেশনের সাথে সিঙ্ক)
        const config = await getConfig();
        await delay(config.coinSpinDurationMs);

        // ধাপ ৪: রেজাল্ট পাঠাও
        socket.emit('game:result', result);

        // ধাপ ৫: ব্যালেন্স আপডেট পাঠাও
        socket.emit('balance:update', { balance: result.newBalance });

        // ধাপ ৬: জিতলে সবার চ্যাটে জানাও
        if (result.won) {
          const winMsg = {
            id: `win_${Date.now()}`,
            userId: user.userId,
            username: user.username,
            message: `🎉 ${user.username} জিতেছে! +$${result.payout.toFixed(2)} | ${result.winStreak > 1 ? `${result.winStreak} ধারাবাহিক জয়! 🔥` : ''}`,
            timestamp: Date.now(),
            type: 'win' as const,
          };
          addToChatHistory(winMsg);
          io.emit('chat:message', winMsg);
        }

        // ধাপ ৭: Crypto Rain ট্রিগার হলে সবাইকে জানাও
        if (result.cryptoRainTriggered) {
          const rainEvent = await getActiveRain();
          if (rainEvent) {
            const rainMsg = {
              id: `rain_${Date.now()}`,
              userId: 'system',
              username: '🌧️ SYSTEM',
              message: `💸 CRYPTO RAIN! ${user.username}-এর ${result.winStreak} জয়ের কারণে $${rainEvent.total_amount} ছাড়া হচ্ছে! দ্রুত ক্লেইম করুন!`,
              timestamp: Date.now(),
              type: 'rain' as const,
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

    // ══════════════════════════════════════════════════════════
    //  চ্যাট ইভেন্ট: বার্তা পাঠাও
    // ══════════════════════════════════════════════════════════
    socket.on('chat:message', async (data: { message: string }) => {
      if (!data.message?.trim()) return;

      // স্প্যাম প্রোটেকশন: প্রতি সেকেন্ডে সর্বোচ্চ ২টি বার্তা
      const spamKey = `chat_spam:${socket.id}`;
      const spamCount = await redis.incr(spamKey);
      if (spamCount === 1) await redis.expire(spamKey, 1);
      if (spamCount > 2) return socket.emit('game:error', { message: 'একটু ধীরে বার্তা পাঠান।' });

      const chatMsg = {
        id: `msg_${Date.now()}_${socket.id.slice(0, 4)}`,
        userId: user?.userId || socket.id,
        username: displayName,
        message: data.message.slice(0, 200).trim(),  // সর্বোচ্চ ২০০ অক্ষর
        timestamp: Date.now(),
        type: 'message' as const,
      };

      addToChatHistory(chatMsg);
      io.emit('chat:message', chatMsg);
    });

    // ══════════════════════════════════════════════════════════
    //  Crypto Rain ক্লেইম
    // ══════════════════════════════════════════════════════════
    socket.on('rain:claim', async (data: { rainId: string }) => {
      if (!user) return socket.emit('game:error', { message: 'ক্লেইম করতে লগইন করুন।' });

      try {
        const config = await getConfig();

        // Rain ইভেন্ট বৈধ কিনা চেক
        const rain = await query(
          `SELECT * FROM crypto_rain_events
           WHERE id = $1 AND status = 'active' AND expires_at > NOW()`,
          [data.rainId]
        );

        if (!rain.rows.length) {
          return socket.emit('game:error', { message: 'রেইন শেষ হয়ে গেছে বা ক্লেইম করার সময় পার হয়ে গেছে।' });
        }

        const rainEvent = rain.rows[0];

        // আগে ক্লেইম করেছে কিনা
        const alreadyClaimed = await query(
          'SELECT id FROM rain_claims WHERE rain_id = $1 AND user_id = $2',
          [data.rainId, user.userId]
        );
        if (alreadyClaimed.rows.length) {
          return socket.emit('game:error', { message: 'আপনি এই রেইন আগেই ক্লেইম করেছেন।' });
        }

        const claimAmount = config.rainClaimPerUserUsd;

        // ক্লেইম সেভ করো ও ব্যালেন্স বাড়াও
        await query(
          'INSERT INTO rain_claims (rain_id, user_id, amount) VALUES ($1, $2, $3)',
          [data.rainId, user.userId, claimAmount]
        );

        await query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [claimAmount, user.userId]
        );

        await query(
          `UPDATE crypto_rain_events
           SET claim_count = claim_count + 1,
               claimed_amount = claimed_amount + $1,
               status = CASE WHEN claim_count + 1 >= max_claims THEN 'exhausted' ELSE status END
           WHERE id = $2`,
          [claimAmount, data.rainId]
        );

        // নতুন ব্যালেন্স বের করো
        const balResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
        const newBalance = parseFloat(balResult.rows[0].balance);

        socket.emit('rain:claimed', { amount: claimAmount, newBalance });
        socket.emit('balance:update', { balance: newBalance });

        // বাকি কতটা ক্লেইম হয়েছে জানাও
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

    // ══════════════════════════════════════════════════════════
    //  স্কোয়াড ফ্লিপ
    // ══════════════════════════════════════════════════════════
    socket.on('squad:create', async (data: { betAmount: number; choice: 'heads' | 'tails' }) => {
      if (!user) return socket.emit('game:error', { message: 'স্কোয়াড বানাতে লগইন করুন।' });

      try {
        const config = await getConfig();
        if (!config.squadEnabled) {
          return socket.emit('game:error', { message: 'স্কোয়াড ফিচার বর্তমানে বন্ধ আছে।' });
        }

        const userResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
        if (!userResult.rows.length || parseFloat(userResult.rows[0].balance) < data.betAmount) {
          return socket.emit('game:error', { message: 'অপর্যাপ্ত ব্যালেন্স।' });
        }

        const squadId = require('crypto').randomUUID();
        const roomName = `squad_${squadId}`;

        await query(
          `INSERT INTO squads (id, creator_id, bet_amount_each, total_pool, choice, status)
           VALUES ($1, $2, $3, $3, $4, 'waiting')`,
          [squadId, user.userId, data.betAmount, data.choice]
        );

        await query(
          'INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)',
          [squadId, user.userId]
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

    socket.on('squad:join', async (data: { squadId: string }) => {
      if (!user) return socket.emit('game:error', { message: 'স্কোয়াডে যোগ দিতে লগইন করুন।' });

      try {
        const squad = await query(
          `SELECT s.*, COUNT(sm.user_id) as member_count
           FROM squads s LEFT JOIN squad_members sm ON s.id = sm.squad_id
           WHERE s.id = $1 AND s.status = 'waiting'
           GROUP BY s.id`,
          [data.squadId]
        );

        if (!squad.rows.length) {
          return socket.emit('game:error', { message: 'স্কোয়াড পাওয়া যায়নি বা ইতিমধ্যে শুরু হয়ে গেছে।' });
        }

        const sq = squad.rows[0];
        const config = await getConfig();

        if (parseInt(sq.member_count) >= config.maxSquadSize) {
          return socket.emit('game:error', { message: 'স্কোয়াড পূর্ণ হয়ে গেছে।' });
        }

        const userResult = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
        if (!userResult.rows.length || parseFloat(userResult.rows[0].balance) < parseFloat(sq.bet_amount_each)) {
          return socket.emit('game:error', { message: 'অপর্যাপ্ত ব্যালেন্স।' });
        }

        await query('INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)', [data.squadId, user.userId]);

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

        // সর্বনিম্ন ২ জন হলে রেডি
        if (updatedCount >= 2) {
          await query('UPDATE squads SET status = $1 WHERE id = $2', ['ready', data.squadId]);
        }

      } catch (err: unknown) {
        socket.emit('game:error', { message: String(err) });
      }
    });

    // ══════════════════════════════════════════════════════════
    //  স্কোয়াড ফ্লিপ — কয়েন ঘোরাও ও পেআউট সমান ভাগ করো
    //  শুধু স্কোয়াড ক্রিয়েটর এটি চালু করতে পারবে
    // ══════════════════════════════════════════════════════════
    socket.on('squad:flip', async (data: { squadId: string }) => {
      if (!user) return socket.emit('game:error', { message: 'লগইন করুন।' });

      const client = await db.connect();
      try {
        await client.query('BEGIN');

        const squad = await client.query(
          `SELECT s.*, COUNT(sm.user_id) as member_count
           FROM squads s LEFT JOIN squad_members sm ON s.id = sm.squad_id
           WHERE s.id = $1 GROUP BY s.id`,
          [data.squadId]
        );

        if (!squad.rows.length) {
          throw new Error('স্কোয়াড পাওয়া যায়নি।');
        }

        const sq = squad.rows[0];

        if (sq.creator_id !== user.userId) {
          throw new Error('শুধু স্কোয়াড ক্রিয়েটর ফ্লিপ শুরু করতে পারবে।');
        }

        if (sq.status !== 'ready' && sq.status !== 'waiting') {
          throw new Error('এই স্কোয়াড ইতিমধ্যে খেলা শুরু বা শেষ করেছে।');
        }

        const memberCount = parseInt(sq.member_count);
        if (memberCount < 2) {
          throw new Error('সর্বনিম্ন ২ জন সদস্য প্রয়োজন।');
        }

        // Lock member user rows to check and deduct balances atomically
        const membersResult = await client.query(
          `SELECT u.id, u.balance FROM users u 
           JOIN squad_members sm ON u.id = sm.user_id 
           WHERE sm.squad_id = $1 FOR UPDATE`,
          [data.squadId]
        );

        const betAmountEach = parseFloat(sq.bet_amount_each);

        for (const member of membersResult.rows) {
          if (parseFloat(member.balance) < betAmountEach) {
            throw new Error(`সদস্যের পর্যাপ্ত ব্যালেন্স নেই। গেম বাতিল করা হলো।`);
          }
        }

        // Deduct balances immediately and commit
        for (const member of membersResult.rows) {
          await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2',
            [betAmountEach, member.id]
          );
        }

        await client.query(
          `UPDATE squads SET status = 'playing' WHERE id = $1`,
          [data.squadId]
        );

        await client.query('COMMIT');

        const roomName = `squad_${data.squadId}`;
        io.to(roomName).emit('game:spinning', { message: 'স্কোয়াড কয়েন ঘুরছে...' });

        // Update frontends with immediate debit balance
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

        // ── Provably Fair রেজাল্ট কম্পিউট করো ──────────────────
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

        // Credit payout and finalize status in another atomic transaction
        await client.query('BEGIN');

        const finalMembers = await client.query(
          `SELECT u.id, u.balance FROM users u 
           JOIN squad_members sm ON u.id = sm.user_id 
           WHERE sm.squad_id = $1 FOR UPDATE`,
          [data.squadId]
        );

        if (won) {
          for (const member of finalMembers.rows) {
            await client.query(
              'UPDATE users SET balance = balance + $1 WHERE id = $2',
              [perPersonPayout, member.id]
            );
          }
        }

        for (const member of finalMembers.rows) {
          await client.query(
            'UPDATE squad_members SET payout = $1 WHERE squad_id = $2 AND user_id = $3',
            [won ? perPersonPayout : 0, data.squadId, member.id]
          );
        }

        await client.query(
          `UPDATE squads SET status = 'finished', result = $1, finished_at = NOW() WHERE id = $2`,
          [result, data.squadId]
        );

        await client.query('COMMIT');

        // ── ফলাফল সবাইকে পাঠাও ─────────────────────────────────
        io.to(roomName).emit('squad:result', {
          squadId: data.squadId,
          result,
          won,
          totalPool,
          perPersonPayout,
          memberCount,
          verification: { serverSeed, serverSeedHash, clientSeed, nonce: memberCount },
        });

        // ── প্রতিটি সদস্যের নতুন ব্যালেন্স আলাদাভাবে পাঠাও ───────
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

        // চ্যাটে জানাও
        if (won) {
          const msg = {
            id: `squad_win_${Date.now()}`,
            userId: 'system',
            username: '👥 SQUAD',
            message: `🎉 ${memberCount} জনের স্কোয়াড জিতেছে! প্রতিজন +$${perPersonPayout.toFixed(2)} পেয়েছে!`,
            timestamp: Date.now(),
            type: 'win' as const,
          };
          addToChatHistory(msg);
          io.emit('chat:message', msg);
        }

      } catch (err: unknown) {
        await client.query('ROLLBACK');
        socket.emit('game:error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        client.release();
      }
    });

    // ══════════════════════════════════════════════════════════
    //  ডিসকানেক্ট
    // ══════════════════════════════════════════════════════════
    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id);
      io.emit('online:count', onlineUsers.size);
      console.log(`❌ ডিসকানেক্টেড: ${displayName}`);
    });
  });
}

// ── হেলপার ফাংশন ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addToChatHistory(msg: typeof chatHistory[0]) {
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift();
}

async function getActiveRain() {
  const result = await query(
    `SELECT * FROM crypto_rain_events WHERE status = 'active' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}
