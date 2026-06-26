import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { getOrCreateUserWallet } from '../services/wallet-derivation';
import { validateBody } from '../middleware/validation';
import { depositAddressSchema, depositMerchantSchema, withdrawSchema } from '../schemas';
import {
  createBinancePayOrder,
  createRedotPayOrder,
  verifyBinanceWebhook,
  verifyRedotPayWebhook,
  processMerchantDeposit,
} from '../services/merchant-payment';
import { query, db } from '../config/database';

const router = Router();

// Extend Express Request type locally for TS
interface AuthRequest extends Request {
  user?: AuthPayload;
}

/**
 * POST /api/wallet/deposit/address
 * Get or derive a unique on-chain deposit address (EVM or Solana)
 */
router.post('/deposit/address', authMiddleware, validateBody(depositAddressSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { chain } = req.body;
    const wallet = await getOrCreateUserWallet(userId, chain);
    res.json({
      success: true,
      chain,
      address: wallet.address,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/deposit/merchant
 * Initiate a checkout order with Binance Pay or RedotPay
 */
router.post('/deposit/merchant', authMiddleware, validateBody(depositMerchantSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { amount, provider, currency = 'USDT' } = req.body;

    let order;
    if (provider === 'binance') {
      order = await createBinancePayOrder(userId, amount, currency);
    } else {
      order = await createRedotPayOrder(userId, amount, currency);
    }

    res.json({
      success: true,
      order,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/deposit/callback/binance
 * Webhook endpoint for Binance Pay events
 */
router.post('/deposit/callback/binance', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['binance-pay-signature'] as string || '';
    const timestamp = req.headers['binance-pay-timestamp'] as string || '';
    const nonce = req.headers['binance-pay-nonce'] as string || '';
    const payload = JSON.stringify(req.body);

    const isValid = verifyBinanceWebhook(payload, signature, nonce, timestamp);
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    const { bizType, data } = req.body;
    if (bizType === 'PAY' && data?.status === 'PAY_SUCCESS') {
      const referenceId = data.merchantTradeNo;
      const processed = await processMerchantDeposit(referenceId, 'binance');
      if (processed) {
        return res.json({ returnCode: 'SUCCESS', returnMessage: null });
      }
    }

    res.status(400).json({ success: false, error: 'Event not processed' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/deposit/callback/redotpay
 * Webhook endpoint for RedotPay events
 */
router.post('/deposit/callback/redotpay', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['redotpay-signature'] as string || '';
    const payload = JSON.stringify(req.body);
    const publicKeyPem = process.env.REDOTPAY_PUBLIC_KEY || 'mock_pem';

    const isValid = verifyRedotPayWebhook(payload, signature, publicKeyPem);
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    const { event, data } = req.body;
    if (event === 'payment.success') {
      const referenceId = data.orderId;
      const processed = await processMerchantDeposit(referenceId, 'redotpay');
      if (processed) {
        return res.json({ success: true });
      }
    }

    res.status(400).json({ success: false, error: 'Event not processed' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

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

    const txs = await query(
      `SELECT id, wallet_id, type, amount, status, tx_hash, created_at, completed_at, metadata 
       FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
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
        createdAt: t.created_at,
        completedAt: t.completed_at,
        metadata: t.metadata,
      })),
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/deposit/simulate-tx
 * Development only: simulate an incoming on-chain deposit (starts confirming)
 */
router.post('/deposit/simulate-tx', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Forbidden in production' });
  }

  try {
    const { txHash, fromAddress, toAddress, amount, chain, currency } = req.body;
    if (!txHash || !fromAddress || !toAddress || !amount || !chain) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const { registerIncomingDeposit } = await import('../services/deposit-monitor');
    const txId = await registerIncomingDeposit({
      txHash,
      fromAddress,
      toAddress,
      amount: Number(amount),
      chain,
      currency,
    });

    res.json({
      success: true,
      transactionId: txId,
      message: 'Mock transaction registered successfully',
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

/**
 * POST /api/wallet/deposit/simulate-block
 * Development only: simulate a new block mined to increment confirmations
 */
router.post('/deposit/simulate-block', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Forbidden in production' });
  }

  try {
    const { chain } = req.body;
    if (chain !== 'ethereum' && chain !== 'solana' && chain !== 'tron') {
      return res.status(400).json({ success: false, error: 'Invalid chain. Supported: ethereum, solana, tron' });
    }

    const { processNewBlock } = await import('../services/deposit-monitor');
    await processNewBlock(chain);

    res.json({
      success: true,
      message: `Mined a simulated block for chain ${chain}`,
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
router.post('/withdraw', authMiddleware, validateBody(withdrawSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { walletId, toAddress, amount } = req.body;
    const { requestWithdrawal } = await import('../services/withdrawal-queue');
    const result = await requestWithdrawal(userId, walletId, toAddress, amount);

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

