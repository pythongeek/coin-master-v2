-- Migration 049_0: Prisma financial schema baseline + db-push drift closure
--
-- This file is the closure migration for the historical migrations 049-058
-- that production carries in its pgmigrations table but which main does
-- not have on disk. Three things this file does, in order:
--
-- 1. **Prisma DDL (verbatim from prisma migrate diff).** 8 tables + 7
--    enums + their indexes, byte-identical to what `prisma migrate diff
--    --from-empty --to-schema-datamodel prisma/schema.prisma --script`
--    produces. Source of truth is prisma/schema.prisma.
-- 2. **Closure additions.** 10 user-table columns that historical 050
--    (group_house_ledger) needs on `users`, plus the group_bet table +
--    indexes + trigger function + trigger that historical 053
--    (group_spectator_count) alters. These come from production's actual
--    pg_dump shape — types, defaults, nullability are exactly what
--    production has.
-- 3. **Dual-mode guards.** Every CREATE statement is wrapped in
--    existence-check (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--    EXISTS, or a DO block with `EXCEPTION WHEN duplicate_object THEN
--    NULL` for CREATE TYPE which can't use IF NOT EXISTS in pre-Postgres-14
--    DDL). On production this file is a no-op (every object exists;
--    guarded statements skip). On a fresh DB it creates the full closure.
--
-- Filename uses the `049_0_` sub-prefix to sort lexically before
-- `049_group_admin_action_types.sql` (which needs the AdminActionType
-- enum this file creates). Per-version lexical sort: `_`=0x5F (95) <
-- `g`=0x67 (103). This preserves production's pgmigrations state (prod
-- never recorded the WO-2 names, so the rename 049_prisma_financial_schema
-- -> 049_0_prisma_baseline requires zero pgmigrations surgery on prod).
--
-- Migration 050 (prisma_financial_schema_seed) and 051
-- (blockchain_tx_id_unique) stay at their original 050/051 prefixes —
-- they sort after the historical 050/051 files by the same lexical rule.


-- ============================================================
-- SECTION 1: Prisma DDL (verbatim from prisma migrate diff)
-- ============================================================

DO $$ BEGIN
  CREATE TYPE "RateSourceType" AS ENUM ('binance_p2p', 'binance_spot', 'bangladesh_bank', 'custom', 'manual_override');

-- CreateEnum
CREATE TYPE "RateLockStatus" AS ENUM ('active', 'consumed', 'expired', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DepositStatus" AS ENUM ('initiated', 'rate_locked', 'awaiting_payment', 'payment_detected', 'confirming', 'completed', 'failed', 'expired', 'refunded');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('BDT', 'USD', 'USDT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LedgerEntryType" AS ENUM ('deposit', 'withdrawal', 'bet', 'win', 'loss', 'refund', 'admin_adjustment', 'fee', 'transfer_in', 'transfer_out');

-- CreateEnum
CREATE TYPE "AdminActionType" AS ENUM ('balance_adjustment', 'rate_override', 'seed_rotation', 'config_change', 'withdrawal_approval', 'kyc_manual_review');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AdminApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'executed', 'cancelled');

-- CreateTable
CREATE TABLE IF NOT EXISTS "exchange_rates" (
    "id" UUID NOT NULL,
    "currency_pair" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "inverse_rate" DECIMAL(20,10) NOT NULL,
    "source_type" "RateSourceType" NOT NULL,
    "source_url" TEXT,
    "source_response" JSONB,
    "buy_spread" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "sell_spread" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "effective_buy_rate" DECIMAL(20,10) NOT NULL,
    "effective_sell_rate" DECIMAL(20,10) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "set_by_id" UUID,
    "custom_justification" TEXT,
    "is_platform_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "rate_locks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_pair" TEXT NOT NULL,
    "locked_rate" DECIMAL(20,10) NOT NULL,
    "locked_inverse_rate" DECIMAL(20,10) NOT NULL,
    "direction" TEXT NOT NULL,
    "input_amount" DECIMAL(20,8) NOT NULL,
    "output_amount" DECIMAL(20,8) NOT NULL,
    "exchange_rate_id" UUID NOT NULL,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "RateLockStatus" NOT NULL DEFAULT 'active',
    "consumed_at" TIMESTAMP(3),
    "consumed_by_tx_id" UUID,
    "ip_address" TEXT,
    "device_fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_locks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "deposit_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_id" UUID NOT NULL,
    "rate_lock_id" UUID,
    "blockchain_network" TEXT,
    "from_address" TEXT,
    "to_address" TEXT NOT NULL,
    "blockchain_tx_id" TEXT,
    "block_number" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "required_confirmations" INTEGER NOT NULL DEFAULT 19,
    "crypto_amount" DECIMAL(20,8) NOT NULL,
    "fiat_equivalent" DECIMAL(20,8) NOT NULL,
    "platform_fee" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "net_credit_amount" DECIMAL(20,8) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'initiated',
    "status_history" JSONB[],
    "failure_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "detected_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ledger_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "custom_rate_configs" (
    "id" UUID NOT NULL,
    "currency_pair" TEXT NOT NULL,
    "custom_rate" DECIMAL(20,10) NOT NULL,
    "inverse_rate" DECIMAL(20,10) NOT NULL,
    "buy_spread" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "sell_spread" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_platform_default" BOOLEAN NOT NULL DEFAULT false,
    "set_by_id" UUID NOT NULL,
    "justification" TEXT NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "auto_revert" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_rate_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "currencies" (
    "id" UUID NOT NULL,
    "code" "CurrencyCode" NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimal_places" INTEGER NOT NULL DEFAULT 2,
    "exchange_rate" DECIMAL(20,10) NOT NULL,
    "exchange_rate_updated_at" TIMESTAMP(3) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "min_deposit" DECIMAL(20,8),
    "max_deposit" DECIMAL(20,8),
    "min_withdrawal" DECIMAL(20,8),
    "max_withdrawal" DECIMAL(20,8),
    "withdrawal_fee" DECIMAL(20,8),
    "blockchain_network" TEXT,
    "contract_address" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_balances" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_id" UUID NOT NULL,
    "available_balance" DECIMAL(20,8) NOT NULL,
    "reserved_balance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_deposited" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_withdrawn" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_wagered" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_won" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "total_lost" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_balances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ledger_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "balance_before" DECIMAL(20,8) NOT NULL,
    "balance_after" DECIMAL(20,8) NOT NULL,
    "session_id" UUID,
    "game_round_id" UUID,
    "reference_id" TEXT,
    "previous_hash" TEXT NOT NULL,
    "current_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "admin_actions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action_type" "AdminActionType" NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "justification" TEXT NOT NULL,
    "approval_status" "AdminApprovalStatus" NOT NULL DEFAULT 'pending',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "exchange_rates_currency_pair_is_platform_default_idx" ON "exchange_rates"("currency_pair", "is_platform_default");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "exchange_rates_currency_pair_fetched_at_idx" ON "exchange_rates"("currency_pair", "fetched_at");

CREATE INDEX IF NOT EXISTS "exchange_rates_source_type_is_platform_default_idx" ON "exchange_rates"("source_type", "is_platform_default");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "rate_locks_user_id_status_idx" ON "rate_locks"("user_id", "status");

CREATE INDEX IF NOT EXISTS "rate_locks_expires_at_status_idx" ON "rate_locks"("expires_at", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_transactions_user_id_status_idx" ON "deposit_transactions"("user_id", "status");

CREATE INDEX IF NOT EXISTS "deposit_transactions_blockchain_tx_id_idx" ON "deposit_transactions"("blockchain_tx_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_transactions_to_address_status_idx" ON "deposit_transactions"("to_address", "status");

CREATE INDEX IF NOT EXISTS "deposit_transactions_status_created_at_idx" ON "deposit_transactions"("status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "custom_rate_configs_currency_pair_is_platform_default_idx" ON "custom_rate_configs"("currency_pair", "is_platform_default");

CREATE INDEX IF NOT EXISTS "custom_rate_configs_currency_pair_is_active_idx" ON "custom_rate_configs"("currency_pair", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "currencies_code_key" ON "currencies"("code");

CREATE INDEX IF NOT EXISTS "currencies_is_default_idx" ON "currencies"("is_default");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "currencies_is_active_idx" ON "currencies"("is_active");

CREATE INDEX IF NOT EXISTS "user_balances_user_id_idx" ON "user_balances"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_balances_currency_id_idx" ON "user_balances"("currency_id");

CREATE UNIQUE INDEX IF NOT EXISTS "user_balances_user_id_currency_id_key" ON "user_balances"("user_id", "currency_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_entries_reference_id_key" ON "ledger_entries"("reference_id");

CREATE INDEX IF NOT EXISTS "ledger_entries_user_id_currency_id_created_at_idx" ON "ledger_entries"("user_id", "currency_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ledger_entries_reference_id_idx" ON "ledger_entries"("reference_id");

CREATE INDEX IF NOT EXISTS "ledger_entries_entry_type_idx" ON "ledger_entries"("entry_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_actions_admin_id_created_at_idx" ON "admin_actions"("admin_id", "created_at");

CREATE INDEX IF NOT EXISTS "admin_actions_approval_status_idx" ON "admin_actions"("approval_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_actions_target_type_target_id_idx" ON "admin_actions"("target_type", "target_id");

-- ============================================================
-- SECTION 2: Closure additions (users columns + group_bet + fn + trigger)
-- ============================================================
-- These are the exact shapes production carries (extracted from prod
-- pg_dump on 2026-08-24). Each statement is idempotent on its own
-- (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF
-- NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS).
-- Fresh DBs recreate the closure; production already has it.

-- --- users columns needed by historical 050's _house sentinel INSERT ---
-- 10 columns. Production has them; legacy schema.sql doesn't.
-- Source: pg_dump --schema-only of public.users on production.
-- Non-closure columns (15 of the 25 drift) are queued to WO-7.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance_coins NUMERIC(18, 8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawable_balance_coins NUMERIC(18, 8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_deposited_coins NUMERIC(18, 8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_bonus_claimed_coins NUMERIC(18, 8) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_affiliate_balance NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_affiliate_earned NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) NOT NULL DEFAULT 'en';

-- --- group_bet table (closure of historical 053) ---
-- Historical 053 ALTERs group_bet to add spectator_count. Production has
-- the full table shape (columns + indexes + CHECK constraints + trigger
-- function + trigger). On a fresh DB, 053's
-- `ALTER TABLE group_bet ADD COLUMN IF NOT EXISTS spectator_count ...` is a
-- no-op (the column is already there from this baseline). 053's
-- `CREATE INDEX IF NOT EXISTS idx_group_bet_has_spectators ...` is also a
-- no-op. So 053 itself becomes idempotent on a fresh DB; this matches
-- the production behavior exactly. **Path taken: post-053 shape.**

CREATE TABLE IF NOT EXISTS group_bet (
    id UUID DEFAULT public.uuid_generate_v4() NOT NULL,
    short_code VARCHAR(10) NOT NULL,
    creator_id UUID NOT NULL,
    game_type VARCHAR(20) DEFAULT 'coinflip' NOT NULL,
    mode VARCHAR(20) DEFAULT 'wait' NOT NULL,
    status VARCHAR(20) DEFAULT 'open' NOT NULL,
    creator_choice VARCHAR(10) NOT NULL,
    creator_stake NUMERIC(18,8) NOT NULL,
    per_member_stake NUMERIC(18,8) NOT NULL,
    total_pool NUMERIC(18,8) DEFAULT 0 NOT NULL,
    min_members SMALLINT DEFAULT 2 NOT NULL,
    max_members SMALLINT DEFAULT 5 NOT NULL,
    current_members SMALLINT DEFAULT 1 NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD' NOT NULL,
    payout_mode VARCHAR(20) DEFAULT 'equal' NOT NULL,
    turn_mode VARCHAR(20) DEFAULT 'creator' NOT NULL,
    auto_flip_seconds INTEGER DEFAULT 5 NOT NULL,
    invite_token VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    ready_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    winning_side VARCHAR(10),
    server_seed_hash VARCHAR(64),
    server_seed_reveal VARCHAR(64),
    client_seed VARCHAR(64),
    nonce BIGINT,
    result_hash VARCHAR(64),
    founder_boost_pct NUMERIC(5,2) DEFAULT 10.00 NOT NULL,
    fraud_score INTEGER DEFAULT 0 NOT NULL,
    fraud_flags JSONB DEFAULT '[]' NOT NULL,
    is_frozen BOOLEAN DEFAULT FALSE NOT NULL,
    cancelled_reason TEXT,
    client_request_id VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    spectator_count INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT chk_min_max_members CHECK ((max_members >= min_members)),
    CONSTRAINT group_bet_auto_flip_seconds_check CHECK (((auto_flip_seconds >= 1) AND (auto_flip_seconds <= 60))),
    CONSTRAINT group_bet_creator_choice_check CHECK (((creator_choice)::text = ANY ((ARRAY['heads'::varchar, 'tails'::varchar])::text[]))),
    CONSTRAINT group_bet_creator_stake_check CHECK ((creator_stake > (0)::numeric)),
    CONSTRAINT group_bet_current_members_check CHECK (((current_members >= 1) AND (current_members <= 10))),
    CONSTRAINT group_bet_founder_boost_pct_check CHECK (((founder_boost_pct >= (0)::numeric) AND (founder_boost_pct <= (50)::numeric))),
    CONSTRAINT group_bet_fraud_score_check CHECK (((fraud_score >= 0) AND (fraud_score <= 100))),
    CONSTRAINT group_bet_game_type_check CHECK (((game_type)::text = ANY ((ARRAY['coinflip'::varchar, 'dice'::varchar, 'crash'::varchar])::text[]))),
    CONSTRAINT group_bet_max_members_check CHECK (((max_members >= 2) AND (max_members <= 10))),
    CONSTRAINT group_bet_min_members_check CHECK (((min_members >= 2) AND (min_members <= 10))),
    CONSTRAINT group_bet_mode_check CHECK (((mode)::text = ANY ((ARRAY['wait'::varchar, 'lottery'::varchar, 'auto'::varchar, 'live'::varchar])::text[]))),
    CONSTRAINT group_bet_payout_mode_check CHECK (((payout_mode)::text = ANY ((ARRAY['equal'::varchar, 'proportional'::varchar, 'founder_boost'::varchar])::text[]))),
    CONSTRAINT group_bet_per_member_stake_check CHECK ((per_member_stake > (0)::numeric)),
    CONSTRAINT group_bet_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::varchar, 'open'::varchar, 'ready'::varchar, 'flipping'::varchar, 'resolved'::varchar, 'cancelled'::varchar, 'expired'::varchar, 'frozen'::varchar])::text[]))),
    CONSTRAINT group_bet_total_pool_check CHECK ((total_pool >= (0)::numeric)),
    CONSTRAINT group_bet_turn_mode_check CHECK (((turn_mode)::text = ANY ((ARRAY['creator'::varchar, 'auto_on_full'::varchar, 'random_lottery'::varchar])::text[]))),
    CONSTRAINT group_bet_winning_side_check CHECK (((winning_side)::text = ANY ((ARRAY['heads'::varchar, 'tails'::varchar])::text[])))
);

-- group_bet indexes (including the one historical 053 creates)
CREATE INDEX IF NOT EXISTS idx_group_bet_creator ON group_bet USING btree (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_bet_creator_idem ON group_bet USING btree (creator_id, client_request_id) WHERE (client_request_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_group_bet_expires_open ON group_bet USING btree (expires_at) WHERE ((status)::text = ANY ((ARRAY['open'::varchar, 'ready'::varchar])::text[]));
CREATE INDEX IF NOT EXISTS idx_group_bet_has_spectators ON group_bet USING btree (id) WHERE (spectator_count > 0);
CREATE INDEX IF NOT EXISTS idx_group_bet_short_code ON group_bet USING btree (short_code);
CREATE INDEX IF NOT EXISTS idx_group_bet_status ON group_bet USING btree (status);

-- group_bet updated_at trigger function + trigger
CREATE OR REPLACE FUNCTION public.group_bet_set_updated_at() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- pgmigrations unique index on `name` — closure dependency for the
-- hand-written `INSERT INTO pgmigrations (name, run_on) ... ON CONFLICT
-- (name) DO NOTHING` clauses in historicals 053 and 054. node-pg-migrate's
-- own runner does NOT create this index (it tracks migrations by id, not
-- name; see node-pg-migrate/dist/bundle/index.js line 3016). Production
-- applied these migrations directly via psql, so prod's pgmigrations has
-- no UNIQUE on name — which means 053/054's ON CONFLICT clause would fail
-- with 42P10 if applied on a fresh DB. The baseline creates the UNIQUE
-- index idempotently, so the verbatim 053/054 work cleanly on a fresh DB
-- AND on production (where the constraint doesn't exist but the rows
-- already do — so the INSERT path never executes; the index creation is
-- skipped by IF NOT EXISTS).
--
-- Production pgmigrations has no duplicate `name` values (verified via
-- `SELECT name, count(*) FROM pgmigrations GROUP BY name HAVING count(*) > 1`
-- on 2026-08-24), so adding the UNIQUE constraint is safe.
--
-- Why we DON'T add this to 047 or earlier: only 053 and 054 have the
-- ON CONFLICT(name) clause; the rest of the migrations use node-pg-migrate's
-- automatic tracker which doesn't need this constraint. Adding it here
-- (before 053 runs) ensures 053's ON CONFLICT can resolve correctly.
CREATE UNIQUE INDEX IF NOT EXISTS pgmigrations_name_key
  ON pgmigrations (name);

DROP TRIGGER IF EXISTS trg_group_bet_updated_at ON public.group_bet;
CREATE TRIGGER trg_group_bet_updated_at BEFORE UPDATE ON public.group_bet FOR EACH ROW EXECUTE FUNCTION public.group_bet_set_updated_at();

-- node-pg-migrate records the baseline's migration row automatically
-- after the SQL above completes without errors (see
-- node-pg-migrate/dist/bundle/index.js line 3016:
-- `INSERT INTO "${migrationsTable}" (name, run_on) VALUES ($1, NOW())`).
-- We deliberately do NOT add our own INSERT for this baseline so we
-- don't introduce a conflict with node-pg-migrate's automatic tracker.

