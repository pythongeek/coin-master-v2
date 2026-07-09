import { Router, Request, Response } from 'express';
import { authMiddleware, roleMiddleware, AuthPayload } from '../middleware/auth';
import { query } from '../config/database';
import { submitKycVerification, getLatestKycSession, listKycSessions, reviewKycSession } from '../services/kyc-session';
import { getKycSettings, setKycApiKey, setKycSettings, KycSettings } from '../services/kyc-settings';
import { validateMiniMaxApiKey } from '../services/minimax-client';
import rateLimit from 'express-rate-limit';

const router = Router();

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

// ═══════════════════════════════════════════════════════════════
//  Rate limiters
// ═══════════════════════════════════════════════════════════════
const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req as AuthRequest).user?.userId || req.ip || 'anonymous',
  handler: (_req, res) => res.status(429).json({ success: false, error: 'Too many KYC attempts. Try again in 1 hour.' }),
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/kyc/status — Current user KYC status
// ═══════════════════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const userResult = await query(
      'SELECT kyc_status, kyc_verified_at FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const session = await getLatestKycSession(userId);
    const settings = await getKycSettings();

    res.json({
      success: true,
      kycStatus: userResult.rows[0].kyc_status,
      verifiedAt: userResult.rows[0].kyc_verified_at,
      provider: settings.provider,
      latestSession: session
        ? {
            id: session.id,
            status: session.status,
            riskScore: session.risk_score,
            riskTier: session.risk_tier,
            finalDecision: session.final_decision,
            documentValid: session.document_valid,
            faceMatch: session.face_match,
            faceSimilarity: session.face_similarity,
            livenessPassed: session.liveness_passed,
            sanctionsClear: session.sanctions_clear,
            extractedFields: session.extracted_fields,
            fraudSignals: session.fraud_signals,
            complianceReasoning: session.compliance_reasoning,
            createdAt: session.created_at,
            completedAt: session.completed_at,
            reviewedAt: session.reviewed_at,
          }
        : null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /api/kyc/verify — Submit document + selfie for verification
// ═══════════════════════════════════════════════════════════════
router.post('/verify', authMiddleware, verifyLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { document, selfie } = req.body;
    if (!document || !selfie || typeof document !== 'string' || typeof selfie !== 'string') {
      return res.status(400).json({ success: false, error: 'document and selfie are required as base64 strings' });
    }

    const result = await submitKycVerification(userId, document, selfie);

    res.json({
      success: true,
      sessionId: result.sessionId,
      status: result.status,
      riskScore: result.riskScore,
      riskTier: result.riskTier,
      decision: result.decision,
      documentValid: result.documentValid,
      faceMatch: result.faceMatch,
      faceSimilarity: result.faceSimilarity,
      livenessPassed: result.livenessPassed,
      sanctionsClear: result.sanctionsClear,
      extractedFields: result.extractedFields,
      fraudSignals: result.fraudSignals,
      complianceReasoning: result.complianceReasoning,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[KYC Route] Verification error for user ${req.user?.userId}:`, msg);
    res.status(500).json({ success: false, error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/kyc/admin/list
router.get('/admin/list', authMiddleware, roleMiddleware(['super_admin', 'support']), async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const offset = (page - 1) * limit;

    const sessions = await listKycSessions(status as any, limit, offset);
    const countResult = await query(
      status
        ? 'SELECT COUNT(*) AS total FROM kyc_sessions WHERE status = $1'
        : 'SELECT COUNT(*) AS total FROM kyc_sessions',
      status ? [status] : []
    );
    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: sessions,
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

// GET /api/kyc/admin/settings
router.get('/admin/settings', authMiddleware, roleMiddleware(['super_admin']), async (_req: Request, res: Response) => {
  try {
    const settings = await getKycSettings();
    res.json({
      success: true,
      settings: {
        provider: settings.provider,
        minimaxApiKeySet: settings.minimaxApiKeySet,
        minimaxModel: settings.minimaxModel,
        minimaxBaseUrl: settings.minimaxBaseUrl,
        requiredForWithdrawal: settings.requiredForWithdrawal,
        requiredForBetAbove: settings.requiredForBetAbove,
        autoApproveThreshold: settings.autoApproveThreshold,
        autoRejectThreshold: settings.autoRejectThreshold,
        maxFileSizeBytes: settings.maxFileSizeBytes,
        allowedExtensions: settings.allowedExtensions,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/kyc/admin/settings
router.post('/admin/settings', authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const {
      provider,
      minimaxModel,
      minimaxBaseUrl,
      requiredForWithdrawal,
      requiredForBetAbove,
      autoApproveThreshold,
      autoRejectThreshold,
      maxFileSizeBytes,
      allowedExtensions,
    } = req.body;

    await setKycSettings({
      provider,
      minimaxModel,
      minimaxBaseUrl,
      requiredForWithdrawal,
      requiredForBetAbove,
      autoApproveThreshold,
      autoRejectThreshold,
      maxFileSizeBytes,
      allowedExtensions,
    });

    res.json({ success: true, message: 'KYC settings updated.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/kyc/admin/api-key — Save or update MiniMax API key
router.post('/admin/api-key', authMiddleware, roleMiddleware(['super_admin']), async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 20) {
      return res.status(400).json({ success: false, error: 'Invalid API key' });
    }

    const isValid = await validateMiniMaxApiKey(apiKey);
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'MiniMax API key validation failed. Check the key.' });
    }

    await setKycApiKey(apiKey);

    res.json({ success: true, message: 'MiniMax API key saved and validated.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/kyc/admin/review/:sessionId
router.post('/admin/review/:sessionId', authMiddleware, roleMiddleware(['super_admin']), async (req: AuthRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { decision, note } = req.body;
    const reviewerId = req.user?.userId;

    if (!reviewerId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ success: false, error: 'Decision must be approved or rejected' });
    }
    const finalDecision: 'approved' | 'rejected' = decision;

    await reviewKycSession(sessionId, reviewerId, finalDecision, note);

    res.json({ success: true, message: `KYC session ${decision}.` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
