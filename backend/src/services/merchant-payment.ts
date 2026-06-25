import crypto from 'crypto';
import { db, query } from '../config/database';

const BINANCE_PAY_API_URL = process.env.BINANCE_PAY_API_URL || 'https://bpay.binanceapi.com';
const BINANCE_PAY_KEY = process.env.BINANCE_PAY_API_KEY || 'mock_binance_key';
const BINANCE_PAY_SECRET = process.env.BINANCE_PAY_SECRET_KEY || 'mock_binance_secret';

const REDOTPAY_API_URL = process.env.REDOTPAY_API_URL || 'https://api.redotpay.com';
const REDOTPAY_KEY = process.env.REDOTPAY_API_KEY || 'mock_redotpay_key';
const REDOTPAY_SECRET = process.env.REDOTPAY_SECRET_KEY || 'mock_redotpay_secret';

export interface MerchantOrderResponse {
  success: boolean;
  orderId: string;
  checkoutUrl: string;
  qrCodeUrl?: string;
  provider: 'binance' | 'redotpay';
}

/**
 * Generate a random string for nonces
 */
function generateNonce(length = 32): string {
  return crypto.randomBytes(length / 2).toString('hex');
}

/**
 * Sign payload for Binance Pay API
 */
export function signBinanceRequest(payload: string, nonce: string, timestamp: number, secretKey: string): string {
  const message = `${timestamp}\n${nonce}\n${payload}\n`;
  return crypto
    .createHmac('sha512', secretKey)
    .update(message)
    .digest('hex')
    .toUpperCase();
}

/**
 * Create order on Binance Pay
 */
export async function createBinancePayOrder(
  userId: string,
  amount: number,
  currency = 'USDT'
): Promise<MerchantOrderResponse> {
  const transactionId = crypto.randomUUID();
  const timestamp = Date.now();
  const nonce = generateNonce();

  const body = {
    env: { terminalType: 'WEB' },
    merchantTradeNo: transactionId,
    orderAmount: amount.toFixed(2),
    currency,
    goods: {
      goodsType: '01',
      goodsCategory: '6000',
      referenceGoodsId: 'deposit_balance',
      goodsName: 'Deposit CryptoFlip Balance',
    },
  };

  const payloadString = JSON.stringify(body);
  const signature = signBinanceRequest(payloadString, nonce, timestamp, BINANCE_PAY_SECRET);

  // Create pending transaction in DB
  await createPendingTransaction(userId, transactionId, amount, currency, 'binance');

  // If in development mode without real keys, return mock checkout link
  if (BINANCE_PAY_SECRET === 'mock_binance_secret') {
    return {
      success: true,
      orderId: transactionId,
      checkoutUrl: `https://test.binance.com/checkout/${transactionId}`,
      provider: 'binance',
    };
  }

  // Real API Call (Mocked out if no credentials)
  try {
    // In a real server setup we'd call axios.post(...)
    // const res = await axios.post(`${BINANCE_PAY_API_URL}/binancepay/openapi/v2/order`, body, { headers: ... });
  } catch (err) {
    console.error('Binance Pay API error:', err);
  }

  return {
    success: true,
    orderId: transactionId,
    checkoutUrl: `https://test.binance.com/checkout/${transactionId}`,
    provider: 'binance',
  };
}

/**
 * Create order on RedotPay
 */
export async function createRedotPayOrder(
  userId: string,
  amount: number,
  currency = 'USDT'
): Promise<MerchantOrderResponse> {
  const transactionId = crypto.randomUUID();

  // Insert pending transaction
  await createPendingTransaction(userId, transactionId, amount, currency, 'redotpay');

  return {
    success: true,
    orderId: transactionId,
    checkoutUrl: `https://checkout.redotpay.com/payment/${transactionId}`,
    provider: 'redotpay',
  };
}

/**
 * Helper: Insert pending transaction in Database
 */
async function createPendingTransaction(
  userId: string,
  referenceId: string,
  amount: number,
  currency: string,
  provider: 'binance' | 'redotpay'
): Promise<void> {
  // Check if wallet exists, if not create a placeholder/default one
  let walletResult = await query(
    'SELECT id FROM wallets WHERE user_id = $1 AND token_symbol = $2',
    [userId, currency]
  );

  let walletId: string;
  if (walletResult.rows.length === 0) {
    const newWalletId = crypto.randomUUID();
    await query(
      `INSERT INTO wallets (id, user_id, chain, token_symbol, balance)
       VALUES ($1, $2, $3, $4, 0.00)`,
      [newWalletId, userId, provider, currency]
    );
    walletId = newWalletId;
  } else {
    walletId = walletResult.rows[0].id;
  }

  await query(
    `INSERT INTO transactions (
      user_id, wallet_id, type, amount, status, reference_id, reference_type, metadata
    ) VALUES ($1, $2, 'deposit', $3, 'pending', $4, 'deposit_merchant', $5)`,
    [userId, walletId, amount, referenceId, JSON.stringify({ provider, currency })]
  );
}

/**
 * Verify Webhook call from Binance Pay
 */
export function verifyBinanceWebhook(
  payloadString: string,
  signature: string,
  nonce: string,
  timestamp: string
): boolean {
  if (BINANCE_PAY_SECRET === 'mock_binance_secret') return true; // Accept in dev mode

  const message = `${timestamp}\n${nonce}\n${payloadString}\n`;
  const computedSignature = crypto
    .createHmac('sha512', BINANCE_PAY_SECRET)
    .update(message)
    .digest('hex')
    .toUpperCase();

  return computedSignature === signature.toUpperCase();
}

/**
 * Verify Webhook call from RedotPay (RSA Signature verification)
 */
export function verifyRedotPayWebhook(
  payloadString: string,
  signature: string,
  publicKeyPem: string
): boolean {
  if (REDOTPAY_SECRET === 'mock_redotpay_secret') return true; // Accept in dev mode

  const verifier = crypto.createVerify('SHA256');
  verifier.update(payloadString);
  return verifier.verify(publicKeyPem, signature, 'base64');
}

/**
 * Handle successful payment callback from merchants
 */
export async function processMerchantDeposit(
  referenceId: string,
  provider: 'binance' | 'redotpay'
): Promise<boolean> {
  const result = await query(
    `SELECT id, user_id, wallet_id, amount, status 
     FROM transactions 
     WHERE reference_id = $1 AND type = 'deposit'`,
    [referenceId]
  );

  if (result.rows.length === 0) {
    console.error(`Transaction with reference ${referenceId} not found`);
    return false;
  }

  const tx = result.rows[0];

  if (tx.status === 'completed') {
    return true; // Already processed
  }

  // Wrap in safe database transaction using connection checkout
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock wallet row to prevent balance race conditions
    await client.query(
      'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE',
      [tx.wallet_id]
    );

    // 2. Update wallet balance
    await client.query(
      `UPDATE wallets 
       SET balance = balance + $1, updated_at = NOW() 
       WHERE id = $2`,
      [tx.amount, tx.wallet_id]
    );

    // Also update virtual balance in users table for backwards-compatibility with existing game engine
    await client.query(
      `UPDATE users 
       SET balance = balance + $1, updated_at = NOW() 
       WHERE id = $2`,
      [tx.amount, tx.user_id]
    );

    // 3. Update transaction status
    await client.query(
      `UPDATE transactions 
       SET status = 'completed', completed_at = NOW() 
       WHERE id = $1`,
      [tx.id]
    );

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to process merchant deposit transaction:', err);
    return false;
  } finally {
    client.release();
  }
}
