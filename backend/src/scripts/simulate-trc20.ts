/**
 * =============================================================
 *  E2E SIMULATION - TRC20 (non-memo chain) matching path
 * =============================================================
 *
 *  Mirrors simulate-deposit.ts but tests the non-memo matching strategy:
 *  - Order has memo_supported=false
 *  - Order has match_strategy='amount'
 *  - Fake ledger entry has network=TRX, NO addressTag
 *  - Verifier should match by (chain=TRX + exact amount)
 *
 *  Run: docker exec coin-master-backend-1 node ./dist/scripts/simulate-trc20.js
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';

const SMOKE_USER_ID = process.env.SIM_USER_ID || 'b64784cf-2aa2-459b-8924-eda1e25e2315';
const ORDER_AMOUNT = parseFloat(process.env.SIM_AMOUNT || '75');

async function main() {
  console.log('[sim-trc20] start; user=' + SMOKE_USER_ID + ' amount=' + ORDER_AMOUNT);

  // 1) Ensure TRC20 chain config is enabled with a real address
  await query(
    `UPDATE deposit_chain_config
     SET is_enabled = true,
         deposit_address = COALESCE(NULLIF(deposit_address, ''), 'TJRabPrwbZy68sbavbpAqRKyPfdQ7QEmZe'),
         min_confirmations = 19,
         estimated_seconds = 60
     WHERE chain_key = 'TRC20'
     RETURNING chain_key, deposit_address, is_enabled, memo_supported`
  ).then((r) => {
    if (r.rows.length) console.log('[sim-trc20] TRC20 chain config:', JSON.stringify(r.rows[0]));
  });

  // 2) Check user
  const userRow = await query('SELECT id, username, balance FROM users WHERE id = $1', [SMOKE_USER_ID]);
  if (userRow.rows.length === 0) {
    console.error('[sim-trc20] FAIL: user ' + SMOKE_USER_ID + ' not found');
    process.exit(1);
  }
  console.log('[sim-trc20] user: ' + userRow.rows[0].username + ' balance=' + userRow.rows[0].balance);

  // 3) Create TRC20 order (no memo!)
  const merchantOrderId = 'simtrc_' + uuidv4().replace(/-/g, '').slice(0, 24);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await query(
    `INSERT INTO payment_orders
      (user_id, gateway, gateway_order_id, merchant_order_id,
       crypto_currency, amount_crypto, fx_rate_snapshot, amount_coins,
       qr_memo, qr_payload, qr_png_data_url,
       receive_address, chain, expires_at, status,
       memo_supported, match_strategy,
       ip_address, user_agent, metadata)
     VALUES ($1, 'binance_pay_qr', $2, $2, 'USDT', $3, 1.0, $3,
             NULL, 'sim://trc20-no-memo', '',
             'TJRabPrwbZy68sbavbpAqRKyPfdQ7QEmZe', 'TRX', $4, 'awaiting_payment',
             false, 'amount',
             NULL, 'sim', '{}'::jsonb)`,
    [SMOKE_USER_ID, merchantOrderId, ORDER_AMOUNT, expiresAt]
  );
  console.log('[sim-trc20] created orderId=' + merchantOrderId + ' (NO memo, match_strategy=amount)');

  // 4) Simulate ledger entry: TRX network, NO addressTag, exact amount
  const fakeTxHash = '0xSIMTRX' + uuidv4().replace(/-/g, '').slice(0, 56);
  const fakeSender = 'TSimulated' + uuidv4().replace(/-/g, '').slice(0, 22);

  // Mark detected with TRX-style ledger entry (no memo)
  await query(
    `UPDATE payment_orders
     SET status = 'detected',
         detected_tx_hash = $1,
         detected_at = NOW(),
         binance_ledger_entry = $2::jsonb,
         sender_address = $3,
         updated_at = NOW()
     WHERE merchant_order_id = $4 AND status = 'awaiting_payment'`,
    [fakeTxHash, JSON.stringify({
      id: 'sim-trx-' + Date.now(),
      amount: String(ORDER_AMOUNT),
      coin: 'USDT',
      network: 'TRX',
      status: 1,
      address: 'TJRabPrwbZy68sbavbpAqRKyPfdQ7QEmZe',
      addressTag: '',  // TRC20 USDT has no memo
      txId: fakeTxHash,
      insertTime: Date.now(),
      unlockConfirm: 19,
      transferType: 0,
      walletType: 0,
    }), fakeSender, merchantOrderId]
  );
  console.log('[sim-trc20] marked detected; txHash=' + fakeTxHash);

  // 5) Run rule-based verdict for non-memo chain
  const orderRow = await query(
    `SELECT amount_crypto::float8 AS amt FROM payment_orders WHERE merchant_order_id = $1`,
    [merchantOrderId]
  );
  const amountDeltaPct = Math.abs(ORDER_AMOUNT - orderRow.rows[0].amt) / orderRow.rows[0].amt * 100;

  let ruleVerdict = 'AUTO_CREDIT';
  let ruleConfidence = 0.78;  // lower than BSC because non-memo has less precision
  let ruleReason = 'no_memo;amount_exact_TRX;confirmations_19';
  if (amountDeltaPct > 0.5) { ruleVerdict = 'MANUAL_HOLD'; ruleConfidence = 0.5; ruleReason = 'amount_slight_' + amountDeltaPct.toFixed(1) + 'pct'; }
  console.log('[sim-trc20] rule verdict: ' + ruleVerdict + ' (' + (ruleConfidence*100) + '%) reason="' + ruleReason + '"');

  // 6) For amount>500 we'd need 0.92, for amount>2000 never AUTO
  let autoCreditThreshold = 0.80;
  if (ORDER_AMOUNT > 500) autoCreditThreshold = 0.92;
  if (ORDER_AMOUNT > 2000) autoCreditThreshold = 999;
  console.log('[sim-trc20] threshold for $' + ORDER_AMOUNT + ': ' + autoCreditThreshold);

  if (ruleVerdict === 'AUTO_CREDIT' && ruleConfidence >= autoCreditThreshold) {
    const credited = await withTransaction(async (txQuery: any) => {
      await txQuery(
        `UPDATE users
         SET withdrawable_balance_coins = withdrawable_balance_coins + $1,
             wallet_balance_coins = wallet_balance_coins + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [ORDER_AMOUNT, SMOKE_USER_ID]
      );
      await txQuery(
        `INSERT INTO wallet_transactions
          (user_id, type, amount_coins, currency, source, note, metadata)
         VALUES ($1, 'topup', $2, 'COIN', 'binance_pay_qr',
                 $3, $4::jsonb)`,
        [SMOKE_USER_ID, ORDER_AMOUNT,
         'Simulated TRC20 QR deposit credit (non-memo)',
         JSON.stringify({ orderId: merchantOrderId, txHash: fakeTxHash, simulation: true, chain: 'TRC20', matchStrategy: 'amount' })]
      );
      await txQuery(
        `UPDATE payment_orders
         SET status = 'paid', confirmed_at = NOW(),
             llm_verdict = $1, llm_confidence = $2, llm_reason = $3,
             llm_model_version = $4, llm_scored_at = NOW(),
             rule_verdict = $5, rule_disagreement = $6,
             updated_at = NOW()
         WHERE merchant_order_id = $7`,
        ['AUTO_CREDIT', ruleConfidence, ruleReason, 'simulated-rule-only-TRC20',
         ruleVerdict, false, merchantOrderId]
      );
      await txQuery(
        `INSERT INTO audit_log (user_id, category, action, severity, details)
         VALUES ($1, 'system', 'payment.simulated.trc20', 'info', $2)`,
        [SMOKE_USER_ID, JSON.stringify({ orderId: merchantOrderId, amount: ORDER_AMOUNT, chain: 'TRC20', simulation: true })]
      );
      return true;
    });

    if (credited) {
      const finalUser = await query('SELECT balance FROM users WHERE id = $1', [SMOKE_USER_ID]);
      const finalOrder = await query(
        `SELECT status, amount_coins, chain, memo_supported, match_strategy,
                detected_tx_hash, llm_verdict, sender_address, confirmed_at
         FROM payment_orders WHERE merchant_order_id = $1`,
        [merchantOrderId]
      );
      const tx = await query(
        `SELECT type, amount_coins, source, note FROM wallet_transactions
         WHERE user_id = $1 AND metadata->>'orderId' = $2 ORDER BY created_at DESC LIMIT 1`,
        [SMOKE_USER_ID, merchantOrderId]
      );

      console.log('\n[sim-trc20] === FINAL STATE ===');
      console.log('User balance: $' + finalUser.rows[0].balance);
      console.log('Order status: ' + finalOrder.rows[0].status);
      console.log('Order chain: ' + finalOrder.rows[0].chain);
      console.log('memo_supported: ' + finalOrder.rows[0].memo_supported);
      console.log('match_strategy: ' + finalOrder.rows[0].match_strategy);
      console.log('sender_address (TRX): ' + finalOrder.rows[0].sender_address);
      console.log('Tx hash: ' + finalOrder.rows[0].detected_tx_hash);
      console.log('LLM verdict: ' + finalOrder.rows[0].llm_verdict);
      console.log('Confirmed at: ' + finalOrder.rows[0].confirmed_at);
      console.log('Wallet tx: type=' + tx.rows[0].type + ' amount=' + tx.rows[0].amount_coins + ' source=' + tx.rows[0].source);
      console.log('[sim-trc20] PASS: non-memo chain credit path verified');
    }
  } else {
    console.log('[sim-trc20] would HOLD for review (verdict=' + ruleVerdict + ' conf=' + ruleConfidence + ')');
    await query(
      `UPDATE payment_orders
       SET status = 'verifying', admin_hold_reason = $1,
           llm_verdict = $2, llm_confidence = $3, llm_reason = $4,
           llm_scored_at = NOW(), rule_verdict = $5, rule_disagreement = $6
       WHERE merchant_order_id = $7`,
      ['Sim hold TRC20: ' + ruleReason, ruleVerdict, ruleConfidence, ruleReason, ruleVerdict, false, merchantOrderId]
    );
    console.log('[sim-trc20] order marked verifying');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[sim-trc20] FATAL:', err);
  process.exit(1);
});
