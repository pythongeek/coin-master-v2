/**
 * ═══════════════════════════════════════════════════════════════
 *  BONUS CAMPAIGN SERVICE — Admin-managed bonus programs
 * ═══════════════════════════════════════════════════════════════
 *
 *  Industry-standard campaign management for all bonus types:
 *    • welcome           — auto-granted on signup
 *    • deposit_match     — auto on deposit webhook
 *    • cashback          — % of net losses back
 *    • free_spin         — N free coin flips (no wager deducted)
 *    • reload            — % match on subsequent deposits
 *    • vip_tier          — recurring VIP reward
 *    • tournament        — leaderboard prize
 *    • loss_back         — refund % of losing streak
 *    • manual            — admin hand-out (vip, comp, goodwill)
 *    • affiliate_reward  — referral reward (existing)
 *    • rain              — chat rain payout (existing)
 *
 *  Campaign lifecycle:
 *    DRAFT → ACTIVE → EXPIRED/DEPLETED
 *
 *  Each campaign has:
 *    • Code (optional, for opt-in claims)
 *    • Type + economics (amount, percent, free spins, caps)
 *    • Wagering requirements
 *    • Eligibility (target users / vip tiers / countries / min deposit)
 *    • Lifecycle (start/end, expiry)
 *    • Limits (max claims, total budget)
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, db } from '../config/database';

// ── Types ──────────────────────────────────────────────────────

export type CampaignBonusType =
  | 'welcome' | 'deposit_match' | 'cashback' | 'free_spin' | 'reload'
  | 'vip_tier' | 'tournament' | 'loss_back' | 'manual'
  | 'affiliate_reward' | 'rain';

export type CampaignStatus = 'active' | 'expired' | 'depleted' | 'draft' | 'paused';

export interface BonusCampaign {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  bonus_type: CampaignBonusType;
  amount_coins: number | null;
  percent: number | null;
  max_amount_coins: number | null;
  free_spin_count: number | null;
  free_spin_value_coins: number | null;
  wagering_multiplier: number;
  wagering_required_coins: number;
  max_withdrawal_multiplier: number;
  max_withdrawal_coins: number | null;
  min_deposit_to_withdraw_pct: number;
  target_user_ids: string[] | null;
  target_vip_tiers: number[] | null;
  target_countries: string[] | null;
  min_total_deposit_coins: number;
  min_total_bets: number;
  is_active: boolean;
  starts_at: Date;
  ends_at: Date | null;
  claim_window_hours: number | null;
  expires_after_hours: number;
  max_claims_total: number;
  claims_count: number;
  max_claims_per_user: number;
  total_budget_coins: number | null;
  total_paid_coins: number;
  requires_opt_in: boolean;
  auto_grant_on_event: string | null;
  badge_color: string | null;
  icon: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

export interface CampaignClaimInput {
  userId: string;
  campaignId: string;
  amountOverride?: number;       // optional override (manual grants)
  metadata?: Record<string, unknown>;
  source?: string;               // 'opt_in' | 'auto' | 'admin'
}

// ── CRUD: List / Get ──────────────────────────────────────────

export async function listCampaigns(filters: {
  type?: CampaignBonusType;
  active?: boolean;
  visible?: boolean;             // currently running for a user
  userId?: string;               // for eligibility filtering
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: BonusCampaign[]; total: number }> {
  const limit  = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const params: unknown[] = [];
  const where: string[] = [];

  if (filters.type) {
    params.push(filters.type);
    where.push(`bonus_type = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`is_active = $${params.length}`);
  }
  if (filters.visible) {
    // Campaign is "currently visible" if active, started, not ended,
    // has not exceeded max_claims_total, and (if budget-bound) still
    // has room in the total budget.
    where.push(`is_active = true`);
    where.push(`starts_at <= NOW()`);
    where.push(`(ends_at IS NULL OR ends_at > NOW())`);
    where.push(`(max_claims_total = 0 OR claims_count < max_claims_total)`);
    where.push(`(total_budget_coins IS NULL OR total_paid_coins < total_budget_coins)`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const rowsRes = await query(
    `SELECT * FROM bonus_campaigns ${whereSql}
     ORDER BY sort_order ASC, created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM bonus_campaigns ${whereSql}`,
    params.slice(0, params.length - 2),
  );

  return { rows: rowsRes.rows.map(mapRow), total: countRes.rows[0].total };
}

export async function getCampaign(id: string): Promise<BonusCampaign | null> {
  const r = await query('SELECT * FROM bonus_campaigns WHERE id = $1', [id]);
  return r.rows.length ? mapRow(r.rows[0]) : null;
}

export async function getCampaignByCode(code: string): Promise<BonusCampaign | null> {
  const r = await query('SELECT * FROM bonus_campaigns WHERE code = $1', [code]);
  return r.rows.length ? mapRow(r.rows[0]) : null;
}

// ── CRUD: Create / Update / Delete ────────────────────────────

export interface CampaignInput {
  code?: string | null;
  name: string;
  description?: string | null;
  bonus_type: CampaignBonusType;
  amount_coins?: number | null;
  percent?: number | null;
  max_amount_coins?: number | null;
  free_spin_count?: number | null;
  free_spin_value_coins?: number | null;
  wagering_multiplier?: number;
  max_withdrawal_multiplier?: number;
  max_withdrawal_coins?: number | null;
  min_deposit_to_withdraw_pct?: number;
  target_user_ids?: string[] | null;
  target_vip_tiers?: number[] | null;
  target_countries?: string[] | null;
  min_total_deposit_coins?: number;
  min_total_bets?: number;
  is_active?: boolean;
  starts_at?: Date | string;
  ends_at?: Date | string | null;
  claim_window_hours?: number | null;
  expires_after_hours?: number;
  max_claims_total?: number;
  max_claims_per_user?: number;
  total_budget_coins?: number | null;
  requires_opt_in?: boolean;
  auto_grant_on_event?: string | null;
  badge_color?: string | null;
  icon?: string | null;
  sort_order?: number;
  metadata?: Record<string, unknown>;
  created_by?: string;
}

export async function createCampaign(input: CampaignInput): Promise<BonusCampaign> {
  const id = uuidv4();
  const wageringMultiplier = input.wagering_multiplier ?? 30;
  const wageringRequired = computeWageringRequired(input);

  const r = await query(
    `INSERT INTO bonus_campaigns (
      id, code, name, description, bonus_type,
      amount_coins, percent, max_amount_coins,
      free_spin_count, free_spin_value_coins,
      wagering_multiplier, wagering_required_coins,
      max_withdrawal_multiplier, max_withdrawal_coins,
      min_deposit_to_withdraw_pct,
      target_user_ids, target_vip_tiers, target_countries,
      min_total_deposit_coins, min_total_bets,
      is_active, starts_at, ends_at,
      claim_window_hours, expires_after_hours,
      max_claims_total, max_claims_per_user,
      total_budget_coins,
      requires_opt_in, auto_grant_on_event,
      badge_color, icon, sort_order,
      created_by, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10,
      $11, $12,
      $13, $14,
      $15,
      $16, $17, $18,
      $19, $20,
      $21, COALESCE($22, NOW()), $23,
      $24, $25,
      $26, $27,
      $28,
      $29, $30,
      $31, $32, $33,
      $34, $35::jsonb
    )
    RETURNING *`,
    [
      id,
      input.code ?? null,
      input.name,
      input.description ?? null,
      input.bonus_type,
      input.amount_coins ?? null,
      input.percent ?? null,
      input.max_amount_coins ?? null,
      input.free_spin_count ?? null,
      input.free_spin_value_coins ?? null,
      wageringMultiplier,
      wageringRequired,
      input.max_withdrawal_multiplier ?? 3,
      input.max_withdrawal_coins ?? null,
      input.min_deposit_to_withdraw_pct ?? 50,
      input.target_user_ids ?? null,
      input.target_vip_tiers ?? null,
      input.target_countries ?? null,
      input.min_total_deposit_coins ?? 0,
      input.min_total_bets ?? 0,
      input.is_active ?? true,
      input.starts_at ?? null,
      input.ends_at ?? null,
      input.claim_window_hours ?? null,
      input.expires_after_hours ?? 168,
      input.max_claims_total ?? 0,
      input.max_claims_per_user ?? 1,
      input.total_budget_coins ?? null,
      input.requires_opt_in ?? true,
      input.auto_grant_on_event ?? null,
      input.badge_color ?? null,
      input.icon ?? null,
      input.sort_order ?? 100,
      input.created_by ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  await query(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('bonus', 'bonus.campaign.created', 'info', $1, $2)`,
    [input.created_by ?? null, JSON.stringify({ id, name: input.name, bonus_type: input.bonus_type })],
  );

  return mapRow(r.rows[0]);
}

export async function updateCampaign(
  id: string,
  patch: Partial<CampaignInput>,
  adminId?: string,
): Promise<BonusCampaign | null> {
  const existing = await getCampaign(id);
  if (!existing) return null;

  // Build dynamic SET clause from patch fields
  const fields: string[] = [];
  const values: unknown[] = [];
  let n = 0;
  const set = (col: string, val: unknown) => {
    n++;
    fields.push(`${col} = $${n}`);
    values.push(val);
  };

  const editable: (keyof CampaignInput)[] = [
    'code','name','description','amount_coins','percent','max_amount_coins',
    'free_spin_count','free_spin_value_coins','wagering_multiplier',
    'max_withdrawal_multiplier','max_withdrawal_coins','min_deposit_to_withdraw_pct',
    'target_user_ids','target_vip_tiers','target_countries',
    'min_total_deposit_coins','min_total_bets','is_active','starts_at','ends_at',
    'claim_window_hours','expires_after_hours','max_claims_total','max_claims_per_user',
    'total_budget_coins','requires_opt_in','auto_grant_on_event',
    'badge_color','icon','sort_order',
  ];
  for (const k of editable) {
    if (patch[k] !== undefined) set(k as string, patch[k]);
  }
  if (patch.metadata) {
    n++;
    fields.push(`metadata = $${n}::jsonb`);
    values.push(JSON.stringify(patch.metadata));
  }
  if (!fields.length) return existing;

  n++;
  values.push(id);

  await query(
    `UPDATE bonus_campaigns SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${n}`,
    values,
  );

  await query(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('bonus', 'bonus.campaign.updated', 'info', $1, $2)`,
    [adminId ?? null, JSON.stringify({ id, patch })],
  );

  return getCampaign(id);
}

export async function deleteCampaign(id: string, adminId?: string): Promise<boolean> {
  const r = await query('DELETE FROM bonus_campaigns WHERE id = $1 RETURNING id', [id]);
  if (r.rows.length) {
    await query(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('bonus', 'bonus.campaign.deleted', 'warn', $1, $2)`,
      [adminId ?? null, JSON.stringify({ id })],
    );
    return true;
  }
  return false;
}

// ── Eligibility check ─────────────────────────────────────────

export async function userIsEligible(userId: string, campaign: BonusCampaign): Promise<{ ok: boolean; reason?: string }> {
  // 1. Active & within window
  if (!campaign.is_active) return { ok: false, reason: 'campaign_inactive' };
  if (campaign.starts_at > new Date()) return { ok: false, reason: 'not_yet_started' };
  if (campaign.ends_at && campaign.ends_at < new Date()) return { ok: false, reason: 'ended' };

  // 2. Max claims total
  if (campaign.max_claims_total > 0 && campaign.claims_count >= campaign.max_claims_total) {
    return { ok: false, reason: 'campaign_depleted' };
  }

  // 3. Budget
  if (campaign.total_budget_coins && campaign.total_paid_coins >= campaign.total_budget_coins) {
    return { ok: false, reason: 'budget_exhausted' };
  }

  // 4. Target users
  if (campaign.target_user_ids && campaign.target_user_ids.length > 0 &&
      !campaign.target_user_ids.includes(userId)) {
    return { ok: false, reason: 'user_not_in_target_list' };
  }

  // 5. Min deposit / min bets — read from users row
  const userRes = await query(
    `SELECT total_deposited_coins,
            (SELECT COUNT(*)::int FROM bets WHERE user_id = users.id) AS total_bets
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!userRes.rows.length) return { ok: false, reason: 'user_not_found' };
  const totalDep = parseFloat(userRes.rows[0].total_deposited_coins || '0');
  const totalBets = userRes.rows[0].total_bets ?? 0;
  if (totalDep < campaign.min_total_deposit_coins) {
    return { ok: false, reason: `min_deposit_not_met_${campaign.min_total_deposit_coins}` };
  }
  if (totalBets < campaign.min_total_bets) {
    return { ok: false, reason: `min_bets_not_met_${campaign.min_total_bets}` };
  }

  // 6. User already at max_claims_per_user?
  const userClaims = await query(
    `SELECT COUNT(*)::int AS count FROM bonus_campaign_claims
     WHERE campaign_id = $1 AND user_id = $2`,
    [campaign.id, userId],
  );
  if (userClaims.rows[0].count >= campaign.max_claims_per_user) {
    return { ok: false, reason: 'already_claimed_max' };
  }

  return { ok: true };
}

// ── Claim a campaign ──────────────────────────────────────────

export async function claimCampaign(input: CampaignClaimInput): Promise<{
  ok: boolean;
  reason?: string;
  bonusClaimId?: string;
  amountCoins?: number;
  wageringRequired?: number;
  expiresAt?: Date;
}> {
  const campaign = await getCampaign(input.campaignId);
  if (!campaign) return { ok: false, reason: 'campaign_not_found' };

  const eligibility = await userIsEligible(input.userId, campaign);
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  // Compute amount to credit based on bonus_type
  const amount = await computeCampaignAmount(input.userId, campaign, input.amountOverride);
  if (amount <= 0) return { ok: false, reason: 'computed_amount_zero' };

  const wageringRequired = amount * campaign.wagering_multiplier;
  const maxWithdrawal = amount * campaign.max_withdrawal_multiplier;
  const expiresAt = new Date(Date.now() + campaign.expires_after_hours * 3_600_000);

  return withTransaction(async (tx) => {
    // 1. Insert bonus_claim
    const claimId = uuidv4();
    await tx(
      `INSERT INTO bonus_claims (
        id, user_id, campaign_id, bonus_type, amount_coins, wagering_required,
        max_withdrawal_allowed, expires_at, status, grant_source, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, 'active', $9, $10::jsonb
      )`,
      [
        claimId,
        input.userId,
        campaign.id,
        campaign.bonus_type,
        amount,
        wageringRequired,
        maxWithdrawal,
        expiresAt,
        input.source ?? 'opt_in',
        JSON.stringify({
          campaign_id: campaign.id,
          campaign_code: campaign.code,
          campaign_name: campaign.name,
          source: input.source ?? 'opt_in',
          ...(input.metadata ?? {}),
        }),
      ],
    );

    // 2. Credit user
    await tx(
      `UPDATE users
         SET bonus_balance_coins       = bonus_balance_coins + $2,
             wagering_required_coins   = wagering_required_coins + $3,
             total_bonus_claimed_coins = total_bonus_claimed_coins + $2,
             last_bonus_at             = NOW()
       WHERE id = $1`,
      [input.userId, amount, wageringRequired],
    );

    // 3. Record transactions row (bonus ledger)
    await tx(
      `INSERT INTO transactions
        (id, user_id, type, amount, currency, direction, status, related_user_id, metadata, completed_at)
       VALUES ($1, $2, 'bonus', $3, 'USD', 'credit', 'confirmed', $2, $4::jsonb, NOW())`,
      [
        uuidv4(),
        input.userId,
        amount,
        JSON.stringify({
          source: 'campaign',
          campaign_id: campaign.id,
          campaign_code: campaign.code,
          campaign_name: campaign.name,
          bonus_claim_id: claimId,
          wagering_required: wageringRequired,
        }),
      ],
    );

    // 4. Track in bonus_campaign_claims
    await tx(
      `INSERT INTO bonus_campaign_claims
        (campaign_id, user_id, bonus_claim_id, amount_coins, wagering_required_coins, status, metadata)
       VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb)`,
      [
        campaign.id,
        input.userId,
        claimId,
        amount,
        wageringRequired,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    // 5. Increment campaign stats
    await tx(
      `UPDATE bonus_campaigns
         SET claims_count = claims_count + 1,
             total_paid_coins = total_paid_coins + $2,
             updated_at = NOW()
       WHERE id = $1`,
      [campaign.id, amount],
    );

    // 6. Audit
    await tx(
      `INSERT INTO audit_log (category, action, severity, user_id, details)
       VALUES ('bonus', 'bonus.campaign.claimed', 'info', $1, $2)`,
      [input.userId, JSON.stringify({
        campaign_id: campaign.id,
        bonus_claim_id: claimId,
        amount, wagering_required: wageringRequired,
      })],
    );

    return {
      ok: true,
      bonusClaimId: claimId,
      amountCoins: amount,
      wageringRequired,
      expiresAt,
    };
  });
}

// ── Auto-grant helpers (triggered by events) ──────────────────

export async function grantCampaignByEvent(
  event: 'signup' | 'deposit' | 'rain' | 'vip_tier',
  userId: string,
  amountUsd?: number,
): Promise<BonusCampaign[]> {
  const list = await query(
    `SELECT * FROM bonus_campaigns
     WHERE auto_grant_on_event = $1 AND is_active = true`,
    [event],
  );

  const granted: BonusCampaign[] = [];
  for (const row of list.rows) {
    const campaign = mapRow(row);
    const claimInput: CampaignClaimInput = {
      userId,
      campaignId: campaign.id,
      amountOverride: amountUsd,
      source: 'auto',
      metadata: { trigger_event: event, amount_usd: amountUsd },
    };
    const result = await claimCampaign(claimInput);
    if (result.ok) granted.push(campaign);
  }
  return granted;
}

// ── Statistics for admin ──────────────────────────────────────

export async function getCampaignStats(): Promise<{
  totalCampaigns: number;
  activeCampaigns: number;
  totalPaidCoins: number;
  totalClaims: number;
  byType: Array<{ bonus_type: string; count: number; paid: number }>;
}> {
  const head = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_active)::int AS active,
      COALESCE(SUM(total_paid_coins), 0)::float AS paid,
      COALESCE(SUM(claims_count), 0)::int AS claims
    FROM bonus_campaigns
  `);
  const byType = await query<{ bonus_type: string; count: number; paid: number }>(`
    SELECT bonus_type,
           COUNT(*)::int AS count,
           COALESCE(SUM(total_paid_coins), 0)::float AS paid
    FROM bonus_campaigns
    GROUP BY bonus_type
    ORDER BY paid DESC
  `);
  return {
    totalCampaigns: head.rows[0].total,
    activeCampaigns: head.rows[0].active,
    totalPaidCoins: head.rows[0].paid,
    totalClaims: head.rows[0].claims,
    byType: byType.rows,
  };
}

// ── Per-user bonuses list ─────────────────────────────────────

export async function listUserBonuses(userId: string): Promise<Array<{
  id: string;
  campaignId: string | null;
  bonusType: string;
  amountCoins: number;
  wageringRequired: number;
  wageringCompleted: number;
  wageringPercentComplete: number;
  expiresAt: Date;
  status: string;
  source: string;
  metadata: Record<string, unknown>;
}>> {
  const r = await query(
    `SELECT bc.id, bc.campaign_id, bc.bonus_type, bc.amount_coins, bc.wagering_required,
            bc.expires_at, bc.status, bc.grant_source, bc.metadata,
            u.wagering_required_coins, u.wagering_completed_coins
     FROM bonus_claims bc
     LEFT JOIN users u ON u.id = bc.user_id
     WHERE bc.user_id = $1
     ORDER BY bc.claimed_at DESC`,
    [userId],
  );
  return r.rows.map((row: any) => {
    const required = parseFloat(row.wagering_required);
    const userReqd  = parseFloat(row.wagering_required_coins || '0');
    const userDone  = parseFloat(row.wagering_completed_coins || '0');
    // Approximate per-claim wagering progress: if user has only this claim,
    // ratio = userDone/userReqd. With multiple claims, fall back to 0 for others.
    const pct = userReqd > 0 ? Math.min(100, (userDone / userReqd) * 100) : 0;
    return {
      id: row.id,
      campaignId: row.campaign_id,
      bonusType: row.bonus_type,
      amountCoins: parseFloat(row.amount_coins),
      wageringRequired: required,
      wageringCompleted: row.status === 'completed' ? required : (pct / 100) * required,
      wageringPercentComplete: pct,
      expiresAt: row.expires_at,
      status: row.status,
      source: row.grant_source,
      metadata: row.metadata || {},
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────

function computeWageringRequired(input: CampaignInput): number {
  // For percent-based bonuses, use max_amount_coins as upper bound.
  const baseAmount = input.amount_coins
    ?? input.max_amount_coins
    ?? (input.free_spin_count && input.free_spin_value_coins
        ? input.free_spin_count * input.free_spin_value_coins
        : 0);
  return baseAmount * (input.wagering_multiplier ?? 30);
}

async function computeCampaignAmount(
  userId: string,
  campaign: BonusCampaign,
  override?: number,
): Promise<number> {
  if (override !== undefined) return override;

  switch (campaign.bonus_type) {
    case 'welcome':
    case 'manual':
    case 'vip_tier':
    case 'tournament':
      return campaign.amount_coins ?? 0;

    case 'free_spin':
      return (campaign.free_spin_count ?? 0) * (campaign.free_spin_value_coins ?? 0);

    case 'deposit_match':
    case 'reload': {
      // Use the user's last deposit amount as the basis
      const dep = await query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM transactions
         WHERE user_id = $1 AND type = 'deposit'
           AND status IN ('confirmed', 'completed')
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId],
      );
      const recentDep = dep.rows[0].total;
      if (recentDep <= 0) return 0;
      const pct = campaign.percent ?? 50;
      const calculated = recentDep * (pct / 100);
      const capped = campaign.max_amount_coins
        ? Math.min(calculated, campaign.max_amount_coins)
        : calculated;
      return parseFloat(capped.toFixed(8));
    }

    case 'cashback':
    case 'loss_back': {
      const losses = await query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM transactions
         WHERE user_id = $1 AND type IN ('bet','withdrawal','fee')
           AND status IN ('confirmed', 'completed')
           AND created_at > NOW() - INTERVAL '7 days'`,
        [userId],
      );
      const recentLosses = losses.rows[0].total;
      if (recentLosses <= 0) return 0;
      const pct = campaign.percent ?? 10;
      const calculated = recentLosses * (pct / 100);
      const capped = campaign.max_amount_coins
        ? Math.min(calculated, campaign.max_amount_coins)
        : calculated;
      return parseFloat(capped.toFixed(8));
    }

    default:
      return campaign.amount_coins ?? 0;
  }
}

function mapRow(row: any): BonusCampaign {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    bonus_type: row.bonus_type,
    amount_coins: row.amount_coins !== null ? parseFloat(row.amount_coins) : null,
    percent: row.percent !== null ? parseFloat(row.percent) : null,
    max_amount_coins: row.max_amount_coins !== null ? parseFloat(row.max_amount_coins) : null,
    free_spin_count: row.free_spin_count,
    free_spin_value_coins: row.free_spin_value_coins !== null ? parseFloat(row.free_spin_value_coins) : null,
    wagering_multiplier: parseFloat(row.wagering_multiplier),
    wagering_required_coins: parseFloat(row.wagering_required_coins),
    max_withdrawal_multiplier: parseFloat(row.max_withdrawal_multiplier),
    max_withdrawal_coins: row.max_withdrawal_coins !== null ? parseFloat(row.max_withdrawal_coins) : null,
    min_deposit_to_withdraw_pct: parseFloat(row.min_deposit_to_withdraw_pct),
    target_user_ids: row.target_user_ids,
    target_vip_tiers: row.target_vip_tiers,
    target_countries: row.target_countries,
    min_total_deposit_coins: parseFloat(row.min_total_deposit_coins),
    min_total_bets: row.min_total_bets,
    is_active: row.is_active,
    starts_at: new Date(row.starts_at),
    ends_at: row.ends_at ? new Date(row.ends_at) : null,
    claim_window_hours: row.claim_window_hours,
    expires_after_hours: row.expires_after_hours,
    max_claims_total: row.max_claims_total,
    claims_count: row.claims_count,
    max_claims_per_user: row.max_claims_per_user,
    total_budget_coins: row.total_budget_coins !== null ? parseFloat(row.total_budget_coins) : null,
    total_paid_coins: parseFloat(row.total_paid_coins),
    requires_opt_in: row.requires_opt_in,
    auto_grant_on_event: row.auto_grant_on_event,
    badge_color: row.badge_color,
    icon: row.icon,
    sort_order: row.sort_order,
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    metadata: row.metadata || {},
  };
}