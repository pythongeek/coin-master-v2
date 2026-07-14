-- =============================================================
--  Migration 034: Account relationship graph (Phase 1.3)
-- =============================================================
--  Two tables for fraud ring detection via graph algorithms:
--
--    account_resource_links: directed EDGE table
--      Each row says "account_a and account_b share resource X".
--      resource_type ∈ {device, ip, kyc, phone, wallet, email_domain_ip, referral}
--      resource_hash is the normalized hash identifying the shared resource.
--      strength ∈ (0,1] is the edge weight — KYC match = 1.0,
--      device match = 0.8, IP match = 0.4 (per v2.0 spec).
--
--    fraud_clusters: connected components
--      Detected fraud rings. One row per ring with the member list +
--      detection signals + admin review status.
--
--  The graph service (graph-fraud.ts) walks the edges to find
--  connected components and writes clusters automatically.

CREATE TABLE IF NOT EXISTS account_resource_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_a     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_b     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(30) NOT NULL
                CHECK (resource_type IN ('device','ip','kyc','phone','wallet','email_domain_ip','referral')),
  resource_hash VARCHAR(128) NOT NULL,
  strength      DECIMAL(3,2) NOT NULL
                CHECK (strength > 0 AND strength <= 1),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cluster_id    UUID,
  review_status VARCHAR(20) DEFAULT 'pending'
                CHECK (review_status IN ('pending','confirmed','dismissed')),
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  review_notes  TEXT,
  UNIQUE(account_a, account_b, resource_type, resource_hash)
);

-- Self-edge guard: an account can't link to itself.
ALTER TABLE account_resource_links
  ADD CONSTRAINT chk_no_self_link CHECK (account_a <> account_b);

-- Lookup edges from either side of the pair.
CREATE INDEX IF NOT EXISTS idx_arl_account_a ON account_resource_links(account_a);
CREATE INDEX IF NOT EXISTS idx_arl_account_b ON account_resource_links(account_b);
-- Resource lookup: "which accounts share hash X?"
CREATE INDEX IF NOT EXISTS idx_arl_resource ON account_resource_links(resource_type, resource_hash);
CREATE INDEX IF NOT EXISTS idx_arl_cluster ON account_resource_links(cluster_id) WHERE cluster_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fraud_clusters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_label     VARCHAR(80) NOT NULL,
  member_user_ids   UUID[] NOT NULL DEFAULT '{}',
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_types      TEXT[] NOT NULL DEFAULT '{}',
  total_strength    DECIMAL(6,2) NOT NULL DEFAULT 0,
  member_count      INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','dismissed')),
  admin_notes       TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fraud_clusters_status ON fraud_clusters(status);
CREATE INDEX IF NOT EXISTS idx_fraud_clusters_members_gin ON fraud_clusters USING GIN(member_user_ids);

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.account_resource_links', 'info',
        jsonb_build_object('migration','034_account_resource_links',
                          'summary','Account relationship graph + fraud_clusters table'));