import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware, AuthPayload } from '../middleware/auth';
import { query } from '../config/database';
import { kycService } from '../services/kyc';
import { validateBody } from '../middleware/validation';
import { verifyAISchema } from '../schemas';

const router = Router();

// Extend Request type locally
export interface AuthRequest extends Request {
  user?: AuthPayload;
}

// ══════════════════════════════════════════════════════════════
//  GET /api/kyc/admin/list — Super admin: list KYC submissions
//
//  Reads from the kyc_submissions table (joined with users) since
//  the legacy users.kyc_status column does not exist on this DB.
// ══════════════════════════════════════════════════════════════
router.get('/admin/list', authMiddleware, roleMiddleware(['super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const offset = (page - 1) * limit;

    const validStatuses = ['pending', 'approved', 'rejected', 'expired'];
    const useStatusFilter = validStatuses.includes(status);

    let result;
    let countResult: { rows: { total: string }[] };
    if (useStatusFilter) {
      result = await query(
        `SELECT k.id AS submission_id, k.user_id, u.username, u.email,
                k.status, k.document_type AS provider,
                k.reviewed_at, k.submitted_at AS created_at
         FROM kyc_submissions k
         JOIN users u ON u.id = k.user_id
         WHERE k.status = $3
         ORDER BY k.submitted_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset, status]
      );
      countResult = await query(
        `SELECT COUNT(*) AS total FROM kyc_submissions WHERE status = $1`,
        [status]
      );
    } else {
      result = await query(
        `SELECT k.id AS submission_id, k.user_id, u.username, u.email,
                k.status, k.document_type AS provider,
                k.reviewed_at, k.submitted_at AS created_at
         FROM kyc_submissions k
         JOIN users u ON u.id = k.user_id
         ORDER BY k.submitted_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      countResult = await query(
        `SELECT COUNT(*) AS total FROM kyc_submissions`
      );
    }

    const total = parseInt(countResult.rows[0].total);
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/kyc/admin/approve/:userId
//  POST /api/kyc/admin/reject/:userId
//  Super admin: manual KYC decision. Updates the latest pending
//  submission for the user.
// ══════════════════════════════════════════════════════════════
async function decideKyc(req: Request, res: Response, decision: 'approved' | 'rejected') {
  try {
    const self = (req as Request & { user: AuthPayload }).user;
    const { userId } = req.params;

    const result = await query(
      `UPDATE kyc_submissions
         SET status = $1,
             reviewed_at = NOW(),
             reviewer_id = $2,
             rejection_reason = CASE WHEN $1 = 'rejected' THEN COALESCE(rejection_reason, 'Manually rejected by admin') ELSE rejection_reason END
       WHERE id = (
         SELECT id FROM kyc_submissions
         WHERE user_id = $3 AND status = 'pending'
         ORDER BY submitted_at DESC LIMIT 1
       )
       RETURNING id, status, reviewed_at`,
      [decision, self.userId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'No pending submission found for this user.' });
    }

    // Also stamp the users.kyc_verified_at for fast status checks
    await query(
      `UPDATE users
         SET kyc_verified_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE kyc_verified_at END
       WHERE id = $2`,
      [decision, userId]
    );

    res.json({ success: true, kyc: result.rows[0], message: `KYC ${decision}.` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
}

router.post('/admin/approve/:userId', authMiddleware, roleMiddleware(['super_admin']), (req, res) => decideKyc(req, res, 'approved'));
router.post('/admin/reject/:userId',  authMiddleware, roleMiddleware(['super_admin']), (req, res) => decideKyc(req, res, 'rejected'));

/**
 * Handler for GET /api/kyc/status
 */
export async function getStatus(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const result = await query(
      'SELECT kyc_status, kyc_verified_at, kyc_applicant_id FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      kycStatus: user.kyc_status,
      verifiedAt: user.kyc_verified_at,
      applicantId: user.kyc_applicant_id,
      mockMode: kycService.isMockMode(),
      aiMockMode: kycService.isAIMockMode(),
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
}

/**
 * Handler for POST /api/kyc/token
 */
export async function postToken(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const userResult = await query(
      'SELECT email, username, kyc_applicant_id, kyc_status FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = userResult.rows[0];
    let applicantId = user.kyc_applicant_id;

    if (!applicantId) {
      const email = user.email || `${user.username}@mockmail.com`;
      const applicantData = await kycService.createApplicant(userId, email);
      applicantId = applicantData.applicantId;

      await query(
        'UPDATE users SET kyc_applicant_id = $1, kyc_status = $2 WHERE id = $3',
        [applicantId, 'pending', userId]
      );
    }

    const token = await kycService.getAccessToken(userId);

    res.json({
      success: true,
      token,
      userId,
      applicantId,
      mockMode: kycService.isMockMode(),
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
}

/**
 * Handler for POST /api/kyc/verify-ai
 * AI-powered multimodal KYC verification
 */
export async function postVerifyAI(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { document, selfie } = req.body;

    console.log(`[KYC Route] Initiating AI verification for user: ${userId}`);
    const result = await kycService.verifyIdentityAI(userId, document, selfie);

    const applicantId = `ai_${userId}`;

    if (result.verified) {
      await query(
        "UPDATE users SET kyc_status = 'verified', kyc_verified_at = NOW(), kyc_applicant_id = $1 WHERE id = $2",
        [applicantId, userId]
      );
      console.log(`[KYC Route] AI verification SUCCESS for user: ${userId}`);
    } else {
      await query(
        "UPDATE users SET kyc_status = 'rejected', kyc_applicant_id = $1 WHERE id = $2",
        [applicantId, userId]
      );
      console.log(`[KYC Route] AI verification REJECTED for user: ${userId}. Reason: ${result.reason}`);
    }

    res.json({
      success: true,
      verified: result.verified,
      confidence: result.confidence,
      reason: result.reason,
      documentInfo: result.documentInfo,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[KYC Route] AI verification error for user: ${req.user?.userId}:`, errorMsg);
    res.status(500).json({ success: false, error: errorMsg });
  }
}

/**
 * Handler for POST /api/kyc/webhook
 */
export async function postWebhook(req: Request, res: Response) {
  try {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-payload-digest'] as string || '';

    const isValid = kycService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }

    const payload = req.body;
    const { applicantId, externalUserId, reviewStatus, reviewResult } = payload;

    if (!externalUserId) {
      return res.status(400).json({ success: false, error: 'Missing externalUserId' });
    }

    if (reviewStatus === 'completed') {
      const answer = reviewResult?.reviewAnswer;
      if (answer === 'GREEN') {
        await query(
          "UPDATE users SET kyc_status = 'verified', kyc_verified_at = NOW() WHERE id = $1",
          [externalUserId]
        );
      } else if (answer === 'RED') {
        await query(
          "UPDATE users SET kyc_status = 'rejected' WHERE id = $1",
          [externalUserId]
        );
      }
    } else if (reviewStatus === 'initiate') {
      await query(
        "UPDATE users SET kyc_status = 'pending' WHERE id = $1",
        [externalUserId]
      );
    }

    res.json({ success: true });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
}

/**
 * Handler for POST /api/kyc/simulate-success
 */
export async function postSimulateSuccess(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!kycService.isMockMode()) {
      return res.status(403).json({
        success: false,
        error: 'Simulation is disabled when production Sumsub credentials are configured.',
      });
    }

    await query(
      "UPDATE users SET kyc_status = 'verified', kyc_verified_at = NOW(), kyc_applicant_id = COALESCE(kyc_applicant_id, $1) WHERE id = $2",
      [`mock_applicant_${userId}`, userId]
    );

    res.json({
      success: true,
      message: 'Simulated verification completed successfully! KYC status is now verified.',
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
}

// Router registrations
router.get('/status', authMiddleware, getStatus);
router.post('/token', authMiddleware, postToken);
router.post('/verify-ai', authMiddleware, validateBody(verifyAISchema), postVerifyAI);
router.post('/webhook', postWebhook);
router.post('/simulate-success', authMiddleware, postSimulateSuccess);

export default router;
