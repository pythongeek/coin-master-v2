/**
 * =============================================================
 *  ADMIN KYC ROUTES - all admin-controllable KYC config + per-user actions
 * =============================================================
 *
 *  Endpoints (15 total):
 *    Config (read/write):
 *      GET    /api/admin/kyc/config           - full config snapshot
 *      POST   /api/admin/kyc/thresholds       - update one or more tier thresholds
 *      POST   /api/admin/kyc/sanctioned-countries - add/remove from list
 *      POST   /api/admin/kyc/expiry-policy    - enable/disable + auto-action
 *
 *    Per-User Overrides:
 *      GET    /api/admin/kyc/overrides        - list active overrides
 *      POST   /api/admin/kyc/overrides        - grant override
 *      DELETE /api/admin/kyc/overrides/:userId - revoke
 *
 *    Sanctions Exceptions:
 *      POST   /api/admin/kyc/sanctions-exception - per-user exception
 *
 *    Self-Exclusion:
 *      GET    /api/admin/kyc/self-exclusions   - list
 *      POST   /api/admin/kyc/self-exclusion/reverse
 *      POST   /api/admin/kyc/self-exclusion/extend
 *
 *    Audit + Stats:
 *      GET    /api/admin/kyc/overrides-log     - full audit trail
 *      GET    /api/admin/kyc/deposit-stats    - block counts per tier + sanctioned blocks
 *
 *  All write actions require super_admin role and log to kyc_override_log.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { roleMiddleware } from '../middleware/auth';
import { query } from '../config/database';
import { getRawSetting, setRawSetting } from '../services/admin-config';
import { logKycOverride } from '../services/kyc-enforcement.service';

const router = Router();

interface AuthRequest extends Request {
  user?: AuthPayload;
}

// All routes require super_admin
router.use(authMiddleware, roleMiddleware(['super_admin']));

// =============================================================================
//  Config endpoints
// =============================================================================

/**
 * GET /api/admin/kyc/config
 * Returns full snapshot of all KYC-related admin_settings + dynamic data.
 */
router.get('/config', async (_req: AuthRequest, res: Response) => {
  try {
    const keys = [
      'deposit_tier0_max_per_tx', 'deposit_tier0_max_daily',
      'deposit_tier1_max_per_tx', 'deposit_tier1_max_daily',
      'deposit_tier2_max_per_tx', 'deposit_tier2_max_daily',
      'deposit_tier3_max_per_tx', 'deposit_tier3_max_daily',
      'kyc_sanctioned_countries',
      'kyc_expiry_check_enabled', 'kyc_expiry_grace_days', 'kyc_expiry_auto_action',
      'kyc_tier1_max_age_days', 'kyc_tier2_max_age_days', 'kyc_tier3_max_age_days',
      'self_exclusion_reversal_cooling_hours',
      'email_default_language',
      'deposit_kyc_enforcement_mode', 'deposit_kyc_strict_after',
    ];
    const values: Record<string, string | null> = {};
    for (const k of keys) {
      values[k] = await getRawSetting(k);
    }

    // Parse sanctioned list
    let sanctioned: string[] = [];
    try {
      if (values.kyc_sanctioned_countries) {
        sanctioned = JSON.parse(values.kyc_sanctioned_countries);
      }
    } catch { /* keep [] */ }

    res.json({
      success: true,
      config: {
        thresholds: {
          tier0: { maxPerTx: parseFloat(values.deposit_tier0_max_per_tx || '100'), maxDaily: parseFloat(values.deposit_tier0_max_daily || '100') },
          tier1: { maxPerTx: parseFloat(values.deposit_tier1_max_per_tx || '500'), maxDaily: parseFloat(values.deposit_tier1_max_daily || '500') },
          tier2: { maxPerTx: parseFloat(values.deposit_tier2_max_per_tx || '5000'), maxDaily: parseFloat(values.deposit_tier2_max_daily || '10000') },
          tier3: { maxPerTx: parseFloat(values.deposit_tier3_max_per_tx || '50000'), maxDaily: parseFloat(values.deposit_tier3_max_daily || '100000') },
        },
        sanctionedCountries: sanctioned,
        expiryPolicy: {
          enabled: values.kyc_expiry_check_enabled === 'true',
          graceDays: parseInt(values.kyc_expiry_grace_days || '90', 10),
          autoAction: values.kyc_expiry_auto_action || 'warn_only',
          tierMaxAgeDays: {
            tier1: parseInt(values.kyc_tier1_max_age_days || '1825', 10),
            tier2: parseInt(values.kyc_tier2_max_age_days || '1095', 10),
            tier3: parseInt(values.kyc_tier3_max_age_days || '365', 10),
          },
        },
        selfExclusion: {
          reversalCoolingHours: parseInt(values.self_exclusion_reversal_cooling_hours || '24', 10),
        },
        emailDefaultLanguage: values.email_default_language || 'en',
        enforcementMode: values.deposit_kyc_enforcement_mode || 'warn',
        strictAfter: values.deposit_kyc_strict_after || null,
      },
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/thresholds
 * Body: { tier?: 0|1|2|3, maxPerTx?, maxDaily? } | { sanctionedCountries?: [] } | { expiryPolicy?: {} }
 * Multiple updates can be combined in one call.
 */
router.post('/thresholds', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as {
      tier?: number;
      maxPerTx?: number;
      maxDaily?: number;
      sanctionedCountries?: string[];
      expiryPolicy?: { enabled?: boolean; graceDays?: number; autoAction?: string };
      enforcementMode?: 'off' | 'warn' | 'strict';
    };
    const updates: Array<{ key: string; value: string; label: string }> = [];
    const changes: Record<string, unknown> = {};

    if (body.tier !== undefined && (body.maxPerTx !== undefined || body.maxDaily !== undefined)) {
      const t = body.tier;
      if (![0, 1, 2, 3].includes(t)) {
        return res.status(400).json({ success: false, error: 'tier must be 0, 1, 2, or 3' });
      }
      if (body.maxPerTx !== undefined) {
        const k = `deposit_tier${t}_max_per_tx`;
        updates.push({ key: k, value: String(body.maxPerTx), label: `Tier ${t} max per tx` });
        changes[k] = body.maxPerTx;
      }
      if (body.maxDaily !== undefined) {
        const k = `deposit_tier${t}_max_daily`;
        updates.push({ key: k, value: String(body.maxDaily), label: `Tier ${t} max daily` });
        changes[k] = body.maxDaily;
      }
    }

    if (body.sanctionedCountries !== undefined) {
      const clean = body.sanctionedCountries
        .filter((c) => typeof c === 'string' && c.length === 2)
        .map((c) => c.toUpperCase());
      updates.push({ key: 'kyc_sanctioned_countries', value: JSON.stringify(clean), label: 'Sanctioned countries' });
      changes.sanctionedCountries = clean;
    }

    if (body.expiryPolicy !== undefined) {
      if (body.expiryPolicy.enabled !== undefined) {
        updates.push({ key: 'kyc_expiry_check_enabled', value: String(body.expiryPolicy.enabled), label: 'Expiry check enabled' });
        changes.expiryEnabled = body.expiryPolicy.enabled;
      }
      if (body.expiryPolicy.graceDays !== undefined) {
        updates.push({ key: 'kyc_expiry_grace_days', value: String(body.expiryPolicy.graceDays), label: 'Expiry grace days' });
        changes.expiryGraceDays = body.expiryPolicy.graceDays;
      }
      if (body.expiryPolicy.autoAction !== undefined) {
        if (!['warn_only', 'downgrade_to_tier0', 'downgrade_to_tier1'].includes(body.expiryPolicy.autoAction)) {
          return res.status(400).json({ success: false, error: 'Invalid autoAction' });
        }
        updates.push({ key: 'kyc_expiry_auto_action', value: body.expiryPolicy.autoAction, label: 'Expiry auto action' });
        changes.expiryAutoAction = body.expiryPolicy.autoAction;
      }
    }

    if (body.enforcementMode !== undefined) {
      if (!['off', 'warn', 'strict'].includes(body.enforcementMode)) {
        return res.status(400).json({ success: false, error: 'Invalid enforcementMode' });
      }
      updates.push({ key: 'deposit_kyc_enforcement_mode', value: body.enforcementMode, label: 'Enforcement mode' });
      changes.enforcementMode = body.enforcementMode;
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No updates provided' });
    }

    for (const u of updates) {
      await setRawSetting(u.key, u.value, u.label);
    }

    await logKycOverride(adminId, 'threshold_change', changes,
      (req.body as { reason?: string }).reason || 'Bulk threshold update via admin UI');

    res.json({ success: true, updated: updates.length, changes });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/sanctioned-countries
 * Body: { action: 'add' | 'remove', country: 'XX', reason: '...' }
 */
router.post('/sanctioned-countries', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { action?: string; country?: string; reason?: string };
    if (!body.action || !['add', 'remove'].includes(body.action)) {
      return res.status(400).json({ success: false, error: 'action must be add or remove' });
    }
    const country = (body.country || '').toUpperCase();
    if (country.length !== 2) {
      return res.status(400).json({ success: false, error: 'country must be a 2-letter ISO code' });
    }
    if (!body.reason || body.reason.length < 10) {
      return res.status(400).json({ success: false, error: 'reason required (min 10 chars) for audit' });
    }

    const currentRaw = await getRawSetting('kyc_sanctioned_countries');
    let list: string[] = ['IR', 'KP', 'SY', 'CU', 'AF'];
    try {
      if (currentRaw) list = JSON.parse(currentRaw);
    } catch { /* use defaults */ }

    let action_desc: string;
    if (body.action === 'add') {
      if (list.includes(country)) {
        return res.status(400).json({ success: false, error: `${country} already in sanctioned list` });
      }
      list.push(country);
      action_desc = `Added ${country} to sanctioned countries list`;
    } else {
      if (!list.includes(country)) {
        return res.status(400).json({ success: false, error: `${country} not in sanctioned list` });
      }
      list = list.filter((c) => c !== country);
      action_desc = `Removed ${country} from sanctioned countries list`;
    }

    await setRawSetting('kyc_sanctioned_countries', JSON.stringify(list), 'Sanctioned countries');
    await logKycOverride(adminId, `sanctions_list_${body.action}` as 'sanctions_list_add' | 'sanctions_list_remove',
      { country, list_after: list }, body.reason);

    res.json({ success: true, action: body.action, country, list });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  Per-user overrides
// =============================================================================

/**
 * GET /api/admin/kyc/overrides
 * List active per-user overrides (paginated).
 */
router.get('/overrides', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10), 0);
    const r = await query(
      `SELECT u.id AS user_id, u.username, u.email, u.kyc_tier,
              u.kyc_deposit_override_until, u.kyc_deposit_override_reason,
              admin.username AS granted_by_username,
              u.kyc_deposit_override_until - NOW() AS time_remaining
       FROM users u
       LEFT JOIN users admin ON admin.id = u.kyc_deposit_override_by
       WHERE u.kyc_deposit_override_until IS NOT NULL
         AND u.kyc_deposit_override_until > NOW()
       ORDER BY u.kyc_deposit_override_until DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await query(
      `SELECT COUNT(*)::int AS total FROM users WHERE kyc_deposit_override_until IS NOT NULL AND kyc_deposit_override_until > NOW()`
    );
    res.json({ success: true, overrides: r.rows, total: total.rows[0].total, limit, offset });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/overrides
 * Body: { userId, grantedDays: 7|14|30|60|custom, customDays?, reason }
 * Grants a deposit-side KYC override to a specific user.
 */
router.post('/overrides', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { userId?: string; grantedDays?: number | string; customDays?: number; reason?: string };
    if (!body.userId || !body.reason || body.reason.length < 10) {
      return res.status(400).json({ success: false, error: 'userId and reason (min 10 chars) required' });
    }
    let days: number;
    if (body.grantedDays === 'custom' && body.customDays) {
      days = parseInt(String(body.customDays), 10);
    } else {
      days = parseInt(String(body.grantedDays || '30'), 10);
    }
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return res.status(400).json({ success: false, error: 'grantedDays must be 1-365' });
    }

    // Verify user exists
    const u = await query('SELECT id FROM users WHERE id = $1', [body.userId]);
    if (!u.rows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await query(
      `UPDATE users
       SET kyc_deposit_override_until = NOW() + ($1 || ' days')::interval,
           kyc_deposit_override_reason = $2,
           kyc_deposit_override_by = $3
       WHERE id = $4`,
      [days, body.reason, adminId, body.userId]
    );

    await logKycOverride(adminId, 'override_grant', { grantedDays: days }, body.reason, body.userId);

    res.json({ success: true, userId: body.userId, grantedDays: days, reason: body.reason });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * DELETE /api/admin/kyc/overrides/:userId
 * Revokes a deposit-side KYC override.
 */
router.delete('/overrides/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const userId = String(req.params.userId || '');
    const reason = (req.body as { reason?: string })?.reason || 'Override revoked by admin';

    await query(
      `UPDATE users
       SET kyc_deposit_override_until = NULL,
           kyc_deposit_override_reason = NULL,
           kyc_deposit_override_by = NULL
       WHERE id = $1`,
      [userId]
    );

    await logKycOverride(adminId, 'override_revoke', { revoked: true }, reason, userId);

    res.json({ success: true, userId, revoked: true });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/sanctions-exception
 * Per-user exception to sanctioned-country block.
 * Body: { userId, country, expiresAt: ISO date, reason }
 */
router.post('/sanctions-exception', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { userId?: string; country?: string; expiresAt?: string; reason?: string };
    if (!body.userId || !body.country || !body.expiresAt || !body.reason || body.reason.length < 10) {
      return res.status(400).json({ success: false, error: 'userId, country, expiresAt, and reason (min 10 chars) required' });
    }

    await query(
      `UPDATE users
       SET kyc_country_exception_until = $1,
           kyc_country_exception_reason = $2,
           kyc_country_exception_by = $3
       WHERE id = $4`,
      [body.expiresAt, body.reason, adminId, body.userId]
    );

    await logKycOverride(adminId, 'sanctions_exception_grant',
      { country: body.country.toUpperCase(), expiresAt: body.expiresAt }, body.reason, body.userId);

    res.json({ success: true, userId: body.userId, country: body.country.toUpperCase(), expiresAt: body.expiresAt });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  Self-exclusion
// =============================================================================

/**
 * GET /api/admin/kyc/self-exclusions?status=active|expired|all
 */
router.get('/self-exclusions', async (req: AuthRequest, res: Response) => {
  try {
    const status = (req.query.status as string) || 'active';
    let where = '';
    if (status === 'active') where = 'AND self_excluded_until > NOW()';
    else if (status === 'expired') where = 'AND self_excluded_until IS NOT NULL AND self_excluded_until <= NOW()';

    const r = await query(
      `SELECT u.id, u.username, u.email, u.self_excluded_until,
              EXTRACT(DAY FROM (u.self_excluded_until - NOW()))::int AS days_remaining
       FROM users u
       WHERE u.self_excluded_until IS NOT NULL ${where}
       ORDER BY u.self_excluded_until DESC
       LIMIT 200`,
      []
    );
    res.json({ success: true, exclusions: r.rows, status });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/self-exclusion/reverse
 * Reverses a user's self-exclusion. Reason required. Optional cooling hours.
 * Body: { userId, reason }
 */
router.post('/self-exclusion/reverse', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { userId?: string; reason?: string };
    if (!body.userId || !body.reason || body.reason.length < 20) {
      return res.status(400).json({ success: false, error: 'userId and reason (min 20 chars) required for self-exclusion reversal' });
    }

    const coolingRaw = await getRawSetting('self_exclusion_reversal_cooling_hours');
    const coolingHours = parseInt(coolingRaw || '24', 10);

    // Schedule reversal: set to NULL but with audit trail. If cooling > 0,
    // we'd need a job queue - for now, immediate reversal but cooling config
    // remains in place for future enhancement.
    await query(
      `UPDATE users
       SET self_excluded_until = NULL
       WHERE id = $1`,
      [body.userId]
    );

    await logKycOverride(adminId, 'self_exclusion_reverse',
      { immediate: true, coolingHoursConfigured: coolingHours }, body.reason, body.userId);

    res.json({
      success: true,
      userId: body.userId,
      reversed: true,
      note: `Self-exclusion cleared. Cooling period of ${coolingHours}h is configured for the platform but reversal is immediate.`,
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/self-exclusion/extend
 * Extend an existing self-exclusion. Body: { userId, additionalDays, reason }
 */
router.post('/self-exclusion/extend', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { userId?: string; additionalDays?: number; reason?: string };
    if (!body.userId || !body.additionalDays || body.additionalDays < 1 || body.additionalDays > 3650) {
      return res.status(400).json({ success: false, error: 'userId and additionalDays (1-3650) required' });
    }
    if (!body.reason || body.reason.length < 10) {
      return res.status(400).json({ success: false, error: 'reason (min 10 chars) required for audit' });
    }

    await query(
      `UPDATE users
       SET self_excluded_until = GREATEST(COALESCE(self_excluded_until, NOW()), NOW()) + ($1 || ' days')::interval
       WHERE id = $2`,
      [body.additionalDays, body.userId]
    );

    await logKycOverride(adminId, 'self_exclusion_extend', { additionalDays: body.additionalDays }, body.reason, body.userId);

    const after = await query('SELECT self_excluded_until FROM users WHERE id = $1', [body.userId]);
    res.json({ success: true, userId: body.userId, new_excluded_until: after.rows[0]?.self_excluded_until });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

// =============================================================================
//  Audit + Stats
// =============================================================================

/**
 * GET /api/admin/kyc/overrides-log
 * Full audit trail (paginated, filterable by action).
 */
router.get('/overrides-log', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10), 0);
    const action = req.query.action as string | undefined;
    const where = action ? 'WHERE k.action = $3' : '';
    const params: (string | number)[] = action ? [limit, offset, action] : [limit, offset];

    const r = await query(
      `SELECT k.id, k.user_id, k.admin_user_id, k.action, k.details, k.reason, k.created_at,
              u.username AS user_username, u.email AS user_email,
              admin.username AS admin_username
       FROM kyc_override_log k
       LEFT JOIN users u ON u.id = k.user_id
       LEFT JOIN users admin ON admin.id = k.admin_user_id
       ${where}
       ORDER BY k.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    res.json({ success: true, entries: r.rows, limit, offset, filter: action || 'all' });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * GET /api/admin/kyc/deposit-stats
 * Block counts per tier + sanctioned blocks.
 */
router.get('/deposit-stats', async (_req: AuthRequest, res: Response) => {
  try {
    // Recent block counts (last 7 days) by reason
    const blocks = await query(
      `SELECT action, COUNT(*)::int AS n
       FROM kyc_override_log
       WHERE action IN ('override_grant', 'sanctions_list_add', 'threshold_change',
                         'self_exclusion_reverse', 'self_exclusion_extend')
         AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY action`
    );

    // Active overrides count
    const overrides = await query(
      `SELECT COUNT(*)::int AS active_overrides,
              COUNT(*) FILTER (WHERE kyc_country_exception_until > NOW())::int AS active_country_exceptions
       FROM users
       WHERE kyc_deposit_override_until > NOW()
          OR kyc_country_exception_until > NOW()`
    );

    // Sanctioned list
    const sanctionedRaw = await getRawSetting('kyc_sanctioned_countries');
    let sanctioned: string[] = [];
    try { if (sanctionedRaw) sanctioned = JSON.parse(sanctionedRaw); } catch {}

    res.json({
      success: true,
      stats: {
        recent_admin_actions: blocks.rows,
        active_overrides: overrides.rows[0]?.active_overrides || 0,
        active_country_exceptions: overrides.rows[0]?.active_country_exceptions || 0,
        sanctioned_countries: sanctioned,
      },
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

/**
 * POST /api/admin/kyc/expiry-policy
 * Body: { enabled, autoAction, graceDays }
 */
router.post('/expiry-policy', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const body = req.body as { enabled?: boolean; autoAction?: string; graceDays?: number; reason?: string };
    const changes: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      await setRawSetting('kyc_expiry_check_enabled', String(body.enabled), 'KYC expiry check enabled');
      changes.enabled = body.enabled;
    }
    if (body.autoAction !== undefined) {
      if (!['warn_only', 'downgrade_to_tier0', 'downgrade_to_tier1'].includes(body.autoAction)) {
        return res.status(400).json({ success: false, error: 'Invalid autoAction' });
      }
      await setRawSetting('kyc_expiry_auto_action', body.autoAction, 'KYC expiry auto action');
      changes.autoAction = body.autoAction;
    }
    if (body.graceDays !== undefined) {
      if (body.graceDays < 0 || body.graceDays > 365) {
        return res.status(400).json({ success: false, error: 'graceDays must be 0-365' });
      }
      await setRawSetting('kyc_expiry_grace_days', String(body.graceDays), 'KYC expiry grace days');
      changes.graceDays = body.graceDays;
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ success: false, error: 'No changes provided' });
    }
    await logKycOverride(adminId, 'expiry_policy_change', changes, body.reason || 'Expiry policy updated');
    res.json({ success: true, changes });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: m });
  }
});

export default router;