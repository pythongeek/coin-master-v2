/**
 * =============================================================
 *  ADMIN AUDIT ROUTES - searchable audit log viewer
 * =============================================================
 *  Mounted under /api/admin/audit (super_admin only)
 *
 *  Endpoints:
 *    GET  /api/admin/audit/logs      - list logs (paginated, filterable)
 *    GET  /api/admin/audit/logs/:id  - single log detail
 *    GET  /api/admin/audit/stats     - aggregations (counts by category/severity/action)
 *    GET  /api/admin/audit/users     - distinct users referenced in audit_log (for filter dropdowns)
 *    GET  /api/admin/audit/export    - CSV download of filtered logs (cap 10k rows)
 *    POST /api/admin/audit/logs/:id/notes  - admin adds a note to an audit row (compliance annotation)
 *
 *  Filter params:
 *    q          - free text (matches action + details::text + ip_address::text)
 *    user_id    - exact match
 *    category   - comma-separated list (admin,auth,...)
 *    action     - exact match (or LIKE pattern)
 *    severity   - comma-separated list (debug,info,warn,error,critical)
 *    from       - ISO date (inclusive)
 *    to         - ISO date (inclusive)
 *    limit      - default 100, max 500 (list endpoint); export max 10000
 *    offset     - default 0
 *
 *  Query strategy: parameterized SQL with explicit type casts for JSONB text
 *  search. Capped limits to prevent expensive queries. All filters optional
 *  so admin can pull "everything in last 24h" with one click.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// =============================================================
//  FILTERS
// =============================================================

interface AuditFilters {
  q?: string;
  user_id?: string;
  category?: string[];
  action?: string;
  severity?: string[];
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

const ALLOWED_CATEGORIES = [
  'admin', 'auth', 'security', 'config', 'system',
  'bonus', 'withdrawal', 'wagering', 'rain', 'payment',
  'affiliate', 'fraud', 'support',
];
const ALLOWED_SEVERITIES = ['debug', 'info', 'warn', 'error', 'critical'];

function parseFilters(req: Request): AuditFilters {
  const q = String(req.query.q || '').trim() || undefined;
  const user_id = String(req.query.user_id || '').trim() || undefined;
  const categoryParam = String(req.query.category || '').trim();
  const category = categoryParam
    ? categoryParam.split(',').map((s) => s.trim()).filter((s) => ALLOWED_CATEGORIES.includes(s))
    : undefined;
  const action = String(req.query.action || '').trim() || undefined;
  const severityParam = String(req.query.severity || '').trim();
  const severity = severityParam
    ? severityParam.split(',').map((s) => s.trim()).filter((s) => ALLOWED_SEVERITIES.includes(s))
    : undefined;
  const from = String(req.query.from || '').trim() || undefined;
  const to = String(req.query.to || '').trim() || undefined;
  let limit = parseInt(String(req.query.limit || '100'), 10);
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(String(req.query.offset || '0'), 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  return { q, user_id, category, action, severity, from, to, limit, offset };
}

function buildWhereClause(f: AuditFilters): { sql: string; params: any[] } {
  const conds: string[] = [];
  const params: any[] = [];
  let i = 0;

  if (f.q) {
    // Free-text search across action + details (jsonb) + ip_address
    // Use ILIKE for action/ip, and ::text cast for jsonb details
    params.push(`%${f.q}%`);
    conds.push(`(a.action ILIKE $${++i} OR a.details::text ILIKE $${i} OR host(a.ip_address) ILIKE $${i})`);
  }
  if (f.user_id) {
    conds.push(`a.user_id = $${++i}`);
    params.push(f.user_id);
  }
  if (f.category && f.category.length > 0) {
    conds.push(`a.category = ANY($${++i}::text[])`);
    params.push(f.category);
  }
  if (f.action) {
    conds.push(`a.action ILIKE $${++i}`);
    params.push(`%${f.action}%`);
  }
  if (f.severity && f.severity.length > 0) {
    conds.push(`a.severity = ANY($${++i}::text[])`);
    params.push(f.severity);
  }
  if (f.from) {
    conds.push(`a.created_at >= $${++i}`);
    params.push(f.from);
  }
  if (f.to) {
    conds.push(`a.created_at <= $${++i}`);
    params.push(f.to);
  }
  const sql = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
  return { sql, params };
}

// =============================================================
//  GET /logs - paginated list
// =============================================================

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const filters = parseFilters(req);
    const where = buildWhereClause(filters);

    // Count for pagination
    const countParams = [...where.params];
    const countSql = `SELECT COUNT(*)::int AS total FROM audit_log a ${where.sql}`;
    const countResult = await query(countSql, countParams);

    // Page
    const pageParams = [...where.params, filters.limit, filters.offset];
    const limitPlaceholder = '$' + (where.params.length + 1);
    const offsetPlaceholder = '$' + (where.params.length + 2);
    const dataSql = `
      SELECT a.id, a.user_id, a.category, a.action, a.ip_address, a.user_agent,
             a.details, a.severity, a.created_at, a.admin_notes, a.admin_notes_by, a.admin_notes_at,
             u.username, u.email
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where.sql}
      ORDER BY a.created_at DESC
      LIMIT ${limitPlaceholder}::int OFFSET ${offsetPlaceholder}::int
    `;
    const dataResult = await query(dataSql, pageParams);

    res.json({
      success: true,
      total: countResult.rows[0].total,
      limit: filters.limit,
      offset: filters.offset,
      filters: {
        q: filters.q,
        user_id: filters.user_id,
        category: filters.category,
        action: filters.action,
        severity: filters.severity,
        from: filters.from,
        to: filters.to,
      },
      logs: dataResult.rows,
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  GET /logs/:id - single log detail
// =============================================================

router.get('/logs/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const r = await query(
      `SELECT a.id, a.user_id, a.category, a.action, a.ip_address, a.user_agent,
              a.details, a.severity, a.created_at, a.admin_notes, a.admin_notes_by, a.admin_notes_at,
              u.username, u.email
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = $1`,
      [id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Audit log not found' });
    }
    res.json({ success: true, log: r.rows[0] });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  POST /logs/:id/notes - admin adds a note (compliance annotation)
// =============================================================

router.post('/logs/:id/notes', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const admin = (req as any).user;
    const note = String(req.body?.note || '').trim();
    if (!note) {
      return res.status(400).json({ success: false, error: 'note required' });
    }
    if (note.length > 2000) {
      return res.status(400).json({ success: false, error: 'note too long (max 2000 chars)' });
    }
    const r = await query(
      `UPDATE audit_log
       SET admin_notes = $1, admin_notes_by = $2, admin_notes_at = NOW()
       WHERE id = $3 RETURNING id, admin_notes, admin_notes_by, admin_notes_at`,
      [note, admin.userId, id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Audit log not found' });
    }
    res.json({ success: true, log: r.rows[0] });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  GET /stats - aggregations
// =============================================================

router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Limit stats to "since" param if provided (default last 7d for dashboard view)
    const since = String(req.query.since || '').trim() ||
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sinceParam = [since];

    // Per-category counts
    const byCategory = await query(
      `SELECT category, COUNT(*)::int AS n FROM audit_log
       WHERE created_at >= $1 GROUP BY category ORDER BY n DESC`,
      sinceParam
    );
    // Per-severity counts
    const bySeverity = await query(
      `SELECT severity, COUNT(*)::int AS n FROM audit_log
       WHERE created_at >= $1 GROUP BY severity ORDER BY n DESC`,
      sinceParam
    );
    // Top actions
    const topActions = await query(
      `SELECT action, COUNT(*)::int AS n FROM audit_log
       WHERE created_at >= $1 GROUP BY action ORDER BY n DESC LIMIT 10`,
      sinceParam
    );
    // Top users (by action count)
    const topUsers = await query(
      `SELECT a.user_id, u.username, u.email, COUNT(*)::int AS n
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.created_at >= $1 AND a.user_id IS NOT NULL
       GROUP BY a.user_id, u.username, u.email ORDER BY n DESC LIMIT 10`,
      sinceParam
    );
    // Timeline (per-day for last 7d)
    const timeline = await query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS n
       FROM audit_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY day ORDER BY day ASC`
    );

    res.json({
      success: true,
      since,
      byCategory: byCategory.rows,
      bySeverity: bySeverity.rows,
      topActions: topActions.rows,
      topUsers: topUsers.rows,
      timeline: timeline.rows,
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  GET /users - distinct users for filter dropdowns
// =============================================================

router.get('/users', async (_req: Request, res: Response) => {
  try {
    const r = await query(
      `SELECT u.id, u.username, u.email, COUNT(*)::int AS log_count, MAX(a.created_at) AS last_log_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id IS NOT NULL
       GROUP BY u.id, u.username, u.email
       ORDER BY log_count DESC LIMIT 200`
    );
    res.json({ success: true, users: r.rows });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// =============================================================
//  GET /export - CSV download
// =============================================================

function csvEscape(val: any): string {
  if (val === null || val === undefined) return '';
  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Escape quotes, wrap in quotes if contains comma/quote/newline
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

router.get('/export', async (req: Request, res: Response) => {
  try {
    const filters = parseFilters(req);
    filters.limit = 10000;  // Hard cap for export
    const where = buildWhereClause(filters);

    const sql = `
      SELECT a.id, a.user_id, u.username, u.email, a.category, a.action, a.severity,
             a.ip_address, a.user_agent, a.details, a.created_at,
             a.admin_notes, a.admin_notes_by, a.admin_notes_at
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ${where.sql}
      ORDER BY a.created_at DESC
      LIMIT $${where.params.length + 1}::int
    `;
    const r = await query(sql, [...where.params, filters.limit]);

    const rows = r.rows as any[];
    const header = ['id', 'created_at', 'user_id', 'username', 'email', 'category', 'action',
                    'severity', 'ip_address', 'user_agent', 'details_json', 'admin_notes',
                    'admin_notes_by', 'admin_notes_at'];

    const lines: string[] = [];
    lines.push(header.join(','));
    for (const row of rows) {
      lines.push([
        csvEscape(row.id),
        csvEscape(row.created_at),
        csvEscape(row.user_id),
        csvEscape(row.username),
        csvEscape(row.email),
        csvEscape(row.category),
        csvEscape(row.action),
        csvEscape(row.severity),
        csvEscape(row.ip_address),
        csvEscape(row.user_agent),
        csvEscape(row.details),
        csvEscape(row.admin_notes),
        csvEscape(row.admin_notes_by),
        csvEscape(row.admin_notes_at),
      ].join(','));
    }

    const csv = lines.join('\n');
    const filename = `audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
