import crypto from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import * as paymentsService from '../services/paymentsService.js';
import { verifyAndParseWebhook, WebhookVerificationError } from '../config/yocoClient.js';
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

const recordCashSchema = z.object({ amount: z.enum(['deposit', 'full']) });

// Admin-only cash/in-person payment recording — e.g. a walk-in, or a booking the admin
// made on a client's behalf who pays on the spot, neither of which goes through Yoco at
// all. Same authenticate-only + actor.role==='admin' pattern as the other admin
// appointment actions (reschedule/cancel/complete in routes/appointments.js), not a
// dedicated permission check.
router.post(
  '/appointments/:appointmentId/record-cash',
  authenticate,
  validate(recordCashSchema),
  async (req, res, next) => {
    try {
      await paymentsService.recordManualPayment({
        appointmentId: req.params.appointmentId,
        amount: req.body.amount,
        actor: req.user,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// Yoco's success redirect lands here first, not straight on the frontend (see
// paymentsService.js's API_BASE_URL/successUrl) — this runs the same Yoco-backed
// reconciliation the confirmation page itself polls, but synchronously, before the
// customer's browser has a page to navigate away from. Never blocks the redirect: if
// the reconcile fails for any reason, the frontend's own poll (and the cron sweep) still
// cover it. No auth — same as the confirmation page itself, since guests use this too
// and the appointment ID isn't guessable ahead of a real checkout.
router.get('/redirect/:appointmentId', checkoutLimiter, async (req, res) => {
  try {
    await paymentsService.reconcilePendingPayment({ appointmentId: req.params.appointmentId });
  } catch (err) {
    req.log?.warn({ err }, 'Reconcile-on-redirect failed; confirmation page poll will retry');
  }
  res.redirect(302, `${env.CLIENT_URL}/booking/confirmation?appointmentId=${req.params.appointmentId}`);
});

// Yoco's raw request body (before JSON parsing) is required to verify the HMAC
// signature — app.js already skips the global express.json() for this exact path.
// §4.4/§5.2 — signature verification fails closed: no secret, no bypass, ever.
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res, next) => {
  try {
    const rawBody = req.body.toString('utf8');
    let event;
    try {
      event = verifyAndParseWebhook({ headers: req.headers, rawBody });
    } catch (err) {
      if (!(err instanceof WebhookVerificationError)) throw err;
      // TEMPORARY diagnostic (remove once the mismatch is found) — `err.message` now
      // gives the *specific* rejection reason (missing headers / stale or future
      // timestamp / no matching signature), which is far more useful than the old
      // hand-rolled check's bare true/false. Also logs the secret's length and a
      // truncated SHA-256 fingerprint (safe — never the secret itself) plus the full raw
      // body (base64, round-trips exactly) so a "no matching signature" failure can be
      // byte-for-byte diffed afterwards. Wrapped defensively: diagnostic-only, must never
      // turn a clean 401 into a 500.
      try {
        req.log?.warn(
          {
            reason: err.message,
            secretLength: env.YOCO_WEBHOOK_SECRET.length,
            secretFingerprint: crypto.createHash('sha256').update(env.YOCO_WEBHOOK_SECRET).digest('hex').slice(0, 12),
            receivedSignatureHeader: req.headers['webhook-signature'],
            receivedTimestampHeader: req.headers['webhook-timestamp'],
            serverUnixTime: Math.floor(Date.now() / 1000),
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
