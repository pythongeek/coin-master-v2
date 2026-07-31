/**
 * ════════════════════════════════════════════════════════════════
 *  GROUP-BET-INVITE — Phase 2 / Day 11
 *  ════════════════════════════════════════════════════════════════
 *
 *  Generates, resolves, and redeems invite tokens for group rooms.
 *  Backed by the new `group_bet_invite_link` table (Day 11 migration).
 *
 *    createInvite(...)      → POST /:id/invite (creator generates a link)
 *    resolveInvite(token)   → GET /invites/:token  (public preview)
 *    redeemInvite(...)      → POST /invites/:token/redeem (auth)
 *
 *  Bonus crediting is gated on the 24 admin-config thresholds
 *  (groupInviterBonusCoins, groupInviteeBonusCoins,
 *   groupInviterBonusCapPerUserPerDay, groupInviteMaxRedemptionsDefault,
 *   groupInviteExpiryHoursDefault). When any bonus is 0 the crediting
 *  step is silently skipped (relying on this guarantees tests don't
 *  need to set up coin-config in order to run).
 */

import crypto from 'crypto';
import { query, withTransaction } from '../config/database';
import { getGroupConfigKey } from './admin-group-config';

export interface InviteChannel {
  channel: 'whatsapp' | 'telegram' | 'twitter' | 'email' | 'copy' | 'qr' | 'link';
}

export interface CreateInviteOptions {
  groupId: string;
  inviterId: string;
  /** Overrides the 24-threshold default (groupInviteMaxRedemptionsDefault) */
  maxRedemptions?: number;
  /** Overrides the 24-threshold default (groupInviteExpiryHoursDefault, in hours) */
  expiresInHours?: number;
  /** Optional utm-style attribution string */
  campaign?: string;
  /** Optional specific channel (default: 'link') */
  channel?: InviteChannel['channel'];
  /** Optional IP for the audit log */
  ipAddress?: string | null;
  /** Optional user-agent for the audit log */
  userAgent?: string | null;
}

export interface CreatedInvite {
  id: string;
  token: string;
  url: string;
  groupId: string;
  inviterId: string;
  maxRedemptions: number;
  expiresAt: string;
  campaign: string | null;
  createdAt: string;
}

export interface ResolvedInvite {
  valid: boolean;
  reason?: 'EXPIRED' | 'EXHAUSTED' | 'NOT_FOUND';
  groupId?: string;
  shortCode?: string;
  maxRedemptions?: number;
  redeemedCount?: number;
  expiresAt?: string;
  campaign?: string | null;
}

/**
 * Generate a fresh invite link for a room. Token is 32 lowercase
 * base32 chars (no padding) — URL-safe and unambiguous.
 */
export async function createInvite(
  options: CreateInviteOptions,
): Promise<CreatedInvite> {
  // ── Admin-config defaults ──────────────────────────────────────
  const maxRedDefault = await getGroupConfigKey('groupInviteMaxRedemptionsDefault').catch(() => 1);
  const expiryHoursDefault = await getGroupConfigKey('groupInviteExpiryHoursDefault').catch(() => 168); // 7d

  const maxRed = options.maxRedemptions ?? (typeof maxRedDefault === 'number' ? maxRedDefault : parseInt(String(maxRedDefault), 10) || 1);
  const expiryHours = options.expiresInHours ?? (typeof expiryHoursDefault === 'number' ? expiryHoursDefault : parseInt(String(expiryHoursDefault), 10) || 168);
  const token = generateToken(32);

  // Verify the room exists before insert
  const r = await query<{ id: string }>(
    `SELECT id FROM group_bet WHERE id = $1`,
    [options.groupId],
  );
  if (!r.rows.length) {
    throw new InviteError('group not found', 'GROUP_NOT_FOUND');
  }

  const ins = await query<{ id: string; token: string; expires_at: string; created_at: string }>(
    `INSERT INTO group_bet_invite_link
       (token, group_id, inviter_id, max_redemptions, expires_at, campaign)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval, $6)
     RETURNING id, token, expires_at, created_at`,
    [token, options.groupId, options.inviterId, maxRed, String(expiryHours), options.campaign ?? null],
  );

  const row = ins.rows[0];
  // Audit the create — reuses the existing 'invite_share' enum value
  await query(
    `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
     VALUES ($1, 'invite_share', $2, $3::jsonb)`,
    [options.groupId, options.inviterId, JSON.stringify({
      token: row.token.slice(0, 8) + '***',
      maxRedemptions: maxRed,
      expiresAt: row.expires_at,
      channel: options.channel ?? 'link',
      campaign: options.campaign ?? null,
      trigger: 'create_invite',
    })],
  );

  return {
    id: row.id,
    token: row.token,
    url: `/g/invite/${row.token}`,
    groupId: options.groupId,
    inviterId: options.inviterId,
    maxRedemptions: maxRed,
    expiresAt: row.expires_at,
    campaign: options.campaign ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Public preview: returns a sanitized summary of the link without
 * requiring auth. Used by the React landing page to render a
 * "You're invited to play CoinFlip with @creator" UI.
 */
export async function resolveInvite(token: string): Promise<ResolvedInvite> {
  if (!token || token.length < 8 || token.length > 48) {
    return { valid: false, reason: 'NOT_FOUND' };
  }
  const r = await query<{
    group_id: string; short_code: string; max_redemptions: number;
    redemption_count: number; redeemed_count: number;
    expires_at: string; campaign: string | null;
  }>(
    `SELECT l.group_id, g.short_code, l.max_redemptions, l.redemption_count,
            l.redeemed_count, l.expires_at, l.campaign
       FROM group_bet_invite_link l
       JOIN group_bet g ON g.id = l.group_id
      WHERE l.token = $1`,
    [token],
  );
  if (!r.rows.length) return { valid: false, reason: 'NOT_FOUND' };
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return {
      valid: false,
      reason: 'EXPIRED',
      groupId: row.group_id,
      shortCode: row.short_code,
      expiresAt: row.expires_at,
    };
  }
  if (row.redemption_count >= row.max_redemptions) {
    return {
      valid: false,
      reason: 'EXHAUSTED',
      groupId: row.group_id,
      shortCode: row.short_code,
      maxRedemptions: row.max_redemptions,
      redeemedCount: row.redeemed_count,
    };
  }
  return {
    valid: true,
    groupId: row.group_id,
    shortCode: row.short_code,
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    expiresAt: row.expires_at,
    campaign: row.campaign,
  };
}

/**
 * Redeem an invite: atomic TX
 *   1. SELECT FOR UPDATE the link row
 *   2. Check expiry + redemption-count
 *   3. Refuse if invitee == inviter (no self-redeem)
 *   4. Compute inviter bonus (with daily-cap)
 *   5. Credit inviter bonus (admin_adjustment / 'credit')
 *   6. Credit invitee bonus (admin_adjustment / 'credit')
 *   7. INSERT group_bet_invite (event log with total bonus)
 *   8. INSERT group_bet_audit(action='bonus_award', sub_action='invite_redeemed')
 *   9. Increment link.redemption_count + update redeemed_count timestamps
 *  10. JOIN the group via joinGroupBet (existing Day-2 service)
 *
 * Returned shape includes the credit amounts and the join result.
 */
export interface RedeemOptions {
  token: string;
  inviteeUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}
export interface RedeemOutcome {
  token: string;
  groupId: string;
  inviterId: string;
  inviterBonus: number;
  inviteeBonus: number;
  totalBonus: number;
  inviterBonusCapped: boolean;
  dailyInviterBonusAfter: number;
  joinResult: { groupId: string; role: string; stake: number };
}

/**
 * Custom error class for the invite service — surfaces a clean code
 * for the route layer to map to HTTP status.
 */
export class InviteError extends Error {
  constructor(message: string, public code: string, public httpStatus: number = 400) {
    super(message);
    this.name = 'InviteError';
  }
}

/** Retry-safe token generator: exactly `length` lowercase alnum chars
 *  by over-generating and slicing. Note that base64url strips `+/=` to
 *  url-safe chars, then we drop `-` and `_` to get pure alnum. */
function generateToken(length: number): string {
  let s = '';
  while (s.length < length) {
    s += crypto.randomBytes(length + 8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase();
  }
  return s.slice(0, length);
}

export async function redeemInvite(opts: RedeemOptions): Promise<RedeemOutcome> {
  const token = opts.token;
  // Look up the link OUTSIDE the tx first to validate token shape
  const r0 = await query<{
    id: string; group_id: string; inviter_id: string;
    max_redemptions: number; redemption_count: number; expires_at: string;
    status: string;
  }>(
    `SELECT l.id, l.group_id, l.inviter_id, l.max_redemptions, l.redemption_count, l.expires_at,
            g.status
       FROM group_bet_invite_link l
       JOIN group_bet g ON g.id = l.group_id
      WHERE l.token = $1`,
    [token],
  );
  if (!r0.rows.length) throw new InviteError('invite not found', 'INVITE_NOT_FOUND', 404);
  const link = r0.rows[0];
  if (new Date(link.expires_at).getTime() < Date.now()) {
    throw new InviteError('invite expired', 'INVITE_EXPIRED', 410);
  }
  if (link.redemption_count >= link.max_redemptions) {
    throw new InviteError('invite exhausted (max redemptions reached)', 'INVITE_EXHAUSTED', 409);
  }
  if (link.inviter_id === opts.inviteeUserId) {
    throw new InviteError('cannot redeem your own invite', 'SELF_REDEEM', 400);
  }
  if (!['open','ready'].includes(link.status)) {
    throw new InviteError('group is not joinable', 'GROUP_NOT_JOINABLE', 409);
  }

  // Config knobs
  const inviterB = await getGroupConfigKey('groupInviterBonusCoins').catch(() => 0);
  const inviteeB = await getGroupConfigKey('groupInviteeBonusCoins').catch(() => 0);
  const capPerDay = await getGroupConfigKey('groupInviterBonusCapPerUserPerDay').catch(() => 100);
  const inviterBase = typeof inviterB === 'number' ? inviterB : parseFloat(String(inviterB)) || 0;
  const inviteeBase = typeof inviteeB === 'number' ? inviteeB : parseFloat(String(inviteeB)) || 0;
  const cap = typeof capPerDay === 'number' ? capPerDay : parseFloat(String(capPerDay)) || 100;

  // Lazy import to avoid a circular dep with join-flow
  const { joinGroupBet } = require('./group-bet-join');

  // Atomic TX: lock the link row, check cap, credit, increment, audit
  return await withTransaction(async (txQuery) => {
    const lock = await txQuery(
      `SELECT redemption_count FROM group_bet_invite_link WHERE id = $1 FOR UPDATE`,
      [link.id],
    );
    const curCount = lock.rows[0]?.redemption_count ?? 0;
    if (curCount >= link.max_redemptions) {
      throw new InviteError('invite exhausted (max redemptions reached)', 'INVITE_EXHAUSTED', 409);
    }

    // Sum today's inviter-bonus credits (UTC date) to enforce cap
    const todaySum = await txQuery(
      `SELECT COALESCE(SUM(amount), 0)::text AS s
         FROM transactions
        WHERE user_id = $1
          AND type = 'admin_adjustment'
          AND direction = 'credit'
          AND metadata->>'reason' = 'group_invite_bonus'
          AND created_at >= date_trunc('day', NOW())`,
      [link.inviter_id],
    );
    const todaysTotal = parseFloat(todaySum.rows[0]?.s ?? '0');
    let inviterBonus = inviterBase;
    let inviterBonusCapped = false;
    if (todaysTotal + inviterBase > cap) {
      const remaining = Math.max(0, cap - todaysTotal);
      if (remaining > 0) {
        inviterBonus = remaining;
        inviterBonusCapped = true;
      } else {
        inviterBonus = 0; // already at cap
        inviterBonusCapped = true;
      }
    }
    const inviteeBonus = inviteeBase;
    const totalBonus = inviterBonus + inviteeBonus;

    // Credit inviter (if any bonus remains)
    let inviterCreditResult: { balance: number } | null = null;
    let inviteeCreditResult: { balance: number } | null = null;
    if (inviterBonus > 0) {
      await txQuery(
        `UPDATE users SET bonus_balance_coins = bonus_balance_coins + $2 WHERE id = $1`,
        [link.inviter_id, inviterBonus.toFixed(8)],
      );
      const balRow = await txQuery(
        `SELECT (COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`,
        [link.inviter_id],
      );
      inviterCreditResult = { balance: parseFloat(balRow.rows[0]?.b ?? '0') };
      await txQuery(
        `INSERT INTO transactions (user_id, type, amount, currency, direction, status, metadata)
         VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
        [
          link.inviter_id,
          inviterBonus.toFixed(8),
          JSON.stringify({
            pool: 'group_play',
            reason: 'group_invite_bonus',
            inviteToken: token.slice(0, 8) + '***',
            inviter: link.inviter_id,
            invitee: opts.inviteeUserId,
            groupId: link.group_id,
            dailyTotalBefore: todaysTotal,
            dailyCap: cap,
            capped: inviterBonusCapped,
          }),
        ],
      );
    }
    if (inviteeBonus > 0) {
      await txQuery(
        `UPDATE users SET bonus_balance_coins = bonus_balance_coins + $2 WHERE id = $1`,
        [opts.inviteeUserId, inviteeBonus.toFixed(8)],
      );
      const balRow = await txQuery(
        `SELECT (COALESCE(bonus_balance_coins,0))::text AS b FROM users WHERE id = $1`,
        [opts.inviteeUserId],
      );
      inviteeCreditResult = { balance: parseFloat(balRow.rows[0]?.b ?? '0') };
      await txQuery(
        `INSERT INTO transactions (user_id, type, amount, currency, direction, status, metadata)
         VALUES ($1, 'admin_adjustment', $2, 'USD', 'credit', 'confirmed', $3::jsonb)`,
        [
          opts.inviteeUserId,
          inviteeBonus.toFixed(8),
          JSON.stringify({
            pool: 'group_play',
            reason: 'group_invite_bonus',
            inviteToken: token.slice(0, 8) + '***',
            inviter: link.inviter_id,
            invitee: opts.inviteeUserId,
            groupId: link.group_id,
          }),
        ],
      );
    }

    // Insert into group_bet_invite event log (existing table)
    const evIns = await txQuery(
      `INSERT INTO group_bet_invite
         (group_id, inviter_id, invitee_user_id, channel, bonus_awarded, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7)
       RETURNING id`,
      [
        link.group_id,
        link.inviter_id,
        opts.inviteeUserId,
        opts.userAgent?.includes('WhatsApp') ? 'whatsapp' : 'copy', // best-effort
        totalBonus.toFixed(8),
        opts.ipAddress ?? null,
        (opts.userAgent ?? '').slice(0, 256) || null,
      ],
    );

    // Audit row
    await txQuery(
      `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
       VALUES ($1, 'bonus_award', $2, $3::jsonb)`,
      [
        link.group_id,
        opts.inviteeUserId,
        JSON.stringify({
          token: token.slice(0, 8) + '***',
          inviterId: link.inviter_id,
          inviteeId: opts.inviteeUserId,
          totalBonus,
          inviterBonus,
          inviteeBonus,
          inviterCapped: inviterBonusCapped,
          channel: 'copy',
          eventLogId: evIns.rows[0].id,
          trigger: 'invite_redeem',
        }),
      ],
    );
    // Also write an 'invite_share' audit (was the original Phase-1 enum)
    // marking the actual share event from the redemption perspective
    await txQuery(
      `INSERT INTO group_bet_audit (group_id, action, actor_id, payload)
       VALUES ($1, 'invite_share', $2, $3::jsonb)`,
      [
        link.group_id,
        link.inviter_id,
        JSON.stringify({
          token: token.slice(0, 8) + '***',
          redeemedBy: opts.inviteeUserId,
          redemptionEventId: evIns.rows[0].id,
          trigger: 'invite_redeem',
        }),
      ],
    );

    // Increment the link counter
    await txQuery(
      `UPDATE group_bet_invite_link
          SET redemption_count = redemption_count + 1,
              redeemed_count    = redeemed_count + 1,
              first_redeemed_at = COALESCE(first_redeemed_at, NOW()),
              last_redeemed_at  = NOW()
        WHERE id = $1`,
      [link.id],
    );

    // ── The group join happens OUTSIDE this transaction because
    // joinGroupBet has its own withTransaction (Day-2 design) and
    // nesting transactions on the same pool is unsafe. ──
    return {
      token,
      groupId: link.group_id,
      inviterId: link.inviter_id,
      inviterBonus,
      inviteeBonus,
      totalBonus,
      inviterBonusCapped,
      dailyInviterBonusAfter: todaysTotal + inviterBonus,
      joinResult: { groupId: '', role: '', stake: 0 }, // filled in after tx closes
    };
  })
    .then(async (commitResult) => {
      // After the TX commits, perform the join (Day-2 service handles its own TX)
      const stakeDefault = await getGroupConfigKey('groupDefaultContributionMin').catch(() => 1);
      const perMemberStake = typeof stakeDefault === 'number' ? stakeDefault : parseFloat(String(stakeDefault)) || 1;
      try {
        const join = await joinGroupBet({
          userId: opts.inviteeUserId,
          groupIdentifier: commitResult.groupId,
          choice: 'heads',
          stakeOverride: perMemberStake,
        });
        return { ...commitResult, joinResult: { groupId: join.groupId, role: join.role, stake: perMemberStake } };
      } catch (e: any) {
        // If the join fails for whatever reason (balance, etc) the bonus still stands.
        return { ...commitResult, joinResult: { groupId: commitResult.groupId, role: 'join-failed', stake: perMemberStake } };
      }
    });
}
