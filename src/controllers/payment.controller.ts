import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/env';

const prisma = new PrismaClient();

const getDarajaToken = async (): Promise<string> => {
  const credentials = Buffer.from(`${ENV.MPESA.CONSUMER_KEY}:${ENV.MPESA.CONSUMER_SECRET}`).toString('base64');
  const response = await fetch('https://safaricom.co.ke', {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` }
  });

  if (!response.ok) throw new Error('M-Pesa auth token generation failed.');
  const data = await response.json();
  return data.access_token;
};

export const initiateStkPush = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { phoneNumber, amount } = req.body;

    if (!phoneNumber || !amount) {
      res.status(400).json({ error: 'Phone number and amount are required.' });
      return;
    }

    const formattedPhone = phoneNumber.startsWith('0') ? `254${phoneNumber.slice(1)}` : phoneNumber.replace('+', '');
    const token = await getDarajaToken();
    const timestamp = new Date().toISOString().replace(/[-T:Z.]/g, '').slice(0, 14);
    const password = Buffer.from(`${ENV.MPESA.SHORTCODE}${ENV.MPESA.PASSKEY}${timestamp}`).toString('base64');
    const callbackUrl = `https://yourdomain.com`;

    const payload = {
      BusinessShortCode: ENV.MPESA.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: ENV.MPESA.SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: 'PesaMatrix VIP',
      TransactionDesc: 'SaaS Subscription CopyTrading Activation'
    };

    const response = await fetch('https://safaricom.co.ke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.ResponseCode === '0') {
      await prisma.payment.create({
        data: {
          userId,
          amount: parseFloat(amount),
          phoneNumber: formattedPhone,
          status: 'PENDING',
          merchantRequestID: data.MerchantRequestID,
          checkoutRequestID: data.CheckoutRequestID
        }
      });

      res.status(200).json({ message: 'STK Push initiated successfully on user device.', checkoutRequestId: data.CheckoutRequestID });
    } else {
      res.status(400).json({ error: data.ResponseDescription || 'STK Push deployment failed.' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const mpesaCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    const { Body } = req.body;
    if (!Body || !Body.stkCallback) {
      res.status(400).json({ error: 'Invalid callback payload structure.' });
      return;
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;
    const trackingPayment = await prisma.payment.findFirst({
      where: { merchantRequestID: MerchantRequestID, checkoutRequestID: CheckoutRequestID }
    });

    if (!trackingPayment) {
      res.status(404).json({ error: 'Matching payment token reference not found.' });
      return;
    }

    if (ResultCode === 0 && CallbackMetadata) {
      const items = CallbackMetadata.Item;
      const mpesaReceiptItem = items.find((i: any) => i.Name === 'MpesaReceiptNumber');
      const mpesaReceipt = mpesaReceiptItem ? mpesaReceiptItem.Value : `SYS_GEN_${Date.now()}`;

      await prisma.payment.update({
        where: { id: trackingPayment.id },
        data: { status: 'COMPLETED', mpesaReceipt }
      });

      const futureExpiry = new Date();
      futureExpiry.setDate(futureExpiry.getDate() + 30);

      await prisma.user.update({
        where: { id: trackingPayment.userId },
        data: { subscriptionStatus: true, subscriptionExpiry: futureExpiry }
      });
    } else {
      await prisma.payment.update({
        where: { id: trackingPayment.id },
        data: { status: `FAILED: ${ResultDesc}` }
      });
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
