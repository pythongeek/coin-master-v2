-- =============================================================
--  Migration 040: Daily Fraud Report digest (Phase 3 / P3-5)
-- =============================================================
--
--  Persists one row per daily digest sent. Idempotency key is
--  (report_date, report_kind) so the cron can re-fire safely
--  after a missed run.
--
--  Mirrors admin_email_templates-style admin-control pattern:
--    - admin_settings row `daily_fraud_report_enabled` (default
--      'true'; admins can disable the cron from the UI).
--    - admin_settings row `daily_fraud_report_recipient` (default
--      'ohmyholy99@gmail.com'; admins can change recipient).
--    - admin_settings row `daily_fraud_report_send_hour_utc`
--      (default '8' — 08:00 UTC daily, matching the plan).
--
--  The aggregation query (in daily-fraud-report.ts) reads from
--  fraud_signals, fraud_clusters, transactions, users — all
--  already populated by P3-1..P3-4 work. No additional reads.
-- =============================================================

CREATE TABLE IF NOT EXISTS daily_fraud_reports (
  id              BIGSERIAL PRIMARY KEY,
  report_date     DATE NOT NULL,                              -- the calendar day covered
  report_kind     VARCHAR(40) NOT NULL DEFAULT 'daily_digest'
                  CHECK (report_kind IN ('daily_digest', 'manual_test', 'on_demand')),
  recipient       VARCHAR(255) NOT NULL,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','queued','sent','skipped','error')),
  last_error      TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,         -- the aggregated digest body
  CONSTRAINT daily_fraud_reports_date_kind UNIQUE (report_date, report_kind)
);

-- Index for "show me the last 30 days" admin query.
CREATE INDEX IF NOT EXISTS idx_daily_fraud_reports_date
  ON daily_fraud_reports(report_date DESC, queued_at DESC);

-- Seed admin_settings (admin can edit via /admin/settings/bulk)
INSERT INTO admin_settings (key, value, description) VALUES
  ('daily_fraud_report_enabled',       'true',
   'Master switch for the 08:00 UTC daily fraud digest cron. true = send daily, false = paused.'),
  ('daily_fraud_report_recipient',     'ohmyholy99@gmail.com',
   'Recipient address for the daily fraud digest. Defaults to ohmyholy99@gmail.com per the P3-5 spec.'),
  ('daily_fraud_report_send_hour_utc', '8',
   'Hour of day (UTC, 0..23) to fire the daily digest. 8 = 08:00 UTC. Cron tick is once per hour, fires on this hour.'),
  ('daily_fraud_report_min_signals',   '1',
   'Minimum number of new fraud_signals in the last 24h before a digest is sent. Prevents empty-digest spam on quiet days. Set to 0 to always send.')
ON CONFLICT (key) DO NOTHING;

-- Seed the email template row. EN+BN like the rest of the codebase.
-- Template variables:
--   {{report_date}}      - the calendar day (YYYY-MM-DD)
--   {{top_risk_users}}   - HTML table of top-10 risk users
--   {{new_clusters}}     - HTML table of new clusters
--   {{cluster_actions}}  - HTML table of cluster actions
--   {{flagged_withdrawals}} - HTML table of flagged withdrawals
--   {{kyc_events}}       - HTML table of KYC events
--   {{signal_counts}}    - HTML table of fraud signal counts
--   {{ml_predictions}}   - HTML table of ML predictions fired
--   {{recommendations}}  - bullet list
--   {{total_signals}}    - count for the headline
INSERT INTO admin_email_templates (event_type, display_name, subject_template, body_html_template, body_text_template, available_variables, subject_bn, body_html_bn, body_text_bn)
VALUES (
  'fraud.daily_digest',
  'Daily Fraud Digest (08:00 UTC)',
  'CryptoFlip Daily Fraud Digest — {{report_date}}',
  '<h1>CryptoFlip Daily Fraud Digest — {{report_date}}</h1><p>Total new fraud signals in the last 24h: <strong>{{total_signals}}</strong></p><h2>Top 10 risk users</h2>{{top_risk_users}}<h2>New fraud clusters (24h)</h2>{{new_clusters}}<h2>Cluster actions (24h)</h2>{{cluster_actions}}<h2>Flagged withdrawals (24h)</h2>{{flagged_withdrawals}}<h2>KYC events (24h)</h2>{{kyc_events}}<h2>New fraud signals by type (24h)</h2>{{signal_counts}}<h2>ML model predictions (24h)</h2>{{ml_predictions}}<h2>Recommended actions</h2>{{recommendations}}',
  'CryptoFlip Daily Fraud Digest — {{report_date}}\n\nTotal new fraud signals in last 24h: {{total_signals}}\n\n-- Top 10 risk users --\n{{top_risk_users}}\n\n-- New fraud clusters --\n{{new_clusters}}\n\n-- Cluster actions --\n{{cluster_actions}}\n\n-- Flagged withdrawals --\n{{flagged_withdrawals}}\n\n-- KYC events --\n{{kyc_events}}\n\n-- Signal counts by type --\n{{signal_counts}}\n\n-- ML predictions --\n{{ml_predictions}}\n\n-- Recommended actions --\n{{recommendations}}',
  '["report_date","total_signals","top_risk_users","new_clusters","cluster_actions","flagged_withdrawals","kyc_events","signal_counts","ml_predictions","recommendations"]'::jsonb,
  'CryptoFlip দৈনিক ফ্রড ডাইজেস্ট — {{report_date}}',
  '<h1>CryptoFlip দৈনিক ফ্রড ডাইজেস্ট — {{report_date}}</h1><p>গত ২৪ ঘণ্টায় নতুন ফ্রড সিগন্যাল: <strong>{{total_signals}}</strong></p><h2>শীর্ষ ১০ ঝুঁকিপূর্ণ ব্যবহারকারী</h2>{{top_risk_users}}<h2>নতুন ফ্রড ক্লাস্টার</h2>{{new_clusters}}<h2>ক্লাস্টার কর্ম</h2>{{cluster_actions}}<h2>ফ্ল্যাগ করা উইথড্রয়াল</h2>{{flagged_withdrawals}}<h2>KYC ইভেন্ট</h2>{{kyc_events}}<h2>ফ্রড সিগন্যাল টাইপ অনুযায়ী</h2>{{signal_counts}}<h2>ML মডেল পূর্বাভাস</h2>{{ml_predictions}}<h2>সুপারিশকৃত কর্ম</h2>{{recommendations}}',
  'CryptoFlip দৈনিক ফ্রড ডাইজেস্ট — {{report_date}}\n\nগত ২৪ ঘণ্টায় নতুন ফ্রড সিগন্যাল: {{total_signals}}\n\n(বাকি বিভাগগুলো ইংরেজি সংস্করণের মতোই)'
)
ON CONFLICT (event_type) DO NOTHING;

-- Seed the admin_email_config row for the P3-5 recipient. Without
-- this row, queueEmail() rejects the email with "recipient not
-- configured" (the queueEmail code path checks
-- admin_email_config.email first, then per-event toggles).
INSERT INTO admin_email_config (email, display_name, role, is_enabled, notes, created_by)
VALUES (
  'ohmyholy99@gmail.com',
  'CryptoFlip Fraud Operator',
  'super_admin',
  true,
  'Default recipient for the daily fraud digest (P3-5). Set daily_fraud_report_recipient admin_setting to change.',
  NULL
) ON CONFLICT (email) DO UPDATE SET is_enabled = true;

-- Audit row so this migration is visible in audit_log.
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.daily_fraud_reports', 'info',
        jsonb_build_object(
          'migration', '040_daily_fraud_reports',
          'tables_created', ARRAY['daily_fraud_reports'],
          'admin_settings_seeded', ARRAY[
            'daily_fraud_report_enabled',
            'daily_fraud_report_recipient',
            'daily_fraud_report_send_hour_utc',
            'daily_fraud_report_min_signals'
          ],
          'email_template_seeded', 'fraud.daily_digest',
          'admin_email_config_seeded', 'ohmyholy99@gmail.com'
        ));