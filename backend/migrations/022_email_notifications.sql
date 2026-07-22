-- =============================================================
--  EMAIL NOTIFICATIONS - queue + admin config + templates
-- =============================================================
--
--  email_queue          async send queue (drained by background worker)
--  admin_email_config   list of admin recipient addresses + per-event toggles
--  admin_email_templates  editable HTML + text templates per event
--
--  All async: SMTP latency must never block HTTP requests.
--  Per-user rate limit on email_queue (recipient + event_type dedupe).

CREATE TABLE IF NOT EXISTS email_queue (
  id              BIGSERIAL PRIMARY KEY,
  recipient       VARCHAR(255) NOT NULL,             -- email address
  recipient_kind  VARCHAR(20)  NOT NULL DEFAULT 'admin',  -- 'admin' | 'user'
  user_id         UUID,                              -- nullable: link to user if recipient_kind='user'
  event_type      VARCHAR(64)  NOT NULL,             -- 'deposit.credited' | 'withdrawal.critical' | etc
  subject         VARCHAR(500) NOT NULL,
  body_html       TEXT         NOT NULL,
  body_text       TEXT         NOT NULL,
  context_json    JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- for retry/debug
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',     -- 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  attempts        INT          NOT NULL DEFAULT 0,
  max_attempts    INT          NOT NULL DEFAULT 4,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending
  ON email_queue(next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_email_queue_event
  ON email_queue(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_queue_recipient
  ON email_queue(recipient, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_queue_user
  ON email_queue(user_id, event_type, created_at DESC)
  WHERE user_id IS NOT NULL;

-- =============================================================
--  Admin email config - per-recipient toggles for each event
-- =============================================================

CREATE TABLE IF NOT EXISTS admin_email_config (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  role         VARCHAR(50)  NOT NULL DEFAULT 'admin',   -- 'super_admin' | 'finance' | 'fraud_ops' | 'admin'
  is_enabled   BOOLEAN      NOT NULL DEFAULT true,
  notify_deposit_credited   BOOLEAN NOT NULL DEFAULT false,  -- usually false for admins (customer email)
  notify_withdrawal_critical BOOLEAN NOT NULL DEFAULT true,  -- critical-risk admin alert
  notify_withdrawal_held    BOOLEAN NOT NULL DEFAULT true,   -- withdrawal pending review
  notify_withdrawal_rejected BOOLEAN NOT NULL DEFAULT false,
  notify_withdrawal_approved BOOLEAN NOT NULL DEFAULT false,
  notify_user_kyc_approved  BOOLEAN NOT NULL DEFAULT false,
  notify_system_error       BOOLEAN NOT NULL DEFAULT true,   -- critical system errors
  notes       TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_email_config_enabled
  ON admin_email_config(is_enabled)
  WHERE is_enabled = true;

-- =============================================================
--  Email templates - HTML + text per event type
-- =============================================================
--  Stored as separate table to allow editing without code redeploy.
--  Template variables use {{var_name}} syntax, replaced at send time.

CREATE TABLE IF NOT EXISTS admin_email_templates (
  id           BIGSERIAL PRIMARY KEY,
  event_type   VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  subject_template VARCHAR(500) NOT NULL,
  body_html_template TEXT NOT NULL,
  body_text_template TEXT NOT NULL,
  is_enabled   BOOLEAN NOT NULL DEFAULT true,
  available_variables JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of {{vars}} available
  updated_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
--  Seed: default templates for the events we use
-- =============================================================

INSERT INTO admin_email_templates (event_type, display_name, subject_template, body_html_template, body_text_template, available_variables)
VALUES
  ('deposit.credited', 'Deposit credited receipt',
   '✅ {{amount_usdt}} USDT credited to your account ({{chain}})',
   '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#22c55e;margin:0 0 16px">Deposit confirmed</h1><p>Hi {{username}},</p><p>Your deposit of <strong style="color:#f59e0b">{{amount_usdt}} USDT</strong> on <strong>{{chain}}</strong> has been credited to your account.</p><table style="width:100%;margin:24px 0;border-collapse:collapse"><tr><td style="padding:8px;color:#888">Order ID</td><td style="padding:8px;font-family:monospace">{{order_id}}</td></tr><tr><td style="padding:8px;color:#888">Network</td><td style="padding:8px">{{chain}} ({{chain_full}})</td></tr><tr><td style="padding:8px;color:#888">USDT received</td><td style="padding:8px;font-family:monospace">{{amount_usdt}}</td></tr><tr><td style="padding:8px;color:#888">USD equivalent</td><td style="padding:8px;font-family:monospace">${{amount_usd}}</td></tr><tr><td style="padding:8px;color:#888">BDT equivalent</td><td style="padding:8px;font-family:monospace">৳{{amount_bdt}}</td></tr><tr><td style="padding:8px;color:#888">TX hash</td><td style="padding:8px;font-family:monospace;font-size:12px;word-break:break-all">{{tx_hash}}</td></tr><tr><td style="padding:8px;color:#888">Confirmed at</td><td style="padding:8px">{{confirmed_at}}</td></tr></table><p style="color:#888;font-size:12px">This is an automated receipt. Keep your TX hash for support inquiries.</p></div>',
   'Deposit confirmed

Hi {{username}},

Your deposit of {{amount_usdt}} USDT on {{chain}} has been credited.

Order ID:  {{order_id}}
Network:    {{chain}} ({{chain_full}})
USDT:       {{amount_usdt}}
USD:        ${{amount_usd}}
BDT:        ৳{{amount_bdt}}
TX hash:    {{tx_hash}}
Confirmed:  {{confirmed_at}}

This is an automated receipt.',
   '["username","order_id","chain","chain_full","amount_usdt","amount_usd","amount_bdt","tx_hash","confirmed_at"]'::jsonb),
  ('withdrawal.critical', 'Critical-risk withdrawal alert',
   '🚨 CRITICAL: Withdrawal request scored {{risk_score}}/100 - {{user_email}}',
   '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#ef4444;margin:0 0 16px">🚨 Critical withdrawal</h1><p>A withdrawal request scored <strong style="color:#ef4444">{{risk_score}}/100</strong> (critical). Manual review strongly recommended.</p><table style="width:100%;margin:24px 0;border-collapse:collapse"><tr><td style="padding:8px;color:#888">Withdrawal ID</td><td style="padding:8px;font-family:monospace">{{withdrawal_id}}</td></tr><tr><td style="padding:8px;color:#888">User</td><td style="padding:8px">{{username}} ({{user_email}})</td></tr><tr><td style="padding:8px;color:#888">Amount</td><td style="padding:8px;font-family:monospace">{{amount_usdt}} USDT (${{amount_usd}} USD, ৳{{amount_bdt}} BDT)</td></tr><tr><td style="padding:8px;color:#888">IP address</td><td style="padding:8px;font-family:monospace">{{ip_address}}</td></tr><tr><td style="padding:8px;color:#888">Risk level</td><td style="padding:8px"><span style="background:#ef4444;color:white;padding:4px 8px;border-radius:4px">{{risk_level}} · {{risk_score}}/100</span></td></tr><tr><td style="padding:8px;color:#888">Suggestion</td><td style="padding:8px">{{risk_suggestion}}</td></tr><tr><td style="padding:8px;color:#888">Created at</td><td style="padding:8px">{{created_at}}</td></tr></table><p style="margin:16px 0;color:#fbbf24"><strong>Top risk signals:</strong></p><ul style="color:#fafafa">{{risk_reasons}}</ul><p style="margin:24px 0"><a href="{{admin_url}}" style="display:inline-block;background:#ef4444;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Review in admin panel →</a></p></div>',
   '🚨 CRITICAL WITHDRAWAL

Withdrawal {{withdrawal_id}}
User:       {{username}} ({{user_email}})
Amount:     {{amount_usdt}} USDT (${{amount_usd}} USD, ৳{{amount_bdt}} BDT)
IP:         {{ip_address}}
Risk:       {{risk_level}} · {{risk_score}}/100
Suggestion: {{risk_suggestion}}
Created:    {{created_at}}

Top signals:
{{risk_reasons}}

Review: {{admin_url}}',
   '["withdrawal_id","username","user_email","amount_usdt","amount_usd","amount_bdt","ip_address","risk_score","risk_level","risk_suggestion","risk_reasons","created_at","admin_url"]'::jsonb),
  ('withdrawal.held', 'Withdrawal pending review',
   '⚠️ Withdrawal held for review: {{amount_usdt}} USDT - {{username}}',
   '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#f59e0b;margin:0 0 16px">⚠️ Withdrawal pending</h1><p>A withdrawal of <strong>{{amount_usdt}} USDT</strong> from <strong>{{username}}</strong> has been held for manual review.</p><table style="width:100%;margin:24px 0;border-collapse:collapse"><tr><td style="padding:8px;color:#888">Withdrawal ID</td><td style="padding:8px;font-family:monospace">{{withdrawal_id}}</td></tr><tr><td style="padding:8px;color:#888">Amount</td><td style="padding:8px">{{amount_usdt}} USDT (${{amount_usd}})</td></tr><tr><td style="padding:8px;color:#888">Risk score</td><td style="padding:8px">{{risk_level}} · {{risk_score}}/100</td></tr></table><p><a href="{{admin_url}}" style="display:inline-block;background:#f59e0b;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">Review →</a></p></div>',
   'Withdrawal held for review

ID:     {{withdrawal_id}}
User:   {{username}}
Amount: {{amount_usdt}} USDT (${{amount_usd}})
Risk:   {{risk_level}} · {{risk_score}}/100

Review: {{admin_url}}',
   '["withdrawal_id","username","amount_usdt","amount_usd","risk_score","risk_level","admin_url"]'::jsonb),
  ('withdrawal.approved', 'Withdrawal approved',
   '✅ Your withdrawal of {{amount_usdt}} USDT was approved',
   '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#22c55e;margin:0 0 16px">✅ Withdrawal approved</h1><p>Your withdrawal of <strong>{{amount_usdt}} USDT</strong> has been approved and is being processed.</p><p style="color:#888;font-size:12px">Withdrawal ID: <span style="font-family:monospace">{{withdrawal_id}}</span></p></div>',
   'Withdrawal approved

Amount: {{amount_usdt}} USDT
ID:     {{withdrawal_id}}',
   '["amount_usdt","withdrawal_id"]'::jsonb),
  ('withdrawal.rejected', 'Withdrawal rejected',
   '❌ Your withdrawal of {{amount_usdt}} USDT was rejected',
   '<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#0a0a0a;color:#fafafa;border-radius:12px"><h1 style="color:#ef4444;margin:0 0 16px">Withdrawal rejected</h1><p>Your withdrawal of <strong>{{amount_usdt}} USDT</strong> was rejected. The amount has been refunded to your balance.</p><p style="color:#888">Reason: {{reason}}</p></div>',
   'Withdrawal rejected

Amount: {{amount_usdt}} USDT
Reason: {{reason}}',
   '["amount_usdt","reason"]'::jsonb)
ON CONFLICT (event_type) DO NOTHING;
