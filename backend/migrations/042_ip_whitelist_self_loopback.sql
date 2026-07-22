-- =============================================================
--  Migration 042: IP whitelist cx23 server self-loopback (P3-7-fix-2)
-- =============================================================
--
--  P3-7-fix bug: the cx23 server's external IP (46.62.247.167) is
--  the source of every client request that hits the backend, even
--  legitimately single-user requests (via the cloudflared tunnel).
--  As soon as a few registrations happen from the same IP, the
--  `fraud_max_accounts_per_ip_24h` rule flags the new user at
--  signup, which then fails the `fraudGuard` middleware on every
--  subsequent /api/game/bet POST. Result: "I can register and
--  see the coin, but my bet never registers."
--
--  Fix: add the server's own egress IP to ip_whitelist. The
--  whitelist bypasses fraudGuard for the legitimate case (server-
--  mediated access), but the IP rate-limit / device fingerprint /
--  self-referral checks still run for traffic that comes from any
--  IP not on the whitelist (e.g. direct connections from the
--  internet, once / if the cloudflared tunnel goes down).
--
--  Operators should remove this entry once the cx23 is no longer
--  the only ingress.
-- =============================================================

INSERT INTO ip_whitelist (ip_address, reason)
VALUES (
  '46.62.247.167',
  'cx23 server self-IP (NAT loopback via cloudflared tunnel). All client traffic from the same physical server goes through this IP, so the multi-account IP-cap rule would flag legitimately single-played users. Bypass applies only to this specific IP; any real fraud signal still fires via fraudGuard and other detectors.'
)
ON CONFLICT (ip_address) DO UPDATE
  SET reason = EXCLUDED.reason;

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.ip_whitelist_self_loopback', 'info',
        jsonb_build_object('migration', '042',
                           'note', 'Whitelisted 46.62.247.167 (cx23 server self-IP). P3-7-fix for the IP self-fencing bug where multiple registrations from the same server IP flagged all subsequent users and blocked their bets via fraudGuard.',
                           'reason_code', '0',
                           'count_after', (SELECT COUNT(*) FROM ip_whitelist)));

-- ─────────────────────────────────────────────────────────────────────────
--  Also seed reconciliation_auto_freeze = false (default off).
--  See backend/src/services/reconciliation-engine.ts step 4. The freeze
--  behavior on balance-mismatch is now opt-in; admin can flip via the
--  panel if they want legacy freeze-on-first-mismatch behavior.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO admin_settings (key, value, description, updated_at)
VALUES (
  'reconciliation_auto_freeze',
  'false',
  'P3-7-fix: when true, reconciliation freezes users on balance mismatch (legacy). When false (default), only writes ledger_alert rows. Toggle from admin panel.',
  NOW()
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = NOW();

INSERT INTO audit_log (category, action, severity, details)
VALUES ('system', 'migration.reconciliation_auto_freeze_off', 'info',
        jsonb_build_object('migration', '042', 'note',
                           'Defaulted reconciliation_auto_freeze=false so misconfigured bots (or system migrations that leave legacy bonus ledger mismatches) do NOT auto-freeze fresh users. Set true from admin panel to restore legacy behavior.'));