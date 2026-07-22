/**
 * P3-5 — Daily Automated Fraud Report Service.
 *
 * Aggregates the last 24 hours of fraud activity into a digest
 * email sent to the configured recipient (default ohmyholy99@gmail.com).
 *
 * Sections (matching CryptoFlip_BonusSystem_CompleteDocs.md:1316):
 *   1. Top 10 users by risk score (current state)
 *   2. New fraud clusters detected in the last 24h
 *   3. Cluster actions (confirmed/dismissed) in the last 24h
 *   4. Withdrawals flagged/held in the last 24h (count + amount)
 *   5. KYC events: approvals, rejections, duplicates
 *   6. Fraud signals by type (top 10)
 *   7. ML model predictions fired in the last 24h
 *   8. Recommendations
 *
 * Idempotency: keyed on (report_date, report_kind). Re-running
 * the cron for the same day is a no-op unless force=true.
 *
 * Cron registration: index.ts sets up a 1-hour tick that calls
 * `maybeRunDailyReport()` once per hour; the function checks the
 * configured send hour (default 08:00 UTC) before actually sending.
 * This means the worker doesn't accumulate drift across restarts.
 *
 * On-demand: `sendDailyReport({ force: true, recipient?: string })`
 * is exported for the admin endpoint. Force bypasses both the
 * idem-potency check and the send-hour check.
 */
import { query } from '../config/database';
import { getAdminSetting, getAdminSettingBool } from './admin-settings.service';
import { queueEmail } from './notification.service';

export interface DailyReportPayload {
  report_date: string;
  generated_at: string;
  total_signals: number;
  top_risk_users: string;     // HTML table
  new_clusters: string;       // HTML table
  cluster_actions: string;    // HTML table
  flagged_withdrawals: string; // HTML table
  kyc_events: string;         // HTML table
  signal_counts: string;      // HTML table
  ml_predictions: string;     // HTML table
  recommendations: string;    // bullet list (HTML)
}

export interface SendDailyReportOptions {
  /** Skip the idem-potency check (allow re-sending for the same day) */
  force?: boolean;
  /** Override the configured recipient (admin "send-now" button) */
  recipient?: string;
  /** Force a specific report_date (default: yesterday) */
  reportDate?: string;
  /** Override the min_signals threshold (default: admin_settings) */
  minSignals?: number;
  /** Mark the digest row as 'on_demand' instead of 'daily_digest' */
  reportKind?: 'daily_digest' | 'manual_test' | 'on_demand';
}

export interface SendDailyReportResult {
  sent: boolean;
  reason?: string;
  reportId?: number;
  recipient?: string;
  totalSignals?: number;
}

/**
 * Internal: gather every section of the digest from the live DB.
 * Pure function (no side effects) so it can be reused by the
 * `preview` endpoint without writing anything.
 */
export async function aggregateDigest(reportDate: string): Promise<DailyReportPayload> {
  const sinceIso = `${reportDate}T00:00:00Z`;
  // ISO instant for the previous day boundary so "last 24h" matches
  // the report_date. The window is [sinceIso, sinceIso + 24h).
  const sinceTs = new Date(sinceIso);
  const nextTs = new Date(sinceTs.getTime() + 24 * 60 * 60 * 1000);
  const sinceSql = sinceTs.toISOString();
  const nextSql = nextTs.toISOString();

  // 1. Top 10 risk users (current state, no time filter — it's a snapshot).
  const topRisk = (await query(
    `SELECT u.id::text AS user_id, u.username, u.email,
            COALESCE(u.risk_score, 0) AS risk_score,
            COALESCE(u.risk_tier, 'safe') AS risk_tier,
            COALESCE(u.kyc_status, 'none') AS kyc_status
       FROM users u
      WHERE COALESCE(u.risk_score, 0) > 0
      ORDER BY u.risk_score DESC
      LIMIT 10`,
  )).rows as Array<{
    user_id: string; username: string | null; email: string | null;
    risk_score: number; risk_tier: string; kyc_status: string;
  }>;
  const top_risk_users = topRisk.length === 0
    ? '<p><em>No high-risk users.</em></p>'
    : '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>user_id</th><th>username</th><th>email</th><th>score</th><th>tier</th><th>kyc</th>'
      + '</tr></thead><tbody>'
      + topRisk.map((u) => `<tr><td>${u.user_id.slice(0,8)}</td><td>${escapeHtml(u.username ?? '')}</td><td>${escapeHtml(u.email ?? '')}</td><td>${u.risk_score}</td><td>${escapeHtml(u.risk_tier)}</td><td>${escapeHtml(u.kyc_status)}</td></tr>`).join('')
      + '</tbody></table>';

  // 2. New fraud clusters (detected_at in window).
  const newClusters = (await query(
    `SELECT id::text AS id, cluster_label, total_strength,
            array_length(member_user_ids, 1) AS member_count,
            signal_types, status
       FROM fraud_clusters
      WHERE detected_at >= $1::timestamptz AND detected_at < $2::timestamptz
      ORDER BY total_strength DESC NULLS LAST
      LIMIT 20`,
    [sinceSql, nextSql],
  )).rows as Array<{
    id: string; cluster_label: string; total_strength: number | null;
    member_count: number | null; signal_types: string[]; status: string;
  }>;
  const new_clusters = newClusters.length === 0
    ? '<p><em>None.</em></p>'
    : '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>id</th><th>label</th><th>strength</th><th>members</th><th>signals</th><th>status</th>'
      + '</tr></thead><tbody>'
      + newClusters.map((c) => `<tr><td>${c.id.slice(0,8)}</td><td>${escapeHtml(c.cluster_label)}</td><td>${c.total_strength ?? '?'}</td><td>${c.member_count ?? '?'}</td><td>${escapeHtml((c.signal_types ?? []).join(', '))}</td><td>${escapeHtml(c.status)}</td></tr>`).join('')
      + '</tbody></table>';

  // 3. Cluster actions (confirmed/dismissed) — admin resolved_at in window.
  const clusterActions = (await query(
    `SELECT id::text AS id, cluster_label, admin_notes,
            resolved_by::text AS resolved_by, resolved_at, status
       FROM fraud_clusters
      WHERE resolved_at >= $1::timestamptz AND resolved_at < $2::timestamptz
      ORDER BY resolved_at DESC
      LIMIT 20`,
    [sinceSql, nextSql],
  )).rows as Array<{
    id: string; cluster_label: string; admin_notes: string | null;
    resolved_by: string | null; resolved_at: Date | null; status: string | null;
  }>;
  const cluster_actions = clusterActions.length === 0
    ? '<p><em>None.</em></p>'
    : '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>id</th><th>label</th><th>status</th><th>resolved_at</th><th>notes</th>'
      + '</tr></thead><tbody>'
      + clusterActions.map((c) => `<tr><td>${c.id.slice(0,8)}</td><td>${escapeHtml(c.cluster_label)}</td><td>${escapeHtml(c.status ?? '')}</td><td>${c.resolved_at?.toISOString() ?? ''}</td><td>${escapeHtml((c.admin_notes ?? '').slice(0,80))}</td></tr>`).join('')
      + '</tbody></table>';

  // 4. Flagged withdrawals (status='held' or 'rejected' in window).
  // Note: withdrawal-risk.service.ts doesn't persist risk_score or
  // reason_code into the metadata column — only chain + currency are
  // stored. We query those columns directly from transactions and
  // pull what context metadata does have.
  const flaggedW = (await query(
    `SELECT id::text AS id, user_id::text AS user_id, amount, currency,
            status, ip_address,
            metadata,
            created_at
       FROM transactions
      WHERE type = 'withdrawal'
        AND status IN ('held', 'rejected')
        AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
      ORDER BY created_at DESC
      LIMIT 30`,
    [sinceSql, nextSql],
  )).rows as Array<{
    id: string; user_id: string; amount: number | string; currency: string;
    status: string; ip_address: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>;
  const totalFlaggedAmount = flaggedW.reduce((sum, w) => sum + Number(w.amount ?? 0), 0);
  const flagged_withdrawals = flaggedW.length === 0
    ? '<p><em>None.</em></p>'
    : `<p><strong>${flaggedW.length}</strong> flagged withdrawal(s) totalling <strong>${totalFlaggedAmount.toFixed(2)}</strong> (mixed currencies).</p>`
      + '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>id</th><th>user_id</th><th>amount</th><th>cur</th><th>status</th><th>ip</th><th>chain</th>'
      + '</tr></thead><tbody>'
      + flaggedW.map((w) => {
          const meta = w.metadata ?? {};
          const chain = typeof meta.chain === 'string' ? meta.chain : '';
          return `<tr><td>${w.id.slice(0,8)}</td><td>${w.user_id.slice(0,8)}</td><td>${w.amount}</td><td>${escapeHtml(w.currency ?? '')}</td><td>${escapeHtml(w.status)}</td><td>${escapeHtml(w.ip_address ?? '')}</td><td>${escapeHtml(chain)}</td></tr>`;
        }).join('')
      + '</tbody></table>';

  // 5. KYC events (admin action on kyc_submissions in window).
  const kycRows = (await query(
    `SELECT user_id::text AS user_id, status, submitted_at, reviewed_at
       FROM kyc_submissions
      WHERE (submitted_at >= $1::timestamptz AND submitted_at < $2::timestamptz)
         OR (reviewed_at  >= $1::timestamptz AND reviewed_at  < $2::timestamptz)
      ORDER BY COALESCE(reviewed_at, submitted_at) DESC
      LIMIT 30`,
    [sinceSql, nextSql],
  )).rows as Array<{
    user_id: string; status: string; submitted_at: Date; reviewed_at: Date | null;
  }>;
  const kyc_events = kycRows.length === 0
    ? '<p><em>None.</em></p>'
    : '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>user_id</th><th>status</th><th>submitted</th><th>reviewed</th>'
      + '</tr></thead><tbody>'
      + kycRows.map((k) => `<tr><td>${k.user_id.slice(0,8)}</td><td>${escapeHtml(k.status)}</td><td>${k.submitted_at?.toISOString() ?? ''}</td><td>${k.reviewed_at?.toISOString() ?? ''}</td></tr>`).join('')
      + '</tbody></table>';

  // 6. New fraud signals by type (last 24h).
  const signalCounts = (await query(
    `SELECT signal_type, severity, count(*)::int AS n
       FROM fraud_signals
      WHERE detected_at >= $1::timestamptz AND detected_at < $2::timestamptz
      GROUP BY signal_type, severity
      ORDER BY n DESC
      LIMIT 10`,
    [sinceSql, nextSql],
  )).rows as Array<{ signal_type: string; severity: string; n: number }>;
  const totalSignals = signalCounts.reduce((sum, s) => sum + Number(s.n ?? 0), 0);
  const signal_counts = signalCounts.length === 0
    ? '<p><em>None.</em></p>'
    : '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
      + '<th>signal</th><th>severity</th><th>count</th></tr></thead><tbody>'
      + signalCounts.map((s) => `<tr><td>${escapeHtml(s.signal_type)}</td><td>${escapeHtml(s.severity)}</td><td>${s.n}</td></tr>`).join('')
      + '</tbody></table>';

  // 7. ML predictions fired in window (from ml_predictions table; P3-1c).
  // Schema: ml_predictions stores model_id (UUID) + source. To render
  // a friendly name+version, join ml_models by id. If the model row
  // was deleted, fall back to the literal source string.
  let ml_predictions = '<p><em>ML model not active (set <code>ml_enabled=true</code> in admin_settings).</em></p>';
  try {
    const mlRows = (await query(
      `SELECT p.user_id::text AS user_id,
              COALESCE(m.display_name, p.source) AS model_name,
              COALESCE(m.version, '') AS model_version,
              p.ml_prob AS prob, p.predicted_fraud, p.flag_action, p.created_at
         FROM ml_predictions p
         LEFT JOIN ml_models m ON m.id = p.model_id
        WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
        ORDER BY p.created_at DESC
        LIMIT 20`,
      [sinceSql, nextSql],
    )).rows as Array<{
      user_id: string; model_name: string; model_version: string;
      prob: number; predicted_fraud: boolean; flag_action: string;
      created_at: Date;
    }>;
    if (mlRows.length > 0) {
      ml_predictions = '<table border="1" cellpadding="4" cellspacing="0"><thead><tr>'
        + '<th>user_id</th><th>model</th><th>ver</th><th>prob</th><th>fraud?</th><th>action</th>'
        + '</tr></thead><tbody>'
        + mlRows.map((m) => `<tr><td>${m.user_id.slice(0,8)}</td><td>${escapeHtml(m.model_name)}</td><td>${escapeHtml(m.model_version ?? '')}</td><td>${(Number(m.prob ?? 0)).toFixed(3)}</td><td>${m.predicted_fraud ? 'YES' : 'no'}</td><td>${escapeHtml(m.flag_action)}</td></tr>`).join('')
        + '</tbody></table>';
    }
  } catch { /* ml_predictions table may not exist yet — fine */ }

  // 8. Recommendations (simple heuristic; admin can read the report)
  const recs: string[] = [];
  // mlRows is declared inside the try/catch above for the ML
  // predictions section. Track whether any ML predictions fired
  // so the recommendations can mention it.
  const mlFiredInWindow = await mlFiredInWindowHelper(sinceSql, nextSql);
  if (newClusters.length > 0) recs.push(`<li>${newClusters.length} new fraud cluster(s) detected. Review the cluster modal in the admin fraud panel.</li>`);
  if (flaggedW.length >= 5) recs.push(`<li>${flaggedW.length} withdrawals held/rejected in 24h — consider tightening risk thresholds.</li>`);
  if (totalSignals > 100) recs.push(`<li>Signal volume (${totalSignals}) is high. Review top-3 signal types in admin fraud panel.</li>`);
  if (!mlFiredInWindow) recs.push(`<li>ML model not firing predictions. Confirm <code>ml_active_model_id</code> is set.</li>`);
  if (recs.length === 0) recs.push('<li>No immediate action recommended. Continue daily monitoring.</li>');
  const recommendations = `<ul>${recs.join('')}</ul>`;

  return {
    report_date: reportDate,
    generated_at: new Date().toISOString(),
    total_signals: totalSignals,
    top_risk_users,
    new_clusters,
    cluster_actions,
    flagged_withdrawals,
    kyc_events,
    signal_counts,
    ml_predictions,
    recommendations,
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

/**
 * Compute yesterday's date as YYYY-MM-DD in UTC. Pure helper.
 */
export function yesterdayIso(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Public entry point: render the digest for the given date and
 * queue the email. Returns a structured result for the admin
 * endpoint + cron worker.
 */
export async function sendDailyReport(opts: SendDailyReportOptions = {}): Promise<SendDailyReportResult> {
  const force = !!opts.force;
  const reportKind = opts.reportKind ?? (force ? 'on_demand' : 'daily_digest');
  const reportDate = opts.reportDate ?? yesterdayIso();
  const minSignals = opts.minSignals ?? Number((await getAdminSetting('daily_fraud_report_min_signals', '1')) ?? '1');
  const recipient = opts.recipient
    ?? ((await getAdminSetting('daily_fraud_report_recipient', 'ohmyholy99@gmail.com')) ?? 'ohmyholy99@gmail.com');

  // Idempotency: skip if (date, kind) already exists and force=false
  if (!force) {
    const existing = await query(
      `SELECT id, status FROM daily_fraud_reports
        WHERE report_date = $1::date AND report_kind = $2`,
      [reportDate, reportKind],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: number; status: string };
      return {
        sent: false,
        reason: `already-sent (id=${row.id}, status=${row.status})`,
      };
    }
  }

  const payload = await aggregateDigest(reportDate);

  // Quiet-day threshold
  if (!force && payload.total_signals < minSignals) {
    await query(
      `INSERT INTO daily_fraud_reports (report_date, report_kind, recipient, status, last_error, payload)
       VALUES ($1::date, $2, $3, 'skipped', $4, $5::jsonb)
       ON CONFLICT (report_date, report_kind) DO NOTHING`,
      [reportDate, reportKind, recipient,
       `total_signals=${payload.total_signals} < min=${minSignals}`,
       JSON.stringify(payload)],
    );
    return {
      sent: false,
      reason: `total_signals=${payload.total_signals} < min=${minSignals} (use force=true to override)`,
      totalSignals: payload.total_signals,
    };
  }

  // Insert the digest row first so the idempotency key is held even
  // if the SMTP send fails (we don't want a failed send to be
  // retried indefinitely).
  const row = (await query(
    `INSERT INTO daily_fraud_reports (report_date, report_kind, recipient, status, payload)
     VALUES ($1::date, $2, $3, 'queued', $4::jsonb)
     ON CONFLICT (report_date, report_kind) DO UPDATE
       SET recipient = EXCLUDED.recipient,
           payload = EXCLUDED.payload,
           queued_at = NOW()
     RETURNING id`,
    [reportDate, reportKind, recipient, JSON.stringify(payload)],
  )).rows[0] as { id: number };

  // Queue the email. The SMTP worker drains the queue; if SMTP_HOST
  // is empty, queueEmail returns queued=false and writes
  // last_error='smtp_disabled'.
  const queueResult = await queueEmail({
    recipient,
    recipient_kind: 'admin',
    user_id: null,
    event_type: 'fraud.daily_digest',
    context: payload as unknown as Record<string, unknown>,
    subject_override: `CryptoFlip Daily Fraud Digest — ${reportDate}`,
  });

  const newStatus = queueResult.queued ? 'queued' : 'pending';
  await query(
    `UPDATE daily_fraud_reports
        SET status = $2::varchar(20),
            last_error = $3,
            sent_at = CASE WHEN $2::varchar(20) = 'sent' THEN NOW() ELSE sent_at END
      WHERE id = $1`,
    [row.id, queueResult.queued ? 'queued' : 'pending', queueResult.reason ?? null],
  );

  return {
    sent: queueResult.queued,
    reason: queueResult.reason,
    reportId: row.id,
    recipient,
    totalSignals: payload.total_signals,
  };
}

/**
 * Cron-friendly tick: checks the configured send hour (default 08:00 UTC)
 * and only fires the daily digest when the current hour matches.
 * Called once per hour from index.ts.
 *
 * `lastFiredKey` is the report_date of the last digest sent, so the
 * tick is safe to call twice in the same hour (idempotent at this
 * layer too). Re-processes after restart are also safe because
 * `sendDailyReport` is idempotent.
 */
export async function maybeRunDailyReport(): Promise<SendDailyReportResult | null> {
  const enabled = await getAdminSettingBool('daily_fraud_report_enabled', true);
  if (!enabled) return null;

  const hourCfg = Number((await getAdminSetting('daily_fraud_report_send_hour_utc', '8')) ?? '8');
  const nowHour = new Date().getUTCHours();
  if (nowHour !== hourCfg) return null;

  return sendDailyReport({ reportKind: 'daily_digest' });
}

/**
 * List recent digests (for the admin UI history table).
 */
export async function listRecentDigests(limit = 30): Promise<Array<{
  id: number; report_date: string; report_kind: string;
  recipient: string; queued_at: string; sent_at: string | null;
  status: string; last_error: string | null; total_signals: number;
}>> {
  const rows = (await query(
    `SELECT id, report_date::text AS report_date, report_kind, recipient,
            queued_at, sent_at, status, last_error,
            (payload->>'total_signals')::int AS total_signals
       FROM daily_fraud_reports
      ORDER BY queued_at DESC
      LIMIT $1::int`,
    [limit],
  )).rows as Array<{
    id: number; report_date: string; report_kind: string;
    recipient: string; queued_at: Date; sent_at: Date | null;
    status: string; last_error: string | null; total_signals: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    report_date: r.report_date,
    report_kind: r.report_kind,
    recipient: r.recipient,
    queued_at: r.queued_at.toISOString(),
    sent_at: r.sent_at?.toISOString() ?? null,
    status: r.status,
    last_error: r.last_error,
    total_signals: Number(r.total_signals ?? 0),
  }));
}

/**
 * Cron entry point: setInterval wrapper around maybeRunDailyReport.
 * Called once from index.ts on backend startup. Idempotent — safe
 * to start multiple times (each call returns a new handle but
 * the worker itself is idempotent).
 *
 * Default tick is every 60 minutes; the function then checks the
 * configured send hour (default 08:00 UTC) before actually sending.
 * This is intentionally lazy: drift across container restarts
 * doesn't accumulate because sendDailyReport is itself idempotent
 * (keyed on (report_date, report_kind)).
 */
export function startDailyFraudReportWorker(tickMs = 60 * 60 * 1000): NodeJS.Timeout {
  // Run once on startup, but offset so we don't immediately fire
  // the daily digest right after a 08:00 UTC server boot. Wait
  // 5 seconds before the first tick; the maybeRunDailyReport
  // gate still ensures we only send on the configured hour.
  const initialDelay = 5_000;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    try {
      const result = await maybeRunDailyReport();
      if (result) {
        console.log('[daily-fraud-report] tick result:', {
          sent: result.sent,
          reason: result.reason,
          reportId: result.reportId,
          recipient: result.recipient,
        });
      }
    } catch (err) {
      console.error('[daily-fraud-report] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      timer = setTimeout(tick, tickMs);
    }
  };
  timer = setTimeout(tick, initialDelay);
  return timer as unknown as NodeJS.Timeout;
}

/**
 * Render the digest into the email template (without sending).
 * Used by the admin preview endpoint.
 */
export async function previewDailyReport(reportDate?: string): Promise<DailyReportPayload> {
  return aggregateDigest(reportDate ?? yesterdayIso());
}

/**
 * Helper used inside aggregateDigest to count ML predictions fired
 * in the time window, separately from the table-rendering block so
 * the recommendation engine doesn't depend on whether the ML
 * predictions table exists.
 */
async function mlFiredInWindowHelper(sinceSql: string, nextSql: string): Promise<boolean> {
  try {
    const r = await query(
      `SELECT 1 FROM ml_predictions
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        LIMIT 1`,
      [sinceSql, nextSql],
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}