import { Router } from 'express';
import { initiateStkPush, mpesaCallback } from '../controllers/payment.controller';
import { authenticateJWT } from '../middlewares/auth.middleware';
const router = Router();
router.post('/stk-push', authenticateJWT, initiateStkPush);
router.post('/mpesa-callback', mpesaCallback);
export default router;
