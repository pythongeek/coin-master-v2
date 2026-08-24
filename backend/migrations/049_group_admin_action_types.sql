-- Migration 049: Add group_* values to AdminActionType enum
-- (Gap 15 — admin_groups.ts must write to admin_actions on every POST route.)
--
-- The enum currently has 6 values: balance_adjustment, rate_override,
-- seed_rotation, config_change, withdrawal_approval, kyc_manual_review.
-- After this migration it gains 7 group-action values so the 6 admin
-- group routes (force-cancel, freeze, unfreeze, mark-fraud, refund,
-- kick, shadow) can write admin_actions rows with the correct type.
--
-- Concretely, ADD VALUE IF NOT EXISTS is the safe way to extend a
-- Postgres enum without rewriting the table. The new values are
-- available immediately after this migration runs.

ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_force_cancel';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_freeze';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_unfreeze';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_mark_fraud';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_refund';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_kick';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'group_shadow';
