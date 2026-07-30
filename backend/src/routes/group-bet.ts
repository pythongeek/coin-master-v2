/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — /api/group-bet (Phase 1, Day 2)
 *  ════════════════════════════════════════════════════════════════
 *
 *  Endpoints shipped in Day 2 (the public/auth subset):
 *    1.  POST /api/group-bet                      — create room
 *    2.  POST /api/group-bet/:id/join             — join room
 *    5.  POST /api/group-bet/:id/share            — log invite share
 *    6.  GET  /api/group-bet/:id                  — view (joined members see all)
 *    7.  GET  /api/group-bet/by-code/:shortCode   — public preview
 *
 *  Day-3/4 endpoints (left as TODO with route stubs to keep the
 *  file structure stable):
 *    3.  POST /api/group-bet/:id/leave            (Day 4)
 *    4.  POST /api/group-bet/:id/cancel           (Day 4)
 *    8.  GET  /api/group-bet/me/active            (Day 5)
 *    9.  GET  /api/group-bet/me/history           (Day 5)
 *   10.  POST /api/group-bet/:id/flip             (Day 3 — provably-fair)
 *   11-15. /api/admin/groups/*                    (Day 6)
 *
 *  Each endpoint maps `GroupBet*Error` subclasses to HTTP status codes
 *  via a single `mapError()` helper. The defensive layering matches
 *  the existing `routes/game.ts` pattern (authMiddleware → gameLimiter
 *  → fraudGuard → validateBody → handler).
 *
 *  Response envelope (matches /api/game/bet):
 *    { success: true,  data: {...} }
 *    { success: false, error: "...", code: "..." }
 * ════════════════════════════════════════════════════════════════
 */

import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { validateBody, validateParams } from '../middleware/validation';
import { fraudGuard } from '../middleware/fraud-guard';
import { groupLimiter } from '../middleware/rate-limiter';
import {
  groupBetCreateSchema,
  groupBetJoinSchema,
  groupBetShareSchema,
  groupBetFlipSchema,
} from '../schemas';
import {
  createGroupBet,
  GroupBetValidationError,
  GroupBetNotAllowedError,
  GroupBetInsufficientBalanceError,
  GroupBetDuplicateError,
  GroupBetInternalError,
} from '../services/group-bet-create';
import { joinGroupBet } from '../services/group-bet-join';
import { flipGroup } from '../services/group-bet-flip';
import { GroupBetTransitionError } from '../services/group-bet-state';
import { z } from 'zod';

const router = Router();

interface AuthedRequest extends Request {
  user: AuthPayload;
}

function mapGroupError(e: unknown, res: Response): boolean {
  if (e instanceof GroupBetValidationError) {
    res.status(400).json({ success: false, error: e.message, code: e.code });
    return true;
  }
  if (e instanceof GroupBetDuplicateError) {
    res.status(409).json({
      success: false,
      error: e.message,
      code: e.code,
      existingGroupId: e.existingGroupId,
    });
    return true;
  }
  if (e instanceof GroupBetInsufficientBalanceError) {
    res.status(402).json({
      success: false,
      error: e.message,
      code: e.code,
      balance: e.balance,
      required: e.required,
    });
    return true;
  }
  if (e instanceof GroupBetNotAllowedError) {
    res.status(403).json({ success: false, error: e.message, code: e.code });
    return true;
  }
  if (e instanceof GroupBetTransitionError) {
    res.status(409).json({ success: false, error: e.message, code: e.code });
    return true;
  }
  if (e instanceof GroupBetInternalError) {
    res.status(500).json({ success: false, error: e.message, code: e.code });
    return true;
  }
  return false; // not handled
}

// ─── Param schema (used by routes that take :id) ──────────────────
const idParamSchema = z.object({
  id: z.string().min(8).max(64),
});

const shortCodeParamSchema = z.object({
  shortCode: z.string().min(4).max(10),
});

// ─── 1. POST /api/group-bet — create room ─────────────────────────
router.post(
  '/',
  groupLimiter,
  authMiddleware,
  validateBody(groupBetCreateSchema),
  fraudGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const out = await createGroupBet({
        userId: user.userId,
        creatorChoice: req.body.creatorChoice,
        creatorStake: req.body.creatorStake,
        perMemberStake: req.body.perMemberStake,
        minMembers: req.body.minMembers,
        maxMembers: req.body.maxMembers,
        payoutMode: req.body.payoutMode,
        turnMode: req.body.turnMode,
        autoFlipSeconds: req.body.autoFlipSeconds,
        inviteChannel: req.body.inviteChannel,
        clientRequestId: req.body.clientRequestId,
        ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
      });
      return res.status(201).json({
        success: true,
        data: {
          ...out,
          shareUrl: `/g/${out.shortCode}`,
        },
      });
    } catch (e) {
      if (mapGroupError(e, res)) return;
      next(e);
    }
  },
);

// ─── 2. POST /api/group-bet/:id/join — join room ──────────────────
router.post(
  '/:id/join',
  groupLimiter,
  authMiddleware,
  validateParams(idParamSchema),
  validateBody(groupBetJoinSchema),
  fraudGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const out = await joinGroupBet({
        userId: user.userId,
        groupIdentifier: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
        choice: req.body.choice,
        stakeOverride: req.body.stakeOverride,
        clientRequestId: req.body.clientRequestId,
        ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
      });
      return res.status(201).json({ success: true, data: out });
    } catch (e) {
      if (mapGroupError(e, res)) return;
      next(e);
    }
  },
);

// ─── 10. POST /api/group-bet/:id/flip — provably-fair resolve ─────
router.post(
  '/:id/flip',
  authMiddleware,
  validateParams(idParamSchema),
  validateBody(groupBetFlipSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const out = await flipGroup({
        userId: user.userId,
        groupIdentifier: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
        clientSeed: req.body.clientSeed,
        ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
      });
      return res.status(200).json({ success: true, data: out });
    } catch (e) {
      if (mapGroupError(e, res)) return;
      next(e);
    }
  },
);

// ─── 3-4. POST /api/group-bet/:id/leave | /cancel — Day-4 stubs ───
router.post(
  '/:id/leave',
  authMiddleware,
  validateParams(idParamSchema),
  async (_req: Request, res: Response) => {
    return res.status(501).json({
      success: false,
      error: 'group-bet:leave not yet implemented (Day 4)',
      code: 'NOT_IMPLEMENTED',
    });
  },
);
router.post(
  '/:id/cancel',
  authMiddleware,
  validateParams(idParamSchema),
  async (_req: Request, res: Response) => {
    return res.status(501).json({
      success: false,
      error: 'group-bet:cancel not yet implemented (Day 4)',
      code: 'NOT_IMPLEMENTED',
    });
  },
);

// ─── 5. POST /api/group-bet/:id/share — log invite channel ────────
router.post(
  '/:id/share',
  authMiddleware,
  validateParams(idParamSchema),
  validateBody(groupBetShareSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const id = req.params.id;
      const r = await query<{ id: string; creator_id: string; status: string }>(
        `SELECT id, creator_id, status FROM group_bet WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      // Anyone can share a room — record the channel attribution.
      const userAgent = req.headers['user-agent'];
      await query(
        `INSERT INTO group_bet_invite
           (group_id, inviter_id, channel, ip_address, user_agent)
         VALUES ($1, $2, $3, $4::inet, $5)`,
        [id, user.userId, req.body.channel, req.ip ?? null, Array.isArray(userAgent) ? userAgent[0] : userAgent ?? null],
      );
      return res.status(201).json({ success: true, data: { groupId: id, channel: req.body.channel } });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 6. GET /api/group-bet/:id — full view (joined members see all) ─
router.get(
  '/:id',
  authMiddleware,
  validateParams(idParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const id = req.params.id;
      const group = await query<any>(
        `SELECT g.*, COUNT(m.id)::int AS member_count
           FROM group_bet g
      LEFT JOIN group_bet_member m ON m.group_id = g.id
          WHERE g.id = $1
       GROUP BY g.id
          LIMIT 1`,
        [id],
      );
      if (!group.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      const g = group.rows[0];
      const isMember = await query(
        `SELECT 1 FROM group_bet_member WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
        [id, user.userId],
      );
      const members = isMember.rows.length
        ? (await query<any>(
            `SELECT user_id, role, choice, stake::text AS stake, weight::text AS weight,
                    joined_at, payout_amount::text AS payout, is_winner
               FROM group_bet_member WHERE group_id = $1 ORDER BY joined_at ASC`,
            [id],
          )).rows
        : [];
      return res.status(200).json({
        success: true,
        data: {
          id: g.id,
          shortCode: g.short_code,
          status: g.status,
          creatorId: g.creator_id,
          creatorChoice: g.creator_choice,
          creatorStake: g.creator_stake,
          perMemberStake: g.per_member_stake,
          totalPool: g.total_pool,
          minMembers: g.min_members,
          maxMembers: g.max_members,
          currentMembers: g.current_members,
          payoutMode: g.payout_mode,
          turnMode: g.turn_mode,
          autoFlipSeconds: g.auto_flip_seconds,
          expiresAt: g.expires_at,
          readyAt: g.ready_at,
          resolvedAt: g.resolved_at,
          winningSide: g.winning_side,
          members,
          shareUrl: `/g/${g.short_code}`,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 7. GET /api/group-bet/by-code/:shortCode — public preview ───
router.get(
  '/by-code/:shortCode',
  validateParams(shortCodeParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await query<any>(
        `SELECT short_code, status, creator_choice, total_pool::text AS total_pool,
                min_members, max_members, current_members, payout_mode, turn_mode,
                expires_at, ready_at
           FROM group_bet
          WHERE short_code = $1
          LIMIT 1`,
        [req.params.shortCode],
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      const g = r.rows[0];
      return res.status(200).json({
        success: true,
        data: {
          shortCode: g.short_code,
          status: g.status,
          creatorChoice: g.creator_choice,
          totalPool: g.total_pool,
          minMembers: g.min_members,
          maxMembers: g.max_members,
          currentMembers: g.current_members,
          seatsRemaining: g.max_members - g.current_members,
          payoutMode: g.payout_mode,
          turnMode: g.turn_mode,
          expiresAt: g.expires_at,
          readyAt: g.ready_at,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
