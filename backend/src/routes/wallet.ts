import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { fraudGuard } from '../middleware/fraud-guard';
import { getOrCreateUserWallet } from '../services/wallet-derivation';
import { validateBody } from '../middleware/validation';
import { withdrawSchema } from '../schemas';
import { query, db } from '../config/database';

const router = Router();

// Extend Express Request type locally for TS
interface AuthRequest extends Request {
  user?: AuthPayload;
}





/**
 * GET /api/wallet/balances
 * Retrieve all wallet balances for a user
 */
router.get('/balances', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const wallets = await query(
      `SELECT id, chain, token_symbol, balance, locked_balance, deposit_address
       FROM wallets
       WHERE user_id = $1`,
      [userId]
    );

    // KYC tier info (P1: needed by withdraw UI to show limits)
    const userRes = await query(
      `SELECT kyc_status, kyc_tier, kyc_country
       FROM users WHERE id = $1`,
      [userId]
    );
    const userRow = userRes.rows[0] || {};
    const tier = (userRow.kyc_tier || '').toLowerCase();
    const tierLevel = tier === 'tier3' || tier === '3' ? 3 : tier === 'tier2' || tier === '2' ? 2 : tier === 'tier1' || tier === '1' ? 1 : 0;
    const tierLimits: Record<number, { perTx: number; daily: number }> = {
      0: { perTx: 50, daily: 50 },
      1: { perTx: 50, daily: 100 },
      2: { perTx: 1000, daily: 5000 },
      3: { perTx: 10000, daily: 50000 },
    };
    const limits = tierLimits[tierLevel];

    // Sum today's withdrawals for the remaining-daily-amount
    const todayRes = await query(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS total
       FROM transactions
       WHERE user_id = $1
         AND type = 'withdrawal'
         AND status IN ('pending', 'confirmed')
         AND created_at >= date_trunc('day', NOW())`,
      [userId]
    );
    const todayWithdrawn = todayRes.rows[0].total;

    res.json({
      success: true,
      wallets: wallets.rows.map(w => ({
        id: w.id,
        chain: w.chain,
        tokenSymbol: w.token_symbol,
        balance: parseFloat(w.balance),
        lockedBalance: parseFloat(w.locked_balance),
        depositAddress: w.deposit_address,
      })),
      kyc: {
        status: userRow.kyc_status || 'unverified',
        tier: userRow.kyc_tier || null,
        tierLevel,
        country: userRow.kyc_country || null,
        perTxLimit: limits.perTx,
        dailyLimit: limits.daily,
        dailyUsed: todayWithdrawn,
        dailyRemaining: Math.max(0, limits.daily - todayWithdrawn),
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * GET /api/wallet/transactions
 * Retrieve transaction history for a user
 */
router.get('/transactions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10), 0);
    // Use explicit integer params (pg complains about 'text' otherwise)
    const txsParams: Array<string | number> = [userId, limit, offset];
    let countParams: Array<string | number> = [userId];
    let typeClause = '';
    if (req.query.type) {
      typeClause = 'AND type = $2';
      txsParams.push(String(req.query.type));
      // countParams stays [userId] since we only have 1 filter (type goes to $2 in a 2-param query)
      countParams = [userId, String(req.query.type)];
    }

    const txs = await query(
      `SELECT id, wallet_id, type, amount, status, tx_hash, to_address, created_at, completed_at, metadata
       FROM transactions
       WHERE user_id = $1 ${typeClause}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      txsParams
    );

    const totalRes = await query(
      `SELECT COUNT(*)::int AS total FROM transactions WHERE user_id = $1 ${typeClause}`,
      countParams
    );

    res.json({
      success: true,
      transactions: txs.rows.map(t => ({
        id: t.id,
        walletId: t.wallet_id,
        type: t.type,
        amount: parseFloat(t.amount),
        status: t.status,
        txHash: t.tx_hash,
        toAddress: t.to_address,
        createdAt: t.created_at,
        completedAt: t.completed_at,
        metadata: t.metadata,
      })),
      pagination: {
        limit,
        offset,
        total: totalRes.rows[0]?.total || 0,
        hasMore: offset + txs.rows.length < (totalRes.rows[0]?.total || 0),
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});



/**
 * POST /api/wallet/withdraw
 * Initiate an automated crypto withdrawal (queued through BullMQ)
 */
router.post('/withdraw', authMiddleware, validateBody(withdrawSchema), fraudGuard, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { walletId, toAddress, amount } = req.body;
    const { memo } = req.body;

    // 2FA step-up check (P2-D): if amount >= threshold AND user has 2FA enabled
    // AND no recent 2FA within grace window -> require X-2FA-Code header.
    const { getRawSetting } = await import('../services/admin-config');
    const thresholdSetting = await getRawSetting('withdrawal_2fa_threshold_usdt');
    const threshold = parseFloat(thresholdSetting || '1000');
    if (amount >= threshold) {
      const userRes = await query(
        'SELECT totp_enabled, totp_verified_at FROM users WHERE id = $1',
        [userId]
      );
      const u = userRes.rows[0];
      const graceSetting = await getRawSetting('withdrawal_2fa_grace_minutes');
      const graceMin = parseInt(graceSetting || '5', 10);
      const lastOk = u.totp_verified_at ? new Date(u.totp_verified_at).getTime() : 0;
      const withinGrace = (Date.now() - lastOk) < graceMin * 60 * 1000;
      const needs2fa = u.totp_enabled && !withinGrace;
      if (needs2fa) {
        const code = (req.headers['x-2fa-code'] as string | undefined)?.trim();
        if (!code) {
          return res.status(403).json({
            success: false,
            error: '2FA required for this withdrawal amount',
            requires_2fa: true,
            graceMinutes: graceMin,
          });
        }
        const totpRes = await query(
          'SELECT totp_secret_encrypted FROM users WHERE id = $1',
          [userId]
        );
        if (!totpRes.rows[0]?.totp_secret_encrypted) {
          return res.status(500).json({ success: false, error: '2FA state inconsistent' });
        }
        const { decryptSecret, verifyTotp } = await import('../utils/totp');
        const secret = decryptSecret(totpRes.rows[0].totp_secret_encrypted);
        if (!verifyTotp(secret, code)) {
          return res.status(401).json({ success: false, error: 'Invalid 2FA code' });
        }
        await query('UPDATE users SET totp_verified_at = NOW() WHERE id = $1', [userId]);
        await query(
          `INSERT INTO two_factor_log (user_id, action, ip_address, user_agent)
           VALUES ($1, 'withdraw', $2, $3)`,
          [userId, req.ip, ((req.headers['user-agent'] as string) || '').slice(0, 500)]
        );
      }
    }

    const { requestWithdrawal } = await import('../services/withdrawal-queue');
    const result = await requestWithdrawal(userId, walletId, toAddress, amount, memo);

    res.json({
      success: true,
      transactionId: result.requestId,
      status: result.status,
      message: 'Withdrawal request enqueued successfully'
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/rakeback/claim
 * Claim accumulated pending rakeback into user balance
 */
router.post('/rakeback/claim', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    // Lock user row and fetch pending_rakeback
    const userResult = await client.query(
      'SELECT balance, pending_rakeback FROM users WHERE id = $1 AND is_active = true FOR UPDATE',
      [userId]
    );
    
    if (!userResult.rows.length) {
      throw new Error('ইউজার পাওয়া যায়নি।');
    }
    
    const pendingRakeback = parseFloat(userResult.rows[0].pending_rakeback || '0');
    if (pendingRakeback <= 0) {
      throw new Error('ক্লেম করার জন্য কোনো রেকব্যাক উপলব্ধ নেই।');
    }
    
    const currentBalance = parseFloat(userResult.rows[0].balance);
    const newBalance = parseFloat((currentBalance + pendingRakeback).toFixed(8));
    
    // Inject audit log settings for the transaction
    await client.query(`SELECT set_config('audit.user_id', $1, true)`, [userId]);
    await client.query(`SELECT set_config('audit.ip_address', $1, true)`, [req.ip || '']);
    await client.query(`SELECT set_config('audit.user_agent', $1, true)`, [req.headers['user-agent'] || '']);
    
    // Update user balance and pending rakeback
    await client.query(
      'UPDATE users SET balance = $1, pending_rakeback = 0.00000000, updated_at = NOW() WHERE id = $2',
      [newBalance, userId]
    );
    
    // Insert transaction record
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, metadata, completed_at, ip_address, user_agent)
       VALUES ($1, $2, NULL, 'rakeback', $3, 'completed', '{}', NOW(), $4, $5)`,
      [txId, userId, pendingRakeback, req.ip || null, req.headers['user-agent'] || null]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      amount: pendingRakeback,
      newBalance,
      message: `অভিনন্দন! আপনার $${pendingRakeback.toFixed(4)} রেকব্যাক ব্যালেন্সে যোগ করা হয়েছে।`
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: errorMsg });
  } finally {
    client.release();
  }
});

export default router;

