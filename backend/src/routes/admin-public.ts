/**
 * ═══════════════════════════════════════════════════════════════
 *  PUBLIC ADMIN CONFIG — game-math-relevant subset (no auth)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Mounted at `/api/admin/config/public` (in index.ts, BEFORE the
 *  protected /api/admin router — see comment there). This router is
 *  separate from routes/admin.ts because Express router-level
 *  `router.use()` middleware applies to all subsequent routes in that
 *  router — you can't escape it by source-code ordering.
 *
 *  IMPORTANT: Only expose fields that are safe to share publicly.
 *  Do NOT add fields like `maxBet`, `rainBudget`, `adminWallet`, etc.
 *  If you need to expose more fields, audit them against what a logged-
 *  out attacker could learn/use.
 */

import { Router, Request, Response } from 'express';
import { getConfig } from '../services/admin-config';

const router = Router();

// ── GET /api/admin/config/public ──────────────────────────────
// Returns the minimal subset needed by the frontend's win-chance readout.
// No JWT required — used by anonymous + authenticated alike.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    res.json({
      success: true,
      // Currently a single field — add more public-safe fields here if needed.
      houseEdgePercent: config.houseEdgePercent,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;