-- Migration 050: Group play house ledger entries (Gap 9)
--
-- Closes the gap where group wins/losses (the house take) were never
-- recorded in `ledger_entries`. The `transactions` table recorded the
-- user-side legs (debit on join, credit on win) but the house-side
-- (pool_received, pool_paid_out, house_take) was invisible to the
-- accounting layer.
--
-- Three things this migration does:
--
--  1. Extends the `LedgerEntryType` enum with 3 group-side values:
--     - group_pool_received  — the house received the pool from the
--                               members (debit per member at JOIN time
--                               was the user-side mirror).
--     - group_pool_paid_out  — the house paid out winning shares.
--     - group_house_take     — the house retained the spread
--                               (totalPool - totalPaidOut).
--
--  2. Seeds a USD currency row. The `currencies` table was empty on
--     the live DB even though every transactions/credit logic assumed
--     USD; the lack of a row would force any ledger_entries INSERT to
--     leave `currency_id` NULL, which the schema forbids (NOT NULL).
--     Seeded with code='USD', is_default=true, exchange_rate=1.0.
--
--  3. Seeds a sentinel `_house` user. The `user_id` column on
--     `ledger_entries` is NOT NULL, but house-side entries are
--     inherently userless. The sentinel (fixed UUID
--     `00000000-0000-0000-0000-000000000001`) is a non-person
--     placeholder: `is_active=false`, `is_admin=false`, `kyc_tier=0`,
--     no `password_hash`, no `email`. The application code never
--     queries this user through the auth surface.
--
-- Idempotency: every INSERT uses ON CONFLICT DO NOTHING so the
-- migration can be re-applied on a partially-migrated DB without
-- erroring.

-- ─── 1. LedgerEntryType enum: add 3 group-side values ─────────
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'group_pool_received';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'group_pool_paid_out';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'group_house_take';

-- ─── 2. Seed USD currency row (currencies table was empty) ───
INSERT INTO currencies (id, code, name, symbol, decimal_places,
                        exchange_rate, exchange_rate_updated_at,
                        is_default, is_active, updated_at)
VALUES (
  '00000000-0000-0000-0000-0000000000aa',
  'USD',
  'US Dollar',
  '$',
  2,
  1.0,
  NOW(),
  true,
  true,
  NOW()
)
ON CONFLICT (code) DO NOTHING;

-- ─── 3. Seed _house sentinel user (sentinel for house-side ledger) ─
-- Fixed UUID is important: application code references it by literal.
INSERT INTO users (id, username, is_active, is_admin, kyc_tier,
                  kyc_status, total_wagered, pending_rakeback,
                  bonus_balance_coins, withdrawable_balance_coins,
                  total_deposited_coins, total_bonus_claimed_coins,
                  pending_affiliate_balance, total_affiliate_earned,
                  is_flagged, wallet_balance_coins, balance,
                  two_factor_enabled, totp_enabled, created_at,
                  updated_at, preferred_language)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '_house',
  false,        -- never logged into
  false,        -- not an admin
  '0',
  'unverified',
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  false,
  0,
  0,
  false,
  false,
  NOW(),
  NOW(),
  'en'
)
ON CONFLICT (id) DO NOTHING;
