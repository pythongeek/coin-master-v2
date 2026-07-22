/**
 * =============================================================
 *  ADMIN BALANCE ADJUSTMENT SERVICE
 * =============================================================
 *
 *  Allows super_admin to credit or debit coins from any user's wallet
 *  with full audit trail + email notification.
 *
 *  Used by: routes/admin-balance.ts
 *
 *  Safety:
 *    - All writes wrapped in SERIALIZABLE transaction with row lock
 *    - Per-tx max amount limit (admin-configurable)
 *    - Per-admin per-day max limit (admin-configurable)
 *    - Refuses overdraft (debit can't exceed current balance)
 *    - Reason required (min 20 chars) for audit
 *    - Optional category for grouping (goodwill/correction/chargeback/prize/refund/other)
 *    - Email notification to user (bilingual via notification.service)
 *    - Records in both `transactions` table AND `admin_balance_adjustments` for rich audit
 */

import { query, withTransaction } from '../config/database';
import { getRawSetting } from './admin-config';
import { queueEmail } from './notification.service';

export type AdjustmentDirection = 'credit' | 'debit';
export type AdjustmentCategory = 'manual' | 'goodwill' | 'correction' | 'chargeback' | 'prize' | 'refund' | 'other';

export interface AdjustmentResult {
  success: true;
  adjustmentId: string;
  transactionId: string;
  userId: string;
  walletId: string;
  chain: string;
  tokenSymbol: string;
  direction: AdjustmentDirection;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  category: AdjustmentCategory;
  adminId: string;
  createdAt: string;
  emailSent: boolean;
}

export class AdjustmentError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'AdjustmentError';
  }
}

interface AdjustmentParams {
  userId: string;
  walletId: string;
  direction: AdjustmentDirection;
  amount: number;
  reason: string;
  category?: AdjustmentCategory;
  adminId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Get all wallet balances for a specific user (used to pick a wallet to adjust).
 */
export async function getUserBalances(userId: string): Promise<Array<{
  walletId: string;
  chain: string;
  tokenSymbol: string;
  balance: number;
  lockedBalance: number;
  withdrawable: number;
}>> {
  const r = await query(
    `SELECT id, chain, token_symbol,
            balance::float8 AS balance,
            locked_balance::float8 AS locked_balance
     FROM wallets
     WHERE user_id = $1
     ORDER BY chain, token_symbol`,
    [userId]
  );
  return r.rows.map((w: Record<string, unknown>) => ({
    walletId: w.id as string,
    chain: w.chain as string,
    tokenSymbol: w.token_symbol as string,
    balance: w.balance as number,
    lockedBalance: w.locked_balance as number,
    withdrawable: (w.balance as number) - (w.locked_balance as number),
  }));
}

/**
 * Get audit trail with pagination + filters.
 */
export async function getAdjustmentHistory(opts: {
  userId?: string;
  adminId?: string;
  direction?: AdjustmentDirection;
  category?: AdjustmentCategory;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  entries: Array<{
    id: string;
    user_id: string;
    admin_user_id: string;
    direction: AdjustmentDirection;
    amount_coins: number;
    wallet_id: string;
    balance_before: number;
    balance_after: number;
    reason: string;
    category: AdjustmentCategory;
    transaction_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
    user_username: string;
    user_email: string;
    admin_username: string;
    chain: string;
    token_symbol: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}> {
  const limit = Math.min(opts.limit || 50, 200);
  const offset = Math.max(opts.offset || 0, 0);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let pIdx = 1;

  if (opts.userId) { conditions.push(`a.user_id = $${pIdx++}`); params.push(opts.userId); }
  if (opts.adminId) { conditions.push(`a.admin_user_id = $${pIdx++}`); params.push(opts.adminId); }
  if (opts.direction) { conditions.push(`a.direction = $${pIdx++}`); params.push(opts.direction); }
  if (opts.category) { conditions.push(`a.category = $${pIdx++}`); params.push(opts.category); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const entries = await query(
    `SELECT a.*,
            u.username AS user_username, u.email AS user_email,
            admin.username AS admin_username,
            w.chain, w.token_symbol
     FROM admin_balance_adjustments a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN users admin ON admin.id = a.admin_user_id
     LEFT JOIN wallets w ON w.id = a.wallet_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${pIdx++} OFFSET $${pIdx++}`,
    [...params, limit, offset]
  );

  const totalRes = await query(
    `SELECT COUNT(*)::int AS total FROM admin_balance_adjustments a ${where}`,
    params
  );

  return {
    entries: entries.rows as any,
    total: (totalRes.rows[0]?.total as number) || 0,
    limit,
    offset,
  };
}

/**
 * Main adjustment function - credit or debit a user's wallet.
 *
 * Wraps everything in a SERIALIZABLE transaction with row-level lock on the
 * wallet to prevent race conditions with concurrent bets/withdrawals.
 */
export async function adjustUserBalance(params: AdjustmentParams): Promise<AdjustmentResult> {
  // Validate inputs
  if (!params.userId) throw new AdjustmentError('userId is required', 'MISSING_USER_ID');
  if (!params.walletId) throw new AdjustmentError('walletId is required', 'MISSING_WALLET_ID');
  if (!params.adminId) throw new AdjustmentError('adminId is required', 'MISSING_ADMIN_ID');
  if (!['credit', 'debit'].includes(params.direction)) {
    throw new AdjustmentError('direction must be credit or debit', 'INVALID_DIRECTION');
  }
  if (typeof params.amount !== 'number' || !isFinite(params.amount) || params.amount <= 0) {
    throw new AdjustmentError('amount must be a positive number', 'INVALID_AMOUNT');
  }
  if (!params.reason || params.reason.trim().length < 20) {
    throw new AdjustmentError('reason required (min 20 characters) for audit', 'INSUFFICIENT_REASON');
  }

  // Load admin-configurable limits
  const [
    maxPerAdjRaw, maxPerDayRaw, maxBalanceAfterRaw, notifyUserRaw,
  ] = await Promise.all([
    getRawSetting('admin_balance_max_per_adjustment'),
    getRawSetting('admin_balance_max_per_day'),
    getRawSetting('admin_balance_max_balance_after'),
    getRawSetting('admin_balance_notify_user'),
  ]);
  const maxPerAdj = parseFloat(maxPerAdjRaw || '100000');
  const maxPerDay = parseFloat(maxPerDayRaw || '1000000');
  const maxBalanceAfter = parseFloat(maxBalanceAfterRaw || '10000000');
  const notifyUser = notifyUserRaw !== 'false';

  if (maxPerAdj > 0 && params.amount > maxPerAdj) {
    throw new AdjustmentError(
      `Amount ${params.amount} exceeds per-adjustment limit of ${maxPerAdj}`,
      'OVER_PER_ADJ_LIMIT'
    );
  }

  // Per-admin daily total (sum of |amount| in last 24h)
  if (maxPerDay > 0) {
    const dailyRes = await query(
      `SELECT COALESCE(SUM(amount_coins), 0)::float8 AS total
       FROM admin_balance_adjustments
       WHERE admin_user_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [params.adminId]
    );
    const dailyTotal = dailyRes.rows[0]?.total || 0;
    if (dailyTotal + params.amount > maxPerDay) {
      throw new AdjustmentError(
        `Would exceed admin per-day limit. Used ${dailyTotal.toFixed(2)}/${maxPerDay} today.`,
        'OVER_PER_DAY_LIMIT'
      );
    }
  }

  // Get user details for email notification
  const userRes = await query(
    `SELECT username, email, preferred_language FROM users WHERE id = $1`,
    [params.userId]
  );
  if (!userRes.rows.length) {
    throw new AdjustmentError('User not found', 'USER_NOT_FOUND');
  }
  const user = userRes.rows[0];

  // Outer-scope variables (captured from inside the transaction for the email section below)
  let balanceBefore = 0;
  let balanceAfter = 0;
  let tokenSymbol = '';
  let chain = '';

  // Execute adjustment in a SERIALIZABLE transaction
  const result = await withTransaction(async (txQuery) => {
    // Lock the wallet row to prevent race conditions
    const walletRes = await txQuery(
      `SELECT id, chain, token_symbol, balance::float8 AS balance
       FROM wallets
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [params.walletId, params.userId]
    );
    if (!walletRes.rows.length) {
      throw new AdjustmentError('Wallet not found or does not belong to user', 'WALLET_NOT_FOUND');
    }
    const wallet = walletRes.rows[0];
    const balanceBefore = wallet.balance;

    if (params.direction === 'credit') {
      balanceAfter = balanceBefore + params.amount;
      if (maxBalanceAfter > 0 && balanceAfter > maxBalanceAfter) {
        throw new AdjustmentError(
          `Credit would put balance at ${balanceAfter.toFixed(2)} which exceeds safety cap of ${maxBalanceAfter}`,
          'OVER_BALANCE_CAP'
        );
      }
      // Update user_balance
      await txQuery(
        `UPDATE users
         SET withdrawable_balance_coins = withdrawable_balance_coins + $1,
             wallet_balance_coins = wallet_balance_coins + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [params.amount, params.userId]
      );
      // Update wallets table
      await txQuery(
        `UPDATE wallets
         SET balance = balance + $1, updated_at = NOW()
         WHERE id = $2`,
        [params.amount, params.walletId]
      );
    } else {
      // Debit
      if (params.amount > balanceBefore) {
        throw new AdjustmentError(
          `Cannot deduct ${params.amount} from balance ${balanceBefore} (overdraft prevented)`,
          'INSUFFICIENT_BALANCE'
        );
      }
      balanceAfter = balanceBefore - params.amount;
      await txQuery(
        `UPDATE users
         SET withdrawable_balance_coins = GREATEST(0, withdrawable_balance_coins - $1),
             wallet_balance_coins = GREATEST(0, wallet_balance_coins - $1),
             updated_at = NOW()
         WHERE id = $2`,
        [params.amount, params.userId]
      );
      await txQuery(
        `UPDATE wallets
         SET balance = balance - $1, updated_at = NOW()
         WHERE id = $2`,
        [params.amount, params.walletId]
      );
    }

    // Insert into transactions table (so the user sees it in their history)
    const txRes = await txQuery(
      `INSERT INTO transactions
         (user_id, wallet_id, type, amount, direction, status, currency, metadata, completed_at, created_at)
       VALUES ($1, $2, 'admin_adjustment', $3, $4, 'completed', $5, $6, NOW(), NOW())
       RETURNING id`,
      [
        params.userId,
        params.walletId,
        params.amount,
        params.direction,
        wallet.token_symbol,
        JSON.stringify({
          admin_user_id: params.adminId,
          reason: params.reason,
          category: params.category || 'manual',
          balance_before: balanceBefore,
          balance_after: balanceAfter,
        }),
      ]
    );
    const transactionId = txRes.rows[0].id;

    // Insert into admin_balance_adjustments for rich audit
    const adjRes = await txQuery(
      `INSERT INTO admin_balance_adjustments
         (user_id, admin_user_id, direction, amount_coins, wallet_id, balance_before, balance_after,
          reason, category, transaction_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, created_at`,
      [
        params.userId,
        params.adminId,
        params.direction,
        params.amount,
        params.walletId,
        balanceBefore,
        balanceAfter,
        params.reason,
        params.category || 'manual',
        transactionId,
        params.ipAddress || null,
        params.userAgent ? params.userAgent.slice(0, 500) : null,
      ]
    );
    const adjustmentId = adjRes.rows[0].id;
    const createdAt = adjRes.rows[0].created_at;

    return {
      success: true as const,
      adjustmentId,
      transactionId,
      userId: params.userId,
      walletId: params.walletId,
      chain: wallet.chain,
      tokenSymbol: wallet.token_symbol,
      direction: params.direction,
      amount: params.amount,
      balanceBefore,
      balanceAfter,
      reason: params.reason,
      category: params.category || 'manual',
      adminId: params.adminId,
      createdAt,
      emailSent: false, // set after queue
    };
  });

  // Send bilingual email notification (best-effort, never fail the adjustment)
  if (notifyUser && user.email) {
    try {
      const isBn = user.preferred_language === 'bn';
      const sign = params.direction === 'credit' ? '+' : '-';
      const templateKey = params.direction === 'credit' ? 'balance.credited' : 'balance.debited';
      // Bilingual inline templates (no DB templates needed for these simple notifications)
      const subjectEn = params.direction === 'credit'
        ? `Your account has been credited ${params.amount} ${result.tokenSymbol}`
        : `Your account has been debited ${params.amount} ${result.tokenSymbol}`;
      const subjectBn = params.direction === 'credit'
        ? `আপনার অ্যাকাউন্টে ${params.amount} ${result.tokenSymbol} যোগ হয়েছে`
        : `আপনার অ্যাকাউন্ট থেকে ${params.amount} ${result.tokenSymbol} কেটে নেওয়া হয়েছে`;
      const bodyHtml = `
        <h2>${params.direction === 'credit' ? 'Account Credited' : 'Account Debited'}</h2>
        <p>Hi ${user.username},</p>
        <p>${params.direction === 'credit'
          ? `Your account has been credited with <strong>${sign}${params.amount} ${result.tokenSymbol}</strong>.`
          : `Your account has been debited <strong>${sign}${params.amount} ${result.tokenSymbol}</strong>.`}</p>
        <p><strong>Reason:</strong> ${params.reason}</p>
        <p><strong>Balance:</strong> ${balanceBefore} → ${balanceAfter} ${result.tokenSymbol}</p>
        <p>If you have questions, please contact support.</p>
      `;
      const bodyHtmlBn = `
        <h2>${params.direction === 'credit' ? 'অ্যাকাউন্টে টাকা যোগ হয়েছে' : 'অ্যাকাউন্ট থেকে টাকা কাটা হয়েছে'}</h2>
        <p>হ্যালো ${user.username},</p>
        <p>${params.direction === 'credit'
          ? `আপনার অ্যাকাউন্টে <strong>${sign}${params.amount} ${result.tokenSymbol}</strong> যোগ হয়েছে।`
          : `আপনার অ্যাকাউন্ট থেকে <strong>${sign}${params.amount} ${result.tokenSymbol}</strong> কেটে নেওয়া হয়েছে।`}</p>
        <p><strong>কারণ:</strong> ${params.reason}</p>
        <p><strong>ব্যালেন্স:</strong> ${balanceBefore} → ${balanceAfter} ${result.tokenSymbol}</p>
        <p>প্রশ্ন থাকলে সাপোর্টে যোগাযোগ করুন।</p>
      `;
      await queueEmail({
        recipient: user.email,
        recipient_kind: 'user',
        user_id: params.userId,
        event_type: templateKey,
        context: {
          username: user.username,
          amount: params.amount.toString(),
          tokenSymbol: result.tokenSymbol,
          direction: params.direction,
          reason: params.reason,
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
        },
        subject_override: isBn ? subjectBn : subjectEn,
      } as Parameters<typeof queueEmail>[0]);
      // (Bilingual inline templates don't fully use the DB template system, but the queueEmail will fall back to EN)
      result.emailSent = true;
    } catch (err) {
      console.error('[admin-balance] email notification failed (silent):', err instanceof Error ? err.message : err);
    }
  }

  return result;
}