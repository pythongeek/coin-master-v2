/**
 * ═══════════════════════════════════════════════════════════════
 *  PUBLIC ADMIN CONFIG — game-math-relevant subset (no auth)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Mounted at `/api/public` (in index.ts). Until P1-10 there was also a
 *  duplicate mount at `/api/admin/config`; that was removed because it
 *  shadowed admin paths under the same prefix and bypassed the
 *  gateway-token isolation in middleware.ts. This router is separate
 *  from routes/admin.ts because Express router-level `router.use()`
 *  middleware applies to all subsequent routes in that router —
 *  you can't escape it by source-code ordering.
 *
 *  IMPORTANT: Only expose fields that are safe to share publicly.
 *  Do NOT add fields like `maxBet`, `rainBudget`, `adminWallet`, etc.
 *  If you need to expose more fields, audit them against what a logged-
 *  out attacker could learn/use.
 */

import { Router, Request, Response } from 'express';
import { getConfig } from '../services/admin-config';
import { query } from '../config/database';

const router = Router();

// ── GET /api/admin/config/public ──────────────────────────────────────
// Returns the minimal subset needed by the frontend's win-chance readout.
// No JWT required — used by anonymous + authenticated alike.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    res.json({
      success: true,
      houseEdgePercent: config.houseEdgePercent,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/admin/config/public/banner ───────────────────────────────
// Public announcement / maintenance banner.
router.get('/banner', async (_req: Request, res: Response) => {
  try {
    const result = await query("SELECT value FROM admin_settings WHERE key = 'global_banner'");
    const banner = result.rows[0]?.value
      ? JSON.parse(result.rows[0].value)
      : { enabled: false, type: 'info', message: '', dismissible: true };
    res.json({ success: true, banner });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;