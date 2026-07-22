-- Migration 023: admin notes on audit_log (compliance annotations)
-- Lets super_admins annotate any audit row (e.g. "reviewed, no action needed",
-- "forwarded to legal team", "ticket #4521 resolved"). Useful for compliance
-- trails where regulators want to know who looked at what.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS admin_notes TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes_by UUID,
  ADD COLUMN IF NOT EXISTS admin_notes_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_audit_log_severity_created
  ON audit_log(severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
  ON audit_log(action, created_at DESC);
