#!/bin/bash
# =============================================================================
# CI MIGRATION BOOTSTRAP — combine legacy SQL files into a single script
# =============================================================================
#
# The production live DB has a multi-stage history:
#   1. `schema.sql` (created the base tables via docker-entrypoint-initdb.d)
#   2. Legacy hand-applied SQL files in backend/src/db/migrations*.sql
#      (created server_seeds, wallet_settings, rate_cache, bonus_claims,
#      payment_orders, etc. — applied manually before the node-pg-migrate
#      migration system existed)
#   3. node-pg-migrate migrations in backend/migrations/ (P0-03 onwards)
#
# This script concatenates the legacy stage into a single .sql file for CI
# to mount into the postgres init dir. The result is a faithful simulation
# of what a freshly-deployed production DB looks like before any
# node-pg-migrate migrations run.
#
# Usage: bash scripts/build-ci-bootstrap.sh > /tmp/ci-bootstrap.sql
#
# Output: a single SQL file containing all CREATE TABLE statements from
# `schema.sql` plus all `backend/src/db/migrations*.sql` files, in
# dependency order.
#
# Idempotent: all CREATE TABLE use IF NOT EXISTS.

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. schema.sql — base tables (users, bets, game_seeds, transactions, etc.)
cat src/db/schema.sql

# 2. migrations.sql — v1->v2 (audit_log singular, fraud_signals, etc.)
echo
echo "-- ── LEGACY: migrations.sql ────────────────────────────────────────"
cat src/db/migrations.sql

# 3. migrations-2.3.sql — server_seeds + improvements
echo
echo "-- ── LEGACY: migrations-2.3.sql ─────────────────────────────────────"
cat src/db/migrations-2.3.sql

# 4. migrations-2.4.sql — wallet_settings, rate_cache, wallet_transactions
echo
echo "-- ── LEGACY: migrations-2.4.sql ─────────────────────────────────────"
cat src/db/migrations-2.4.sql

# 5. migrations-binance-redot.sql — payment provider config
echo
echo "-- ── LEGACY: migrations-binance-redot.sql ──────────────────────────"
cat src/db/migrations-binance-redot.sql

# 6. migrations-2.7-bonus-wagering.sql — bonus_claims, kyc_submissions
echo
echo "-- ── LEGACY: migrations-2.7-bonus-wagering.sql ─────────────────────"
cat src/db/migrations-2.7-bonus-wagering.sql

# 7. migrations-bonus-campaigns.sql — bonus_campaigns
echo
echo "-- ── LEGACY: migrations-bonus-campaigns.sql ────────────────────────"
cat src/db/migrations-bonus-campaigns.sql

# 8. migrations-reconcile-backfill.sql — final backfill
echo
echo "-- ── LEGACY: migrations-reconcile-backfill.sql ────────────────────"
cat src/db/migrations-reconcile-backfill.sql

echo
echo "-- ── END LEGACY BOOTSTRAP ───────────────────────────────────────────"