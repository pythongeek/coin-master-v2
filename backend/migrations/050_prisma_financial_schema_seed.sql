-- Migration 050: seed currencies with the USDT row deposit.service.ts expects.
--
-- Why this seed exists:
--   deposit.service.ts:17 hardcodes USDT_CURRENCY_ID =
--   '00000000-0000-0000-0000-000000000001' and uses that exact UUID to
--   write `currencyId` on every deposit_transactions row. The Prisma
--   schema declares currencies.code @unique and the production schema
--   (049_prisma_financial_schema.sql) creates the currencies table, but
--   no production code reads from it yet — every deposit path uses the
--   in-memory USDT_CONFIG object.
--
--   This seed creates the USDT row with the hardcoded UUID, mirroring
--   the in-memory USDT_CONFIG values:
--     code:           'USDT'
--     name:           'Tether USD'
--     symbol:         '₮'
--     decimal_places: 6   (matches USDT_CONFIG.decimalPlaces)
--     is_active:      true (matches USDT_CONFIG.isActive)
--     min_deposit:    10   (matches USDT_CONFIG.minDeposit)
--     max_deposit:    100000 (matches USDT_CONFIG.maxDeposit)
--     withdrawal_fee: 0
--     blockchain_network: 'tron'
--
--   When WO-3 wires production code to query currencies by code, the
--   row is already there. Until then, the row is dormant and harmless.
--
--   No BDT row is seeded — fiat balance is tracked in users.balance /
--   users.withdrawable_balance_coins, not in currencies. Adding BDT
--   would create a row whose code is referenced nowhere.
--
-- Idempotency: ON CONFLICT (id) DO UPDATE keeps the seed deterministic
-- across re-runs without erroring. Re-applying the migration updates
-- the row to match the canonical values; it never inserts a duplicate.

BEGIN;

INSERT INTO currencies (
  id,
  code,
  name,
  symbol,
  decimal_places,
  exchange_rate,
  exchange_rate_updated_at,
  is_default,
  is_active,
  min_deposit,
  max_deposit,
  min_withdrawal,
  max_withdrawal,
  withdrawal_fee,
  blockchain_network,
  contract_address,
  updated_by_id,
  updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'USDT',
  'Tether USD',
  '₮',
  6,
  0,
  NOW(),
  true,
  true,
  10,
  100000,
  NULL,
  NULL,
  0,
  'tron',
  NULL,
  NULL,
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  code              = EXCLUDED.code,
  name              = EXCLUDED.name,
  symbol            = EXCLUDED.symbol,
  decimal_places    = EXCLUDED.decimal_places,
  is_default        = EXCLUDED.is_default,
  is_active         = EXCLUDED.is_active,
  min_deposit       = EXCLUDED.min_deposit,
  max_deposit       = EXCLUDED.max_deposit,
  withdrawal_fee    = EXCLUDED.withdrawal_fee,
  blockchain_network = EXCLUDED.blockchain_network,
  updated_at        = NOW();

COMMIT;