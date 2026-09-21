import crypto from 'node:crypto';
import { Router } from 'express';
import * as remindersService from '../services/remindersService.js';
import * as bookingService from '../services/bookingService.js';
import { env } from '../config/env.js';
import { unauthorized } from '../utils/AppError.js';
import { cronLimiter } from '../middleware/rateLimit.js';

export const router = Router();

// Authenticates a scheduled job (.github/workflows/reminders.yml), not a person — a
// shared secret in a header, timing-safe compared, same pattern as the Yoco webhook
// signature check (config/yocoClient.js). Deliberately outside the admin JWT/permission
// system: there's no logged-in user driving this, just an external cron call.
function requireCronSecret(req, res, next) {
  const provided = req.headers['x-cron-secret'];
  if (typeof provided !== 'string') return next(unauthorized());
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(env.CRON_SECRET);
  const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!valid) return next(unauthorized());
  next();
}

router.post('/reminders', cronLimiter, requireCronSecret, async (req, res, next) => {
  try {
    res.json(await remindersService.sendDueReminders());
  } catch (err) {
    next(err);
  }
});

// A pending_payment appointment never blocks its slot for anyone else — this is pure
// hygiene, formally cancelling abandoned never-paid appointments so they stop showing up
// as "awaiting payment" in the customer's and admin's booking lists.
router.post('/expire-unpaid-appointments', cronLimiter, requireCronSecret, async (req, res, next) => {
  try {
    res.json(await bookingService.expireDueUnpaidAppointments());
  } catch (err) {
    next(err);
  }
});
