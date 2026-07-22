/**
 * Phase 1.5 — Fraud Alert Service (L19 + alert stack)
 *
 * Single entry point for emitting fraud alerts. Fans out to:
 *   1. fraud_alerts table (always — audit-of-audits)
 *   2. Slack webhook (if alert_slack_webhook_url is configured)
 *   3. Discord webhook (if alert_discord_webhook_url is configured)
 *   4. Email (if alert_email_fraud_team is configured; uses queueEmail)
 *
 * Webhook URLs are read from admin_settings (live-updatable without
 * redeploy). Empty/unset URLs just skip that channel silently.
 *
 * Severity-gated:
 *   critical → all enabled channels, immediately
 *   high     → all enabled channels, immediately
 *   medium   → DB + email only (Slack/Discord too noisy otherwise)
 *   info     → DB only
 *
 * All channel sends are fail-safe: a Slack outage must never break
 * a signup or withdrawal. Errors are recorded in delivery[] for
 * admin diagnostics.
 */

import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { getAdminSetting } from './admin-settings.service';
import { queueEmail } from './notification.service';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface FraudAlertInput {
  alertType: string;                       // e.g. 'CRIT_001' or 'HIGH_002'
  severity: AlertSeverity;
  title: string;
  body: string;
  affectedUserIds?: string[];
  riskScore?: number;
  signals?: string[];
  recommendedAction?: string;
  adminLink?: string;
}

export interface FraudAlertResult {
  alertId: string;
  channelsSent: string[];
  delivery: Record<string, { ok: boolean; httpCode?: number; error?: string }>;
}

// ── Webhook delivery (best-effort, fail-silent) ────────────────

interface WebhookResult {
  ok: boolean;
  httpCode?: number;
  error?: string;
}

async function postJson(url: string, payload: unknown, timeoutMs = 5000): Promise<WebhookResult> {
  if (!url) return { ok: false, error: 'no_url' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return { ok: res.ok, httpCode: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

function formatSlack(input: FraudAlertInput, appBaseUrl: string): unknown {
  const colorBySeverity: Record<AlertSeverity, string> = {
    critical: '#dc3545',
    high: '#fd7e14',
    medium: '#ffc107',
    info: '#0d6efd',
  };
  const emoji = input.severity === 'critical' ? ':rotating_light:'
    : input.severity === 'high' ? ':warning:'
    : input.severity === 'medium' ? ':eyes:'
    : ':information_source:';
  const attachment: Record<string, unknown> = {
    color: colorBySeverity[input.severity],
    title: input.title,
    text: input.body,
    fields: [
      { title: 'Severity', value: input.severity.toUpperCase(), short: true },
      { title: 'Type', value: input.alertType, short: true },
    ],
    footer: `CryptoFlip anti-fraud · ${new Date().toISOString()}`,
  };
  if (input.riskScore !== undefined) {
    (attachment.fields as Array<{ title: string; value: string; short?: boolean }>).push(
      { title: 'Risk Score', value: `${input.riskScore}/100`, short: true },
    );
  }
  if (input.signals && input.signals.length > 0) {
    (attachment.fields as Array<{ title: string; value: string; short?: boolean }>).push(
      { title: 'Signals', value: input.signals.join(', '), short: false },
    );
  }
  if (input.adminLink) {
    attachment.title_link = `${appBaseUrl}${input.adminLink}`;
  }
  return {
    text: `${emoji} *${input.alertType}* — ${input.title}`,
    attachments: [attachment],
  };
}

function formatDiscord(input: FraudAlertInput, appBaseUrl: string): unknown {
  const colorBySeverity: Record<AlertSeverity, number> = {
    critical: 0xdc3545,
    high: 0xfd7e14,
    medium: 0xffc107,
    info: 0x0d6efd,
  };
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Severity', value: input.severity.toUpperCase(), inline: true },
    { name: 'Type', value: input.alertType, inline: true },
  ];
  if (input.riskScore !== undefined) {
    fields.push({ name: 'Risk Score', value: `${input.riskScore}/100`, inline: true });
  }
  if (input.signals && input.signals.length > 0) {
    fields.push({ name: 'Signals', value: input.signals.join(', '), inline: false });
  }
  const embed: Record<string, unknown> = {
    title: input.title,
    description: input.body,
    color: colorBySeverity[input.severity],
    fields,
    footer: { text: `CryptoFlip anti-fraud · ${new Date().toISOString()}` },
  };
  if (input.adminLink) embed.url = `${appBaseUrl}${input.adminLink}`;
  return { embeds: [embed] };
}

// ── Main entry point ───────────────────────────────────────────

export async function sendFraudAlert(input: FraudAlertInput): Promise<FraudAlertResult> {
  const alertId = uuidv4();
  const channelsSent: string[] = ['db'];
  const delivery: FraudAlertResult['delivery'] = {};

  // 1. ALWAYS write to fraud_alerts table.
  try {
    await query(
      `INSERT INTO fraud_alerts
         (id, alert_type, severity, title, body, affected_user_ids,
          risk_score, signals, recommended_action, admin_link, channels_sent, delivery)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid[], $7::int, $8::text[],
               $9, $10, $11::text[], $12::jsonb)`,
      [
        alertId, input.alertType, input.severity, input.title, input.body,
        input.affectedUserIds ?? [],
        input.riskScore ?? null,
        input.signals ?? [],
        input.recommendedAction ?? null,
        input.adminLink ?? null,
        channelsSent,                       // updated below after other channels
        JSON.stringify({ db: { ok: true } }),
      ],
    );
    delivery.db = { ok: true };
  } catch (e) {
    delivery.db = { ok: false, error: (e as Error).message };
  }

  // Only escalate to webhooks/email for medium+ severity.
  if (input.severity === 'info') {
    await query(
      `UPDATE fraud_alerts SET channels_sent = $1::text[], delivery = $2::jsonb WHERE id = $3::uuid`,
      [channelsSent, JSON.stringify(delivery), alertId],
    );
    return { alertId, channelsSent, delivery };
  }

  // 2. Slack
  const slackUrl = (await getAdminSetting('alert_slack_webhook_url', '')) ?? '';
  if (slackUrl) {
    const appBaseUrl = (await getAdminSetting('app_base_url', 'https://crazycoin.duckdns.org')) ?? 'https://crazycoin.duckdns.org';
    const r = await postJson(slackUrl, formatSlack(input, appBaseUrl));
    delivery.slack = r;
    if (r.ok) channelsSent.push('slack');
  }

  // 3. Discord
  const discordUrl = (await getAdminSetting('alert_discord_webhook_url', '')) ?? '';
  if (discordUrl) {
    const appBaseUrl = (await getAdminSetting('app_base_url', 'https://crazycoin.duckdns.org')) ?? 'https://crazycoin.duckdns.org';
    const r = await postJson(discordUrl, formatDiscord(input, appBaseUrl));
    delivery.discord = r;
    if (r.ok) channelsSent.push('discord');
  }

  // 4. Email
  const emailTeam = (await getAdminSetting('alert_email_fraud_team', '')) ?? '';
  if (emailTeam && (input.severity === 'critical' || input.severity === 'high')) {
    const recipients = emailTeam.split(',').map((s) => s.trim()).filter(Boolean);
    const eventType = `fraud_alert_${input.severity}`;
    const context = {
      title: input.title,
      body: input.body,
      severity: input.severity,
      type: input.alertType,
      risk_score: input.riskScore ?? null,
      signals: (input.signals ?? []).join(', '),
      at: new Date().toISOString(),
    };
    try {
      const results = await Promise.allSettled(
        recipients.map((recipient) => queueEmail({
          recipient,
          recipient_kind: 'admin',
          event_type: eventType,
          context,
          subject_override: `[${input.severity.toUpperCase()}] ${input.title}`,
        })),
      );
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      delivery.email = {
        ok: okCount > 0,
        error: okCount < recipients.length ? `${recipients.length - okCount} failed` : undefined,
      };
      if (okCount > 0) channelsSent.push('email');
    } catch (e) {
      delivery.email = { ok: false, error: (e as Error).message };
    }
  }

  // Update channels_sent + delivery JSON on the persisted row.
  await query(
    `UPDATE fraud_alerts SET channels_sent = $1::text[], delivery = $2::jsonb WHERE id = $3::uuid`,
    [channelsSent, JSON.stringify(delivery), alertId],
  );

  return { alertId, channelsSent, delivery };
}

// ── Convenience wrappers (semantic alert types from the v2.0 spec) ─

export async function alertCriticalRiskScore(userId: string, score: number, signals: string[]) {
  return sendFraudAlert({
    alertType: 'CRIT_001',
    severity: 'critical',
    title: `User ${userId.slice(0, 8)} reached CRITICAL risk score (${score}/100)`,
    body: `A user has crossed the 85-point threshold. Immediate admin review recommended.`,
    affectedUserIds: [userId],
    riskScore: score,
    signals,
    recommendedAction: 'Open the user risk profile and review signal breakdown. Consider suspending.',
    adminLink: `/sysop-fraud/user/${userId}`,
  });
}

export async function alertKycDuplicate(userId: string, otherUserId: string, column: 'national_id_hash' | 'passport_hash') {
  return sendFraudAlert({
    alertType: 'CRIT_002',
    severity: 'critical',
    title: 'Duplicate KYC identity detected',
    body: `User ${userId.slice(0, 8)} submitted KYC that matches already-approved account ${otherUserId.slice(0, 8)} on ${column}.`,
    affectedUserIds: [userId, otherUserId],
    signals: ['kyc_duplicate', `matched_${column}`],
    recommendedAction: 'Suspend both accounts pending manual identity verification.',
    adminLink: `/sysop-kyc/duplicates`,
  });
}

export async function alertFraudRing(clusterLabel: string, memberIds: string[]) {
  return sendFraudAlert({
    alertType: 'CRIT_003',
    severity: 'critical',
    title: `Fraud ring detected (${memberIds.length} accounts)`,
    body: `Graph detector found a connected cluster: ${clusterLabel}. Members: ${memberIds.map((id) => id.slice(0, 8)).join(', ')}`,
    affectedUserIds: memberIds,
    signals: ['multi_account_ring'],
    recommendedAction: 'Suspend all member accounts; review device/IP/email overlaps.',
    adminLink: `/sysop-fraud/clusters`,
  });
}

export async function alertSelfReferral(refereeId: string, referrerId: string, signals: string[]) {
  return sendFraudAlert({
    alertType: 'HIGH_004',
    severity: 'high',
    title: 'Affiliate self-referral detected',
    body: `Referee ${refereeId.slice(0, 8)} shares ${signals.join(' + ')} with referrer ${referrerId.slice(0, 8)}.`,
    affectedUserIds: [refereeId, referrerId],
    signals: ['self_referral', ...signals],
    recommendedAction: 'Review commission eligibility; suspend repeat offenders.',
    adminLink: `/sysop-fraud/self-referral`,
  });
}

export async function alertDeviceCluster(userId: string, deviceFpHash: string, accountCount: number) {
  return sendFraudAlert({
    alertType: 'HIGH_005',
    severity: 'high',
    title: `Device linked to ${accountCount} accounts`,
    body: `User ${userId.slice(0, 8)} registered on a device already linked to ${accountCount - 1} other accounts (hash ${deviceFpHash.slice(0, 12)}…).`,
    affectedUserIds: [userId],
    signals: ['device_shared', `device_${accountCount}_accounts`],
    recommendedAction: 'Review the device cluster; consider suspending bonus claims.',
    adminLink: `/sysop-fraud/devices`,
  });
}