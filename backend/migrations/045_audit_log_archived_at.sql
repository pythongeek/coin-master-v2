-- Migration 045: add archived_at to audit_log (P0-04)
--
-- Background: audit-backup.ts was previously hard-coded to query a
-- non-existent `audit_logs` (plural) table with `archived_at IS NULL`
-- semantics and columns that don't exist on the live `audit_log` table
-- (table_name, record_id, old_data, new_data, changed_by). That bug
-- caused the hourly archive worker to fail silently.
--
-- This migration adds the only column the new fixed query needs:
--   archived_at TIMESTAMPTZ NULL
-- and a partial index that lets the archive worker pick up only the
-- rows that still need to be written out.
--
-- NOTE on column selection: the live `audit_log` table uses the
-- newer "category / action / severity / details(jsonb) / user_id"
-- schema (created by migrations 001 + 023 + 028). It does NOT have
-- the legacy `audit_logs` columns (table_name, record_id, old_data,
-- new_data, changed_by, chain_hash) that schema.sql defines for a
-- table that was never applied to this database. We deliberately
-- match the LIVE schema here.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Partial index: only unarchived rows are interesting to the backup
-- worker. Keeps the SELECT cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_audit_log_unarchived
  ON audit_log(created_at)
  WHERE archived_at IS NULL;
