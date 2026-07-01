import { Router, Request, Response } from 'express';
import { authMiddleware, AuthPayload } from '../middleware/auth';
import { query } from '../config/database';
import { kycService } from '../services/kyc';
import { validateBody } from '../middleware/validation';
import { verifyAISchema } from '../schemas';

const router = Router();

// Extend Request type locally
export interface AuthRequest extends Request {
  user?: AuthPayload;
}

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
