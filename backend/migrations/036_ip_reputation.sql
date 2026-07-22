-- =============================================================
--  Migration 036: IP reputation cache + admin blocklist (Phase 2.3)
-- =============================================================
--  Two tables:
--
--    ip_reputation_cache: persistent log of every IP lookup the
--      service performs. Keeps the cache result + audit trail for
--      the admin "Reports" view. Indexed by IP for fast lookups.
--      Live cache layer is Redis (1-day TTL by default) so hot
--      IPs don't re-query AbuseIPDB on every signup.
--
--    ip_blocklist: admin-managed allow/deny list. Entries take
--      precedence over the AbuseIPDB result (a manually-flagged
--      IP stays flagged even if AbuseIPDB hasn't seen it yet).
--      type='deny' adds the IP to the fraudster set; type='allow'
--      marks it as trusted (overrides denylist from the same admin).

CREATE TABLE IF NOT EXISTS ip_reputation_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address      INET NOT NULL,
  provider        VARCHAR(40) NOT NULL,            -- 'abuseipdb' | 'tor' | 'manual' | 'mock'
  abuse_score     INTEGER,                         -- 0-100, higher = more abusive
  is_tor          BOOLEAN NOT NULL DEFAULT false,
  is_datacenter   BOOLEAN NOT NULL DEFAULT false,
  is_proxy        BOOLEAN NOT NULL DEFAULT false,
  is_known_fraud  BOOLEAN NOT NULL DEFAULT false,
  country_code    VARCHAR(2),
  raw_response    JSONB,                           -- full provider response
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 day')
);

-- Hot path: lookup-by-IP + freshness check.
CREATE INDEX IF NOT EXISTS idx_ip_rep_cache_ip
  ON ip_reputation_cache(ip_address, expires_at DESC);
-- Reports page: time-ordered scan.
CREATE INDEX IF NOT EXISTS idx_ip_rep_cache_checked_at
  ON ip_reputation_cache(checked_at DESC);
-- Filter for known-bad IPs in admin reports.
CREATE INDEX IF NOT EXISTS idx_ip_rep_cache_fraud
  ON ip_reputation_cache(checked_at DESC) WHERE is_known_fraud OR is_tor OR is_datacenter;

CREATE TABLE IF NOT EXISTS ip_blocklist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address    INET NOT NULL,
  list_type     VARCHAR(10) NOT NULL DEFAULT 'deny'
                CHECK (list_type IN ('deny','allow')),
  reason        TEXT NOT NULL,
  source        VARCHAR(40) NOT NULL DEFAULT 'admin'
                CHECK (source IN ('admin','auto','abuseipdb')),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,                       -- NULL = permanent
  UNIQUE(ip_address, list_type)
);

CREATE INDEX IF NOT EXISTS idx_ip_blocklist_ip ON ip_blocklist(ip_address);

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.ip_reputation', 'info',
        jsonb_build_object('migration','036_ip_reputation',
                          'summary','ip_reputation_cache + ip_blocklist'));