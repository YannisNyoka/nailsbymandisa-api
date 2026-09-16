import { Router } from 'express';
import { z } from 'zod';
import * as subscriptionPlansService from '../services/subscriptionPlansService.js';
import * as subscriptionsService from '../services/subscriptionsService.js';
import * as paymentsService from '../services/paymentsService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { checkoutLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS, ROLES, PAGINATION } from '../config/constants.js';

export const router = Router();

router.get('/plans', optionalAuthenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === ROLES.ADMIN;
    res.json({ plans: await subscriptionPlansService.listPlans({ includeInactive: isAdmin }) });
  } catch (err) {
    next(err);
  }
});

const planSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  priceCents: z.number().int().positive(),
  creditsPerPeriod: z.number().int().positive(),
  periodDays: z.number().int().positive().default(30),
});

router.post('/plans', authenticate, requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS), validate(planSchema), async (req, res, next) => {
  try {
    res.status(201).json({ plan: await subscriptionPlansService.createPlan(req.body) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/plans/:id',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS),
  validate(planSchema.partial()),
  async (req, res, next) => {
    try {
      res.json({ plan: await subscriptionPlansService.updatePlan(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/plans/:id', authenticate, requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS), async (req, res, next) => {
  try {
    await subscriptionPlansService.deletePlan(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    res.json({ subscription: await subscriptionsService.getUserSubscription(req.user._id) });
  } catch (err) {
    next(err);
  }
});

const subscribeSchema = z.object({ planId: z.string().min(1) });

router.post('/subscribe', authenticate, checkoutLimiter, validate(subscribeSchema), async (req, res, next) => {
  try {
    const payment = await paymentsService.initiateSubscriptionPurchase({ userId: req.user._id, planId: req.body.planId });
    res.status(201).json({ payment });
  } catch (err) {
    next(err);
  }
});

router.post('/cancel', authenticate, async (req, res, next) => {
  try {
    await subscriptionsService.cancelSubscription(req.user._id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/', authenticate, requirePermission(PERMISSIONS.MANAGE_SUBSCRIPTIONS), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await subscriptionsService.listAllSubscriptions(req.query));
  } catch (err) {
    next(err);
  }
});
