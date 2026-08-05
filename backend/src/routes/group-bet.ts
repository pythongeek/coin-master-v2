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
 *   16-18. Day 10 lobby endpoints (Phase 2 §1.4 rows 10, 12, 11):
 *     16.  GET  /api/group-bet/lobby              — public/discoverable open rooms
 *     17.  GET  /api/group-bet/friends/active     — rooms where anyone in the
 *                                                  requester's friend-graph has
 *                                                  joined or created (Day 5 stub
 *                                                  used me/active path).
 *     18.  GET  /api/group-bet/user/history        — every room the requester
 *                                                  has CREATED or JOINED, any
 *                                                  status, newest first.
 *   19-21. Day 11 invite endpoints (Phase 2 §2.4):
 *     19.  POST /api/group-bet/:id/invite         — creator generates a share link
 *     20.  GET  /api/group-bet/invites/:token     — public resolver (sanitized)
 *     21.  POST /api/group-bet/invites/:token/redeem — redeem + credit bonus + join
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
import { validateBody, validateParams, validateQuery } from '../middleware/validation';
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
import { leaveGroupBet, cancelGroupBet, GroupBetLeaveError } from '../services/group-bet-leave';
import { GroupBetTransitionError } from '../services/group-bet-state';
import { listOpenGroups, listFriendsActiveGroups, listUserHistory } from '../services/group-bet-lobby';
import { createInvite, resolveInvite, redeemInvite, InviteError } from '../services/group-bet-invite';
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

// ─── Lobby query schemas (Day 10) ────────────────────────────────
const lobbyFiltersSchema = z.object({
  gameType: z.enum(['coinflip', 'dice', 'crash', 'plinko', 'limbo']).optional(),
  payoutMode: z.enum(['equal', 'proportional', 'founder_boost']).optional(),
  minPool: z.coerce.number().positive().optional(),
  maxPool: z.coerce.number().positive().optional(),
  minMembersRequired: z.coerce.number().int().min(1).max(10).optional(),
  creatorTierAtLeast: z.coerce.number().int().min(0).max(3).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  viewerCountry: z.string().length(2).regex(/^[A-Za-z]+$/).optional(),
});

const userHistoryQuerySchema = z.object({
  status: z.string().optional(), // comma-separated list
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

const friendsActiveQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// Day 11 invite-token schemas
const createInviteBodySchema = z.object({
  maxRedemptions: z.coerce.number().int().min(1).max(100).optional(),
  expiresInHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  channel: z.enum(['whatsapp','telegram','twitter','email','copy','qr','link']).optional(),
  campaign: z.string().max(64).optional(),
});

const inviteTokenParamSchema = z.object({
  token: z.string().min(8).max(48).regex(/^[a-z0-9]+$/),
});

const redeemInviteBodySchema = z.object({
  ipAddress: z.string().optional(),
  userAgent: z.string().max(512).optional(),
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

// POST /api/group-bet/:id/leave — member leaves an OPEN room (Day 6) ─
router.post(
  '/:id/leave',
  authMiddleware,
  validateParams(idParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const userId = (req as any).user.userId;
      const ipAddress = typeof req.ip === 'string' ? req.ip : undefined;
      const out = await leaveGroupBet(id, userId, ipAddress ?? null);
      return res.status(200).json({ success: true, data: out });
    } catch (e) {
      if (e instanceof GroupBetLeaveError) {
        const status =
          e.code === 'GROUP_NOT_FOUND' ? 404 :
          e.code === 'NOT_A_MEMBER' ? 403 :
          e.code === 'ROOM_NOT_OPEN' ? 409 :
          400;
        return res.status(status).json({ success: false, error: e.message, code: e.code });
      }
      next(e);
    }
  },
);

// POST /api/group-bet/:id/cancel — creator cancels their room (Day 6) ─
router.post(
  '/:id/cancel',
  authMiddleware,
  validateParams(idParamSchema),
  validateBody(z.object({ reason: z.string().min(3).max(500) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const userId = (req as any).user.userId;
      const ipAddress = typeof req.ip === 'string' ? req.ip : undefined;
      const { reason } = req.body;
      const out = await cancelGroupBet(id, userId, reason, ipAddress ?? null);
      return res.status(200).json({ success: true, data: out });
    } catch (e) {
      if (e instanceof GroupBetLeaveError) {
        const status =
          e.code === 'GROUP_NOT_FOUND' ? 404 :
          e.code === 'NOT_CREATOR' ? 403 :
          e.code === 'ALREADY_RESOLVED' ? 409 :
          400;
        return res.status(status).json({ success: false, error: e.message, code: e.code });
      }
      next(e);
    }
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

// ─── 16. GET /api/group-bet/lobby — public lobby browser ─────────
router.get(
  '/lobby',
  groupLimiter,
  validateQuery(lobbyFiltersSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = (req as any).query as z.infer<typeof lobbyFiltersSchema>;
      // Optional: pull the viewer's IP country from the request (best-effort)
      const viewerCountry = (req.headers['cf-ipcountry'] as string | undefined)
        || (filters.viewerCountry ?? null);
      const result = await listOpenGroups({ ...filters, viewerCountry });
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 17. GET /api/group-bet/friends/active — rooms where anyone
//       in the requester's friend-graph has joined or created ──────
router.get(
  '/friends/active',
  groupLimiter,
  authMiddleware,
  validateQuery(friendsActiveQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const { limit = 50 } = (req as any).query as z.infer<typeof friendsActiveQuerySchema>;
      const rooms = await listFriendsActiveGroups(user.userId, limit);
      return res.status(200).json({
        success: true,
        data: { rooms },
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 18. GET /api/group-bet/user/history — every room the user has
//       CREATED or JOINED, any status, newest first ────────────────
router.get(
  '/user/history',
  groupLimiter,
  authMiddleware,
  validateQuery(userHistoryQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const { limit = 50, offset = 0, status } = (req as any).query as z.infer<typeof userHistoryQuerySchema>;
      const statusFilter = status
        ? String(status).split(',').map(s => s.trim()).filter(Boolean)
        : null;
      const result = await listUserHistory(user.userId, { limit, offset, statusFilter });
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Gap 2: GET /api/group-bet/active — every room the requester
//       has CREATED or JOINED, sorted by most recent first. ─────────
// CRITICAL: this route MUST be registered BEFORE `/:id` because Express
// matches routes in registration order. If we put it after, a request
// to `/active` would parse `id='active'` and fall into the 422-not-UUID
// branch (idParamSchema requires 8-64 chars; 'active' is 6).
//
// Returns the 25 most recent rooms. Excludes `cancelled` and `expired`
// statuses — those are terminal and shouldn't appear in the "active
// groups" widget. Includes `resolved` because the spec asks for it
// (recent flips are useful context). Limit 25 matches the Day-5 plan.
router.get(
  '/active',
  groupLimiter,
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const r = await query<any>(
        `SELECT
           g.id,
           g.short_code,
           g.status,
           g.is_frozen,
           g.creator_id,
           g.creator_choice,
           g.total_pool::text AS total_pool,
           g.creator_stake::text AS creator_stake,
           g.per_member_stake::text AS per_member_stake,
           g.current_members,
           g.max_members,
           g.min_members,
           g.payout_mode,
           g.turn_mode,
           g.expires_at,
           g.created_at,
           g.resolved_at,
           g.winning_side,
           m.role AS viewer_role,
           m.choice AS viewer_choice,
           m.stake::text AS viewer_stake,
           m.payout_amount::text AS viewer_payout,
           m.is_winner AS viewer_is_winner
         FROM group_bet g
         JOIN group_bet_member m
           ON m.group_id = g.id AND m.user_id = $1
        WHERE g.status IN ('open','ready','flipping','resolved')
          AND g.is_frozen = false
        ORDER BY g.created_at DESC
        LIMIT 25`,
        [user.userId],
      );
      return res.status(200).json({
        success: true,
        data: {
          rooms: r.rows,
          count: r.rows.length,
          limit: 25,
        },
      });
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

// ─── 19. POST /api/group-bet/:id/invite — creator generates link ─
router.post(
  '/:id/invite',
  authMiddleware,
  validateParams(idParamSchema),
  validateBody(createInviteBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const body = (req as any).body as z.infer<typeof createInviteBodySchema>;
      const idRaw: string | string[] | undefined = req.params.id;
      const idSingle = String(Array.isArray(idRaw) ? idRaw[0] : idRaw);
      const ipRaw: string | string[] | undefined = req.ip;
      const ipSingle: string | undefined = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
      const uaRaw: string | string[] | undefined = req.headers['user-agent'] as any;
      const uaSingle: string | undefined = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;
      // Only the room creator can generate invite links
      const r = await query<{ creator_id: string }>(
        `SELECT creator_id FROM group_bet WHERE id = $1`,
        [idSingle],
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: 'group not found', code: 'GROUP_NOT_FOUND' });
      }
      if (r.rows[0].creator_id !== user.userId && !user.isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'only the creator or an admin can generate invite links',
          code: 'NOT_CREATOR',
        });
      }

      const invite = await createInvite({
        groupId: idSingle,
        inviterId: user.userId,
        maxRedemptions: body.maxRedemptions,
        expiresInHours: body.expiresInHours,
        campaign: body.campaign,
        channel: body.channel ?? 'link',
        ipAddress: ipSingle,
        userAgent: uaSingle,
      });
      return res.status(201).json({ success: true, data: invite });
    } catch (e) {
      if (e instanceof InviteError) {
        return res.status(e.httpStatus).json({ success: false, error: e.message, code: e.code });
      }
      next(e);
    }
  },
);

// ─── 20. GET /api/group-bet/invites/:token — public resolver ─────
router.get(
  '/invites/:token',
  validateParams(inviteTokenParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tokenRaw: string | string[] | undefined = req.params.token;
      const tokenSingle = String(Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw);
      const info = await resolveInvite(tokenSingle);
      return res.status(200).json({ success: true, data: info });
    } catch (e) {
      next(e);
    }
  },
);

// ─── 21. POST /api/group-bet/invites/:token/redeem — redeem + bonus + join
router.post(
  '/invites/:token/redeem',
  authMiddleware,
  validateParams(inviteTokenParamSchema),
  validateBody(redeemInviteBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user;
      const body = (req as any).body as z.infer<typeof redeemInviteBodySchema>;
      const tokenRaw: string | string[] | undefined = req.params.token;
      const tokenSingle = String(Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw);
      const ipRaw: string | string[] | undefined = req.ip;
      const ipSingle: string | undefined = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
      const uaRaw: string | string[] | undefined = req.headers['user-agent'] as any;
      const uaSingle: string | undefined = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;
      const outcome = await redeemInvite({
        token: tokenSingle,
        inviteeUserId: user.userId,
        ipAddress: body.ipAddress ?? ipSingle ?? null,
        userAgent: body.userAgent ?? uaSingle ?? null,
      });
      return res.status(200).json({ success: true, data: outcome });
    } catch (e) {
      if (e instanceof InviteError) {
        return res.status(e.httpStatus).json({ success: false, error: e.message, code: e.code });
      }
      next(e);
    }
  },
);

export default router;