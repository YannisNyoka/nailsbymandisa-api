import { Router } from 'express';
import { z } from 'zod';
import * as settingsService from '../services/settingsService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/constants.js';
import { WEEKDAYS } from '../models/settings.js';

export const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ settings: await settingsService.getSettings() });
  } catch (err) {
    next(err);
  }
});

const dayHoursSchema = z.object({
  closed: z.boolean(),
  open: z.string().nullable().optional(),
  close: z.string().nullable().optional(),
});

const updateSettingsSchema = z
  .object({
    businessName: z.string().min(1),
    contact: z.object({
      address: z.string(),
      phone: z.string(),
      whatsapp: z.string(),
      email: z.string().email(),
    }),
    socialLinks: z.record(z.string()),
    hours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, dayHoursSchema]))),
    bookingDepositCents: z.number().int().min(0),
    offPeakSurchargeCents: z.number().int().min(0),
    offPeakHours: z.array(z.object({ start: z.string(), end: z.string() })),
    cancellationNoticeHours: z.number().int().min(0),
    rescheduleLockoutHours: z.number().int().min(0),
    lateArrival: z.object({
      graceMinutes: z.number().int().min(0),
      feeCents: z.number().int().min(0),
    }),
    loyalty: z.object({
      pointsPerRand: z.number().int().min(0),
      redemptionCentsPerPoint: z.number().int().min(0),
      minRedemptionPoints: z.number().int().min(0),
      maxRedemptionPercent: z.number().int().min(0).max(100),
      tiers: z.array(z.object({ name: z.string().min(1), minLifetimePoints: z.number().int().min(0) })),
    }),
    referral: z.object({
      referrerBonusPoints: z.number().int().min(0),
      welcomeDiscountPercent: z.number().int().min(0).max(100),
    }),
    heroMedia: z.object({
      url: z.string().url(),
      type: z.enum(['image', 'video']),
    }),
  })
  .partial();

router.patch(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_SETTINGS),
  validate(updateSettingsSchema),
  async (req, res, next) => {
    try {
      res.json({ settings: await settingsService.updateSettings(req.body) });
    } catch (err) {
      next(err);
    }
  }
);
