import { Router, RequestHandler } from 'express';
import { authMiddleware } from '../middleware/auth';
import { globalLimiter } from '../middleware/rate-limiter';
import * as depositController from '../controllers/deposit.controller';

const router = Router();

router.get('/rate', depositController.getCurrentRate as RequestHandler);

// Webhook for blockchain notifications (public, no auth)
router.post('/webhook/payment', depositController.handlePaymentWebhook as RequestHandler);

// Authenticated routes
router.use(authMiddleware as RequestHandler);
router.use(globalLimiter as RequestHandler);

router.post('/initiate', depositController.initiateDeposit as RequestHandler);
router.get('/history', depositController.getDepositHistory as RequestHandler);
router.get('/:depositId/status', depositController.getDepositStatus as RequestHandler);

export default router;
