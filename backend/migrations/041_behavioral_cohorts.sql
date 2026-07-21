-- =============================================================
--  Migration 041: Behavioral Cohort Comparison (P3-6)
-- =============================================================
--
--  Weekly batch ML job that compares each user's behavior against
--  their peer cohort (country + KYC tier + account-age bucket +
--  device-class) and surfaces statistical outliers. Per the
--  CryptoFlip_BonusSystem_CompleteDocs.md:1517 P3-6 spec.
--
--  Three tables:
--
--    1. behavioral_cohort_assignments
--         Per-user cohort assignment. The cohort_key is a
--         deterministic hash of (country, kyc_tier, age_bucket,
--         device_class) so users with the same profile land in
--         the same cohort across runs.
--
--    2. behavioral_cohort_stats
--         Aggregated peer metrics per cohort. Recomputed weekly
--         (or on-demand via /api/admin/cohorts/run-now).
--
--    3. behavioral_cohort_outliers
--         Users whose behavior is > z_threshold standard
--         deviations from the cohort mean. Also written as
--         fraud_signals rows so the AI risk engine picks them
--         up on the next login (same pattern as P3-4a
--         persistIpGeoSignals).
--
--  Idempotency: stats are upserted per (cohort_key, metric).
--  Outliers are upserted per (user_id, metric) within a run; if
--  the next run finds the user is no longer an outlier, the row
--  is left as-is (it becomes a historical record).
-- =============================================================

-- Cohort key shape: 'XX-T-AGE-DEV' e.g. 'BD-1-young-mobile'
-- Where:
--   XX   = 2-letter country code (or 'XX' for unknown)
--   T    = 0..3 (kyc_tier, or 'X' if missing)
--   AGE  = 'young' (<30d) | 'mid' (30-180d) | 'old' (>180d)
--   DEV  = 'mobile' | 'desktop' | 'tablet' | 'unknown'
-- The full string is hashed to keep the column narrow while still
-- allowing reconstruction via a backref function.

CREATE TABLE IF NOT EXISTS behavioral_cohort_assignments (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  cohort_key            VARCHAR(64) NOT NULL,
  cohort_features_hash  VARCHAR(64) NOT NULL,
  cohort_size           INTEGER NOT NULL DEFAULT 0,           -- recomputed each run
  last_assigned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cohort_assignments_key
  ON behavioral_cohort_assignments(cohort_key);

-- Aggregated peer metrics per cohort. Uniqueness on (cohort_key,
-- metric) so weekly runs upsert.
CREATE TABLE IF NOT EXISTS behavioral_cohort_stats (
  id            BIGSERIAL PRIMARY KEY,
  cohort_key    VARCHAR(64) NOT NULL,
  metric        VARCHAR(64) NOT NULL,                       -- e.g. 'bets_per_day', 'avg_bet_amount', 'risk_score'
  mean_value    DOUBLE PRECISION NOT NULL,
  stddev_value  DOUBLE PRECISION,
  p50_value     DOUBLE PRECISION,
  p95_value     DOUBLE PRECISION,
  n_samples     INTEGER NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cohort_stats_unique UNIQUE (cohort_key, metric)
);

CREATE INDEX IF NOT EXISTS idx_cohort_stats_key
  ON behavioral_cohort_stats(cohort_key);

-- Per-user per-metric outlier record.
CREATE TABLE IF NOT EXISTS behavioral_cohort_outliers (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cohort_key      VARCHAR(64) NOT NULL,
  metric          VARCHAR(64) NOT NULL,
  user_value      DOUBLE PRECISION NOT NULL,
  cohort_mean     DOUBLE PRECISION NOT NULL,
  cohort_stddev   DOUBLE PRECISION NOT NULL,
  z_score         DOUBLE PRECISION NOT NULL,
  severity        VARCHAR(16) NOT NULL DEFAULT 'medium'
                  CHECK (severity IN ('low','medium','high','critical')),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cohort_outliers_unique UNIQUE (user_id, metric, cohort_key)
);

CREATE INDEX IF NOT EXISTS idx_cohort_outliers_severity
  ON behavioral_cohort_outliers(severity, detected_at DESC);

-- Admin settings to control the weekly job.
INSERT INTO admin_settings (key, value, description) VALUES
  ('cohort_analysis_enabled',       'true',
   'Master switch for the weekly behavioral cohort comparison. true = run weekly + on-demand, false = paused.'),
  ('cohort_analysis_z_threshold',  '2.5',
   'Z-score threshold for flagging an outlier. 2.5 = strict, 3.0 = loose. Applies to all metrics.'),
  ('cohort_analysis_lookback_days', '90',
   'Number of days of behavior history to aggregate per cohort. Default 90d.'),
  ('cohort_analysis_send_hour_utc', '4',
   'Hour of day (UTC, 0..23) to fire the weekly batch. 4 = 04:00 UTC Sunday. Cron ticks hourly; runs on this hour AND on Sunday.')
ON CONFLICT (key) DO NOTHING;

-- Audit row so this migration is visible in audit_log.
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.behavioral_cohorts', 'info',
        jsonb_build_object(
          'migration', '041_behavioral_cohorts',
          'tables_created', ARRAY[
            'behavioral_cohort_assignments',
            'behavioral_cohort_stats',
            'behavioral_cohort_outliers'
          ],
          'admin_settings_seeded', ARRAY[
            'cohort_analysis_enabled',
            'cohort_analysis_z_threshold',
            'cohort_analysis_lookback_days',
            'cohort_analysis_send_hour_utc'
          ]
        ));