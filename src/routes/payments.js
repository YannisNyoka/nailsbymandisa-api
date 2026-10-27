import crypto from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import * as paymentsService from '../services/paymentsService.js';
import { verifyWebhookSignature } from '../config/yocoClient.js';
import { paymentsCollection } from '../models/payments.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { checkoutLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS, PAGINATION } from '../config/constants.js';
import { env } from '../config/env.js';

export const router = Router();

const checkoutSchema = z.object({
  pointsToRedeem: z.number().int().min(0).optional(),
  discountCode: z.string().min(1).max(20).optional(),
  giftCardCode: z.string().min(1).max(20).optional(),
});

router.post(
  '/appointments/:appointmentId/checkout',
  optionalAuthenticate,
  checkoutLimiter,
  validate(checkoutSchema),
  async (req, res, next) => {
    try {
      const payment = await paymentsService.initiateBookingDepositPayment({
        appointmentId: req.params.appointmentId,
        actor: req.user ?? null,
        pointsToRedeem: req.body.pointsToRedeem,
        discountCode: req.body.discountCode,
        giftCardCode: req.body.giftCardCode,
      });
      res.status(201).json({ payment });
    } catch (err) {
      next(err);
    }
  }
);

// Yoco's raw request body (before JSON parsing) is required to verify the HMAC
// signature — app.js already skips the global express.json() for this exact path.
// §4.4/§5.2 — signature verification fails closed: no secret, no bypass, ever.
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res, next) => {
  try {
    const rawBody = req.body.toString('utf8');
    const valid = verifyWebhookSignature({
      webhookId: req.headers['webhook-id'],
      webhookTimestamp: req.headers['webhook-timestamp'],
      webhookSignature: req.headers['webhook-signature'],
      rawBody,
    });
    if (!valid) {
      // TEMPORARY diagnostic (remove once the mismatch is found) — never logs the secret
      // itself, only its length and a truncated SHA-256 fingerprint (safe to compare
      // against the same fingerprint computed locally for the known-correct value), plus
      // the full raw body (base64, so it round-trips exactly) and the locally-recomputed
      // expected signature — lets a specific failure be byte-for-byte diffed afterwards,
      // which headers-only logging can't do. Wrapped defensively: this is diagnostic-only
      // and must never be able to turn a clean 401 into a 500 (e.g. a malformed secret in
      // a non-production environment, or a request missing headers this assumes exist).
      try {
        const secretBytes = Buffer.from(env.YOCO_WEBHOOK_SECRET.split('_')[1], 'base64');
        const signedContent = `${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${rawBody}`;
        const expectedSignature = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
        req.log?.warn(
          {
            secretLength: env.YOCO_WEBHOOK_SECRET.length,
            secretFingerprint: crypto.createHash('sha256').update(env.YOCO_WEBHOOK_SECRET).digest('hex').slice(0, 12),
            receivedSignatureHeader: req.headers['webhook-signature'],
            expectedSignature: `v1,${expectedSignature}`,
            contentLengthHeader: req.headers['content-length'],
            actualBodyByteLength: req.body.length,
            rawBodyBase64: rawBody ? Buffer.from(rawBody, 'utf8').toString('base64') : null,
          },
          'Rejected Yoco webhook with invalid signature'
        );
      } catch (diagnosticErr) {
        req.log?.warn({ err: diagnosticErr }, 'Rejected Yoco webhook with invalid signature (diagnostic logging itself failed)');
      }
      return res.status(401).json({ error: { message: 'Invalid webhook signature.' } });
    }

    const event = JSON.parse(rawBody);
    const paymentId = event.payload?.metadata?.paymentId;

    switch (event.type) {
      case 'payment.succeeded':
        if (paymentId) await paymentsService.handlePaymentSucceeded({ paymentId, yocoPaymentId: event.payload.id });
        break;
      case 'payment.failed':
        if (paymentId) await paymentsService.handlePaymentFailed({ paymentId });
        break;
      default:
        req.log?.info({ type: event.type }, 'Unhandled Yoco webhook event type');
    }

    // Always 200 once the signature checks out and we've handled (or deliberately
    // ignored) the event — Yoco retries on non-2xx, and retrying an already-handled
    // event is safe (handlePaymentSucceeded/Failed are idempotent) but pointless.
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  status: z.string().optional(),
});

router.get('/', authenticate, requirePermission(PERMISSIONS.MANAGE_PAYMENTS), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { page, pageSize, status } = req.query;
    const filter = status ? { status } : {};
    const all = await (await paymentsCollection().find(filter)).toArray();
    const start = (page - 1) * pageSize;
    res.json({ payments: all.slice(start, start + pageSize), total: all.length, page, pageSize });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const payment = await paymentsService.getPayment(req.params.id);
    paymentsService.assertPaymentAccess(payment, req.user);
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

const refundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(500).nullable().optional(),
});

router.post(
  '/:id/refund',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_PAYMENTS),
  validate(refundSchema),
  async (req, res, next) => {
    try {
      const payment = await paymentsService.refundPayment({
        paymentId: req.params.id,
        amountCents: req.body.amountCents,
        reason: req.body.reason,
        actor: req.user,
      });
      res.json({ payment });
    } catch (err) {
      next(err);
    }
  }
);
