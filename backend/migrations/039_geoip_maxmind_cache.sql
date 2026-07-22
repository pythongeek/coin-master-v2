-- =============================================================
--  Migration 039: MaxMind GeoIP2 country lookup cache (P3-4a)
-- =============================================================
--  Persists the result of every MaxMind country lookup so the
--  risk engine + withdrawal pipeline can join on country without
--  re-loading the .mmdb file on every request.
--
--  Two design choices that match the existing IP reputation
--  pattern (see migration 036):
--
--  1. Cache layer is keyed on (ip_address, provider, checked_at)
--     so the same IP queried under multiple providers (maxmind,
--     geoip-lite, manual) doesn't collide.
--
--  2. expires_at is the staleness boundary (7 days by default
--     because country assignments are stable on the order of
--     months — country doesn't rotate the way IP reputation does).
--
--  Schema is intentionally tight (no raw_response, no abuse score)
--  because from here — that's ip_reputation_cache's job. This table
--  is geo-only, so it stays small (~30 bytes/row) and indexes well.

CREATE TABLE IF NOT EXISTS geoip_country_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address      INET NOT NULL,
  provider        VARCHAR(20) NOT NULL              -- 'maxmind' | 'geoip_lite' | 'manual'
                  CHECK (provider IN ('maxmind','geoip_lite','manual')),
  country_code    VARCHAR(2) NOT NULL,               -- ISO 3166-1 alpha-2, uppercase
  is_anonymous    BOOLEAN NOT NULL DEFAULT false,   -- Tor / VPN / proxy / hosting
  is_hosting      BOOLEAN NOT NULL DEFAULT false,   -- datacenter / cloud provider
  source_label    VARCHAR(40),                      -- MaxMind connection type label (e.g. 'Corporate', 'Mobile')
  confidence      REAL NOT NULL DEFAULT 1.0,         -- 0..1, 1.0 = certain, lower = less reliable
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- Hot path: lookup-by-IP + freshness check, scoped per provider
-- (we never want geoip_lite to shadow a fresh maxmind result).
CREATE INDEX IF NOT EXISTS idx_geoip_cache_ip_provider
  ON geoip_country_cache(ip_address, provider, expires_at DESC);

-- Reports / audit page.
CREATE INDEX IF NOT EXISTS idx_geoip_cache_checked_at
  ON geoip_country_cache(checked_at DESC);

-- High-risk country index for the admin reports panel.
CREATE INDEX IF NOT EXISTS idx_geoip_cache_high_risk
  ON geoip_country_cache(checked_at DESC) WHERE is_anonymous OR is_hosting;

-- Default admin_settings for the MaxMind lookup. All keys default to
-- safe values; admin can change via /admin/settings.
--
--   geoip_provider: 'maxmind' | 'geoip_lite' | 'noop'
--     maxmind      = use the .mmdb file (best accuracy, needs MaxMind
--                    download; geoip_mmdb_path below)
--     geoip_lite   = always-on fallback using the npm package
--     noop         = disable geo entirely (returns noop records)
--
--   geoip_mmdb_path: filesystem path to GeoLite2-Country.mmdb. MaxMind
--     publishes the file under a free GeoLite2 license (signup required).
--     Repo .gitignore excludes the geoip/ dir so the .mmdb is never
--     committed.
--
--   geoip_mismatch_weight: weight assigned to the IP/KYC country
--     mismatch signal in ai-risk-engine. 0 = disabled, 18 = default
--     (matches the high-risk-country weight in SIGNAL_WEIGHTS).
--
--   geoip_high_risk_countries: comma-separated ISO 3166-1 alpha-2 codes
--     that should be flagged as high-risk. Empty = use the
--     DEFAULT_HIGH_RISK_COUNTRIES set in services/maxmind.ts.
--
--   geoip_cache_ttl_days: how long a cached lookup is valid. Country
--     assignments change on the order of months; 7 days is a safe
--     refresh interval.
INSERT INTO admin_settings (key, value, description) VALUES
  ('geoip_provider',              'maxmind',    'GeoIP provider: maxmind (.mmdb), geoip_lite (always-on fallback), or noop (disabled).'),
  ('geoip_mmdb_path',             '/app/geoip/GeoLite2-Country.mmdb', 'Filesystem path to the MaxMind GeoLite2-Country .mmdb file.'),
  ('geoip_mismatch_weight',       '18',          'Risk-engine weight for the IP/KYC country mismatch signal. 0 = disabled, 18 = default.'),
  ('geoip_high_risk_countries',   '',            'Comma-separated ISO 3166-1 alpha-2 codes to flag as high-risk. Empty = use built-in defaults (P3-4a list).'),
  ('geoip_cache_ttl_days',        '7',           'How long a cached country lookup stays valid before refresh. Default 7 days.')
ON CONFLICT (key) DO NOTHING;

-- Audit row so this migration is visible in audit_log.
INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.geoip_maxmind', 'info',
        jsonb_build_object('migration','039_geoip_maxmind_cache',
                          'tables_created', ARRAY['geoip_country_cache'],
                          'admin_settings_seeded', ARRAY['geoip_provider','geoip_mmdb_path','geoip_mismatch_weight','geoip_high_risk_countries','geoip_cache_ttl_days']));

